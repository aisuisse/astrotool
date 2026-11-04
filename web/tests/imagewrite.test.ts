import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { encodeFits, encodePng16, encodeTiff16 } from "../src/engine/imagewrite";
import { SerColor, type Frame } from "../src/engine/ser";

const W = 37, H = 23; // ungerade Masse: Zeilen- und Blockgrenzen prüfen
function frame(planes: 1 | 3, bitDepth: number, colorId: number): Frame {
  const max = 2 ** bitDepth - 1;
  const data = bitDepth > 8 ? new Uint16Array(W * H * planes) : new Uint8Array(W * H * planes);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919 + (i >> 3) * 31) % (max + 1);
  data[0] = 0;
  data[1] = max;
  return { width: W, height: H, planes, bitDepth, colorId, data };
}
const to16 = (v: number, bd: number) => (bd === 8 ? v * 257 : bd === 16 ? v : v << (16 - bd));
/** erwarteter Wert für Pixel i, Kanal c (RGB-Reihenfolge) */
const expected = (f: Frame, i: number, c: number) =>
  to16(f.data[f.planes === 3 ? i * 3 + (f.colorId === SerColor.BGR ? 2 - c : c) : i], f.bitDepth);

describe("16-bit-PNG", () => {
  for (const [planes, bd, col] of [[1, 16, SerColor.MONO], [3, 12, SerColor.RGB], [3, 8, SerColor.BGR]] as const) {
    it(`${planes === 3 ? "Farbe" : "grau"}, ${bd} bit${col === SerColor.BGR ? " (BGR)" : ""}: verlustfrei lesbar`, async () => {
      const f = frame(planes, bd, col);
      const bytes = await encodePng16(f, { date: new Date(Date.UTC(2026, 7, 12, 19, 33, 9)), software: "Astrotool test" });
      const png = PNG.sync.read(Buffer.from(bytes), { skipRescale: true });
      expect([png.width, png.height]).toEqual([W, H]);
      const d = png.data as unknown as Uint16Array;
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) expect(d[i * 4 + c]).toBe(expected(f, i, planes === 3 ? c : 0));
    });
  }
});

/** kleiner TIFF-Leser für den Test (little-endian, ein Streifen) */
function readTiff(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset);
  expect(v.getUint16(0, true)).toBe(0x4949);
  expect(v.getUint16(2, true)).toBe(42);
  const ifd = v.getUint32(4, true), n = v.getUint16(ifd, true);
  const tags = new Map<number, { type: number; count: number; off: number }>();
  let last = 0;
  for (let k = 0; k < n; k++) {
    const o = ifd + 2 + k * 12, tag = v.getUint16(o, true);
    expect(tag).toBeGreaterThan(last); // aufsteigend sortiert (Pflicht)
    last = tag;
    tags.set(tag, { type: v.getUint16(o + 2, true), count: v.getUint32(o + 4, true), off: o + 8 });
  }
  const val = (t: number) => { const e = tags.get(t)!; return e.type === 3 ? v.getUint16(e.off, true) : v.getUint32(e.off, true); };
  const ascii = (t: number) => { const e = tags.get(t)!; const o = e.count > 4 ? v.getUint32(e.off, true) : e.off; return new TextDecoder().decode(b.subarray(o, o + e.count - 1)); };
  return { val, ascii, tags, v };
}

describe("16-bit-TIFF", () => {
  for (const [planes, bd, col] of [[1, 12, SerColor.MONO], [3, 16, SerColor.BGR]] as const) {
    it(`${planes === 3 ? "Farbe (BGR)" : "grau"}, ${bd} bit: Tags und Werte stimmen`, () => {
      const f = frame(planes, bd, col);
      const b = encodeTiff16(f, { date: new Date(Date.UTC(2026, 7, 12, 19, 33, 9)), software: "Astrotool test" });
      const t = readTiff(b);
      expect([t.val(256), t.val(257), t.val(259), t.val(277)]).toEqual([W, H, 1, planes]);
      expect(t.val(262)).toBe(planes === 3 ? 2 : 1);
      expect(t.ascii(306)).toBe("2026:08:12 19:33:09");
      expect(t.ascii(305)).toBe("Astrotool test");
      const off = t.val(273);
      expect(t.val(279)).toBe(W * H * planes * 2);
      expect(off + W * H * planes * 2).toBe(b.length);
      for (let i = 0; i < W * H; i++) for (let c = 0; c < planes; c++) expect(t.v.getUint16(off + 2 * (i * planes + c), true)).toBe(expected(f, i, c));
    });
  }
});

/** FITS-Kopf lesen: Schlüssel → Rohwert */
function readFitsHeader(b: Uint8Array) {
  const keys = new Map<string, string>();
  let o = 0;
  for (;; o += 80) {
    const c = new TextDecoder().decode(b.subarray(o, o + 80));
    expect(c.length).toBe(80);
    const k = c.slice(0, 8).trim();
    if (k === "END") break;
    if (c[8] === "=") keys.set(k, c.slice(10).split(" / ")[0].trim());
  }
  return { keys, data: Math.ceil((o + 80) / 2880) * 2880 };
}

describe("FITS", () => {
  it("Farbe: drei Ebenen, BZERO, Zeit und Belichtung, Blöcke à 2880 Byte", () => {
    const f = frame(3, 12, SerColor.RGB);
    const b = encodeFits(f, { date: new Date(Date.UTC(2026, 7, 12, 19, 33, 9, 250)), exposure: 1 / 3200 });
    expect(b.length % 2880).toBe(0);
    const { keys, data } = readFitsHeader(b);
    expect(new TextDecoder().decode(b.subarray(0, 30))).toBe("SIMPLE  =                    T");
    expect(keys.get("BITPIX")).toBe("16");
    expect([keys.get("NAXIS"), keys.get("NAXIS1"), keys.get("NAXIS2"), keys.get("NAXIS3")]).toEqual(["3", String(W), String(H), "3"]);
    expect(keys.get("BZERO")).toBe("32768");
    expect(keys.get("DATE-OBS")).toBe("'2026-08-12T19:33:09.250'");
    expect(Number(keys.get("EXPTIME"))).toBeCloseTo(1 / 3200, 9);
    const v = new DataView(b.buffer, b.byteOffset + data);
    for (let c = 0; c < 3; c++) for (let i = 0; i < W * H; i++) expect(v.getInt16(2 * (c * W * H + i)) + 32768).toBe(expected(f, i, c));
  });

  it("Bayer-Rohdaten: grau mit BAYERPAT", () => {
    const f = frame(1, 16, SerColor.BAYER_GRBG);
    const b = encodeFits(f);
    const { keys, data } = readFitsHeader(b);
    expect(keys.get("NAXIS")).toBe("2");
    expect(keys.get("BAYERPAT")).toBe("'GRBG    '");
    expect(keys.get("ROWORDER")).toBe("'TOP-DOWN'");
    const v = new DataView(b.buffer, b.byteOffset + data);
    expect(v.getInt16(0) + 32768).toBe(0);
    expect(v.getInt16(2) + 32768).toBe(65535);
  });
});
