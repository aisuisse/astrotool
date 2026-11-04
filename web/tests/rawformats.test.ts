import { describe, expect, it } from "vitest";
import { existsSync, openAsBlob, readdirSync } from "node:fs";
import { decodeRawData, decodeSamsung1, decodeSonyLossy, sonyCurve, unpackBits } from "../src/engine/rawdata";
import { SerColor } from "../src/engine/ser";

/** Werte dicht packen, höchstes Bit zuerst (Gegenstück zu unpackBits) */
function pack(vals: number[], bps: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((vals.length * bps) / 8));
  let bit = 0;
  for (const v of vals)
    for (let k = bps - 1; k >= 0; k--, bit++) if ((v >> k) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
  return out;
}

/** Bitschreiber: höchstes Bit zuerst in 32-bit-Wörter, die Little Endian abgelegt werden (Samsung) */
class WordWriter {
  words: number[] = [];
  private cur = 0;
  private n = 0;
  put(v: number, bits: number) {
    for (let k = bits - 1; k >= 0; k--) {
      this.cur = (this.cur * 2 + ((v >> k) & 1)) >>> 0;
      if (++this.n === 32) { this.words.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  flush() { if (this.n) { this.words.push((this.cur * 2 ** (32 - this.n)) >>> 0); this.cur = 0; this.n = 0; } }
  bytes(): Uint8Array { const b = new Uint8Array(this.words.length * 4); const v = new DataView(b.buffer); this.words.forEach((w, i) => v.setUint32(i * 4, w, true)); return b; }
}

describe("Gepackte Rohdaten", () => {
  it("12 bit Byte für Byte und 14 bit in 32-bit-Wörtern", () => {
    const v12 = Array.from({ length: 6 * 3 }, (_, i) => (i * 977) & 4095);
    expect(Array.from(unpackBits(pack(v12, 12), 6, 3, 12, 9))).toEqual(v12);
    const v14 = Array.from({ length: 16 * 2 }, (_, i) => (i * 3001 + 7) & 16383);
    const p = pack(v14, 14); // 28 Byte je Zeile
    const swapped = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i += 4) swapped.set(p.subarray(i, i + 4).reverse(), i); // 32-bit-Wörter Little Endian
    expect(Array.from(unpackBits(swapped, 16, 2, 14, 28, true))).toEqual(v14);
  });
});

describe("Sony ARW verlustbehaftet", () => {
  it("Kennlinie: Steigung 1 bis zum ersten Knick, dann 2, 4, 8, 16", () => {
    const c = sonyCurve([8000, 10400, 12900, 14100]);
    expect(c[2000]).toBe(2000);
    expect(c[2001] - c[2000]).toBe(2);
    expect(c[2601] - c[2600]).toBe(4);
    expect(c[4095] - c[4094]).toBe(16);
  });

  it("Blöcke zu 16 Pixeln: Höchst-/Tiefstwert, 7-bit-Abstände, gerade und ungerade Spalten", async () => {
    const w = 64, h = 2;
    // gewünschte 11-bit-Werte; Spannen so gewählt, dass verschiedene Verschiebungen vorkommen
    const want = Array.from({ length: w * h }, (_, i) => 300 + ((i * 37) % (i % 3 === 0 ? 100 : 900)));
    const data = new Uint8Array(w * h);
    const expected = new Uint16Array(w * h);
    for (let row = 0; row < h; row++)
      for (let blk = 0; blk < w / 16; blk++) {
        const col0 = (blk >> 1) * 32 + (blk & 1);
        const vals = Array.from({ length: 16 }, (_, i) => want[row * w + col0 + 2 * i]);
        const max = Math.max(...vals), min = Math.min(...vals);
        const imax = vals.indexOf(max), imin = vals.lastIndexOf(min) === imax ? vals.indexOf(min) : vals.lastIndexOf(min);
        let sh = 0;
        while (sh < 4 && 0x80 << sh <= max - min) sh++;
        // 128 Bit, niedrigste zuerst
        let big = BigInt(max) | (BigInt(min) << 11n) | (BigInt(imax) << 22n) | (BigInt(imin) << 26n);
        let bit = 30n;
        const rec: number[] = [];
        for (let i = 0; i < 16; i++) {
          if (i === imax) rec.push(max);
          else if (i === imin) rec.push(min);
          else {
            const d = Math.min(127, (vals[i] - min) >> sh);
            big |= BigInt(d) << bit;
            bit += 7n;
            rec.push(Math.min(0x7ff, (d << sh) + min));
          }
        }
        for (let k = 0; k < 16; k++) data[row * w + blk * 16 + k] = Number((big >> BigInt(8 * k)) & 0xffn);
        rec.forEach((v, i) => (expected[row * w + col0 + 2 * i] = v));
      }
    const curve = sonyCurve([8000, 10400, 12900, 14100]);
    const s = await decodeSonyLossy(new Blob([data]), new Map([[0x111, [0]], [0x7010, [8000, 10400, 12900, 14100]]]), w, h);
    expect(Array.from(s.data)).toEqual(Array.from(expected, (v) => curve[v << 1]));
  });
});

describe("Samsung SRW mit Zeilentabelle (NX300-Familie)", () => {
  it("Vorhersage von links und von oben, Bitlängen je Gruppe, Tausch im 2×2-Feld", async () => {
    const w = 32, h = 4;
    const final = Array.from({ length: w * h }, (_, i) => 100 + ((i * 53) % 700));
    // vor dem Tausch (der Tausch ist seine eigene Umkehrung)
    const pre = final.slice();
    for (let r = 0; r + 1 < h; r += 2)
      for (let c = 0; c + 1 < w; c += 2) { const a = r * w + c + 1, b = (r + 1) * w + c; [pre[a], pre[b]] = [pre[b], pre[a]]; }
    const rows: Uint8Array[] = [];
    for (let row = 0; row < h; row++) {
      const ww = new WordWriter();
      for (let col = 0; col < w; col += 16) {
        const dir = row >= 2 && col === 16 ? 1 : 0; // einmal auch von oben
        ww.put(dir, 1);
        for (let g = 0; g < 4; g++) ww.put(col === 0 ? 3 : 0, 2);
        if (col === 0) for (let g = 0; g < 4; g++) ww.put(12, 4); // Bitlänge 12 für alle Gruppen
        for (let k = 0; k < 16; k++) {
          const c = k < 8 ? 2 * k : 2 * (k - 8) + 1;
          const pred = dir ? pre[(row - (c & 1 ? 2 : 1)) * w + col + c] : col ? pre[row * w + col - (c & 1 ? 1 : 2)] : 128;
          const d = pre[row * w + col + c] - pred;
          ww.put(d < 0 ? d + 4096 : d, 12);
        }
      }
      ww.flush();
      rows.push(ww.bytes());
    }
    const table = new Uint8Array(h * 4), tv = new DataView(table.buffer);
    let off = 0;
    rows.forEach((r, i) => { tv.setUint32(i * 4, off, true); off += r.length; });
    const body = new Uint8Array(off);
    off = 0;
    for (const r of rows) { body.set(r, off); off += r.length; }
    const file = new Blob([table, body]);
    const s = await decodeSamsung1(file, new Map([[0xa010, [0]], [0x111, [table.length]], [0x117, [body.length]]]), w, h);
    expect(Array.from(s.data)).toEqual(final);
  });
});

// CC0-Muster von raw.pixls.us, nur lokal (web/.testdata/raw)
const RAW = ".testdata/raw";
const sample = (dir: string) => `${RAW}/${dir}/${readdirSync(`${RAW}/${dir}`)[0]}`;
describe.skipIf(!existsSync(`${RAW}/arw-lossy`))("Weitere RAW-Formate (lokale Testdateien)", () => {
  const cases: [string, string, number, number, number][] = [
    ["arw-lossy", "ARW compressed", 6000, 4000, SerColor.BAYER_RGGB], // Sony A7 III
    ["srw-nx300", "SRW compressed", 5472, 3648, SerColor.BAYER_GRBG], // Samsung NX300, Grösse = Kamerabild
    ["srw-nx100", "SRW packed", 4614, 3070, SerColor.BAYER_BGGR], // Samsung NX100
    ["raf-bayer", "RAF uncompressed (Bayer)", 6000, 4000, SerColor.BAYER_RGGB], // Fujifilm X-A5
  ];
  for (const [dir, fmt, w, h, cfa] of cases)
    it.skipIf(!existsSync(`${RAW}/${dir}`))(`${dir}: Format, Grösse, Farbmuster, Helligkeit`, async () => {
      const r = (await decodeRawData(await openAsBlob(sample(dir))))!;
      expect([r.info.format, r.frame.width, r.frame.height, r.frame.colorId]).toEqual([fmt, w, h, cfa]);
      // Tageslichtaufnahmen: Median deutlich über Schwarz, nicht übersteuert
      const v: number[] = [];
      for (let i = 0; i < r.frame.data.length; i += 997) v.push(r.frame.data[i]);
      v.sort((a, b) => a - b);
      expect(v[v.length >> 1]).toBeGreaterThan(1000);
      expect(v[v.length >> 1]).toBeLessThan(60000);
    }, 60_000);
});
