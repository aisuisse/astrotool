import { describe, expect, it } from "vitest";
import { existsSync, openAsBlob, readdirSync } from "node:fs";
import jpeg from "jpeg-js";
import { decodeRawData, demosaicXTrans, rawUnsupported } from "../src/engine/rawdata";
import { rawPreview } from "../src/engine/raw";
import { SerColor } from "../src/engine/ser";

// X-Trans-Muster einer X-T4 ab Sensorpunkt (0,0); 0 R, 1 G, 2 B
const XT = "GGRGGB GGBGGR BRGRBG GGBGGR GGRGGB RBGBRG".replace(/ /g, "").split("").map((c) => "RGB".indexOf(c));

/** glattes Testbild: Verläufe in allen drei Farben */
const scene = (x: number, y: number, w: number, h: number) => [
  8000 + 40000 * (x / w), 12000 + 30000 * (y / h), 30000 - 20000 * (x / w) * (y / h),
];

/** Mosaik aus einem RGB-Bild nach dem Muster (Ursprung ox, oy) */
function mosaic(w: number, h: number, ox: number, oy: number): Uint16Array {
  const m = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = Math.round(scene(x, y, w, h)[XT[((y + oy) % 6) * 6 + ((x + ox) % 6)]]);
  return m;
}

/** unkomprimiertes DNG (little endian) mit X-Trans-Muster, ActiveArea und Schwarz/Weiss */
function xtransDng(w: number, h: number, aaTop: number, aaLeft: number): Blob {
  // Muster im DNG gilt ab ActiveArea; Sensordaten ab Sensorpunkt (0,0) → Muster entsprechend verschoben
  const pat = Array.from({ length: 36 }, (_, k) => XT[((Math.floor(k / 6) + aaTop) % 6) * 6 + (((k % 6) + aaLeft) % 6)]);
  const black = 512, white = 16383;
  const m = mosaic(w, h, 0, 0); // Muster ab Sensorpunkt (0,0)
  const raw = new Uint16Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = black + Math.round((m[i] / 65535) * (white - black));
  const entries: [number, number, number[]][] = [
    [0x0fe, 4, [0]], [0x100, 4, [w]], [0x101, 4, [h]], [0x102, 3, [16]], [0x103, 3, [1]], [0x106, 3, [32803]],
    [0x111, 4, [0]], [0x115, 3, [1]], [0x116, 4, [h]], [0x117, 4, [w * h * 2]],
    [0x828d, 3, [6, 6]], [0x828e, 1, pat], [0xc61a, 4, [black]], [0xc61d, 4, [white]],
    [0xc68d, 4, [aaTop, aaLeft, h, w]],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extraOff = 8 + ifdSize;
  const extra: number[] = [];
  const out = new DataView(new ArrayBuffer(extraOff + 256 + raw.byteLength));
  out.setUint16(0, 0x4949); out.setUint16(2, 42, true); out.setUint32(4, 8, true);
  out.setUint16(8, entries.length, true);
  const dataOff = extraOff + 256;
  entries.forEach(([tag, type, vals], k) => {
    const e = 10 + k * 12, size = type === 3 ? 2 : type === 1 ? 1 : 4;
    out.setUint16(e, tag, true); out.setUint16(e + 2, type, true); out.setUint32(e + 4, vals.length, true);
    const put = (o: number, v: number) => (size === 1 ? out.setUint8(o, v) : size === 2 ? out.setUint16(o, v, true) : out.setUint32(o, v, true));
    const vv = tag === 0x111 ? [dataOff] : vals;
    if (vv.length * size <= 4) vv.forEach((v, i) => put(e + 8 + i * size, v));
    else {
      const o = extraOff + extra.length;
      out.setUint32(e + 8, o, true);
      vv.forEach((v, i) => put(o + i * size, v));
      for (let i = 0; i < vv.length * size; i++) extra.push(0);
    }
  });
  new Uint16Array(out.buffer, dataOff).set(raw);
  return new Blob([out.buffer]);
}

describe("X-Trans", () => {
  it("Farbrekonstruktion: glatter Verlauf wird fast exakt wiederhergestellt (alle Musterlagen)", () => {
    const w = 60, h = 48;
    for (const [ox, oy] of [[0, 0], [1, 4], [5, 3]]) {
      const rgb = demosaicXTrans(mosaic(w, h, ox, oy), w, h, XT, ox, oy);
      let worst = 0;
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const s = scene(x, y, w, h);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rgb[(y * w + x) * 3 + c] - s[c]));
        }
      expect(worst).toBeLessThan(700); // ≈ 1 % – lineare Verläufe, nur die Krümmung des Blaukanals bleibt
    }
  });

  it("DNG mit X-Trans-Muster (Ursprung am ActiveArea): RGB, Schwarz/Weiss normiert, Farben richtig", async () => {
    const w = 96, h = 72, aaTop = 3, aaLeft = 4;
    const r = (await decodeRawData(xtransDng(w, h, aaTop, aaLeft)))!;
    expect(r).not.toBeNull();
    expect(r.frame).toMatchObject({ width: w - aaLeft, height: h - aaTop, planes: 3, colorId: SerColor.RGB, bitDepth: 16 });
    // Bildmitte: Farben wie die Szene (gleiche Sensorstelle)
    const x = 40, y = 30, s = scene(x + aaLeft, y + aaTop, w, h);
    for (let c = 0; c < 3; c++) expect(Math.abs(r.frame.data[(y * r.frame.width + x) * 3 + c] - s[c])).toBeLessThan(900);
  });
});

// Echte Dateien (nur lokal, siehe docs/testdaten.md)
const RAW = ".testdata/raw";
const UNC = `${RAW}/raf-unc/DSCF0266.RAF`;
describe("Fujifilm RAF (lokale Testdateien)", () => {
  it.skipIf(!existsSync(UNC))("unkomprimierte X-T4: Grösse, Weissabgleich der Kamera, Farben wie das Kamerabild", async () => {
    const b = await openAsBlob(UNC);
    const r = (await decodeRawData(b))!;
    expect([r.info.format, r.frame.width, r.frame.height, r.frame.planes, r.frame.colorId]).toEqual(["RAF uncompressed", 6240, 4160, 3, SerColor.RGB]);
    expect(r.info.cameraWb?.[0]).toBeCloseTo(578 / 302, 3);
    expect(r.info.cameraWb?.[2]).toBeCloseTo(661 / 302, 3);
    // mit Weissabgleich der Kamera: Farbanteile je Block wie im Kamerabild (linearisiert)
    const c = (await decodeRawData(b, r.info.cameraWb))!.frame;
    const p = (await rawPreview(b))!;
    const jp = jpeg.decode(new Uint8Array(await b.slice(p.offset, p.offset + p.length).arrayBuffer()), { useTArray: true });
    const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    const B = 64, rr: number[] = [], jr: number[] = [], rb: number[] = [], jb: number[] = [];
    for (let by = 0; by + B <= c.height; by += B * 3)
      for (let bx = 0; bx + B <= c.width; bx += B * 3) {
        const s = [0, 0, 0], q = [0, 0, 0];
        for (let y = by; y < by + B; y += 2)
          for (let x = bx; x < bx + B; x += 2) {
            for (let k = 0; k < 3; k++) s[k] += c.data[(y * c.width + x) * 3 + k];
            const jx = Math.floor((x * jp.width) / c.width), jy = Math.floor((y * jp.height) / c.height);
            for (let k = 0; k < 3; k++) q[k] += lin(jp.data[(jy * jp.width + jx) * 4 + k]);
          }
        if (s[1] < 1000 || q[1] < 1e-3) continue;
        rr.push(Math.log(s[0] / s[1])); jr.push(Math.log(q[0] / q[1]));
        rb.push(Math.log(s[2] / s[1])); jb.push(Math.log(q[2] / q[1]));
      }
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
      return sab / Math.sqrt(saa * sbb);
    };
    expect(rr.length).toBeGreaterThan(100);
    expect(corr(rr, jr)).toBeGreaterThan(0.7);
    expect(corr(rb, jb)).toBeGreaterThan(0.7);
  }, 120_000);

  it.skipIf(!existsSync(`${RAW}/raf`) || !existsSync(`${RAW}/cr3`))("komprimierte RAF und CR3: keine Sensordaten, Hinweis auf DNG", async () => {
    const first = (dir: string) => `${RAW}/${dir}/${readdirSync(`${RAW}/${dir}`)[0]}`;
    for (const [dir, kind] of [["raf", "RAF"], ["cr3", "CR3"]]) {
      const b = await openAsBlob(first(dir));
      expect(await decodeRawData(b)).toBeNull();
      expect(await rawUnsupported(b)).toBe(kind);
    }
  }, 60_000);
});
