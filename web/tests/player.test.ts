import { describe, expect, it } from "vitest";
import { debayer, type BayerPattern } from "../src/engine/debayer";
import { autoBalance, renderDisplay, defaultDisplay, processedFrame } from "../src/engine/display";
import { SerColor, type Frame } from "../src/engine/ser";

/** Erzeugt Bayer-Rohdaten einer einfarbigen Fläche (r, g, b) im gegebenen Muster. */
function mosaic(w: number, h: number, rgb: [number, number, number], pattern: BayerPattern, depth = 8): Frame {
  const lay = { RGGB: [[0, 1], [1, 2]], GRBG: [[1, 0], [2, 1]], GBRG: [[1, 2], [0, 1]], BGGR: [[2, 1], [1, 0]] }[pattern];
  const data = depth > 8 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = rgb[lay[y & 1][x & 1]];
  const id = { RGGB: SerColor.BAYER_RGGB, GRBG: SerColor.BAYER_GRBG, GBRG: SerColor.BAYER_GBRG, BGGR: SerColor.BAYER_BGGR }[pattern];
  return { width: w, height: h, planes: 1, bitDepth: depth, colorId: id, data };
}

describe("Debayer", () => {
  for (const p of ["RGGB", "GRBG", "GBRG", "BGGR"] as BayerPattern[]) {
    it(`stellt eine einfarbige Fläche korrekt wieder her (${p})`, () => {
      const out = debayer(mosaic(8, 6, [200, 120, 40], p), p);
      expect(out.planes).toBe(3);
      for (let i = 0; i < 8 * 6; i++) {
        expect([out.data[i * 3], out.data[i * 3 + 1], out.data[i * 3 + 2]]).toEqual([200, 120, 40]);
      }
    });
  }

  it("falsches Muster vertauscht Farben (Kontrolle des Tests)", () => {
    const out = debayer(mosaic(8, 6, [200, 120, 40], "RGGB"), "BGGR");
    expect(out.data[3 * 9]).not.toBe(200);
  });

  it("16 bit bleibt 16 bit", () => {
    const out = debayer(mosaic(4, 4, [4000, 2000, 1000], "GBRG", 12), "GBRG");
    expect(out.data).toBeInstanceOf(Uint16Array);
    expect(out.data[5 * 3]).toBe(4000);
  });
});

describe("Anzeige", () => {
  it("automatische Farbbalance macht eine farbstichige Fläche neutral", () => {
    const rgb = debayer(mosaic(16, 16, [180, 120, 60], "RGGB"), "RGGB");
    const bal = autoBalance(rgb);
    expect(bal[0] * 180).toBeCloseTo(120, 0);
    expect(bal[2] * 60).toBeCloseTo(120, 0);
    const r = renderDisplay(mosaic(16, 16, [180, 120, 60], "RGGB"), { ...defaultDisplay, balance: null });
    expect(Math.abs(r.rgba[0] - r.rgba[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(r.rgba[2] - r.rgba[1])).toBeLessThanOrEqual(1);
  });

  it("Gain, Gamma und Histogramm", () => {
    const mono: Frame = { width: 2, height: 1, planes: 1, bitDepth: 8, colorId: 0, data: new Uint8Array([64, 255]) };
    const r = renderDisplay(mono, { ...defaultDisplay, gain: 2 });
    expect(r.rgba[0]).toBe(128);
    expect(r.rgba[4]).toBe(255);
    expect(r.histogram[3][128] + r.histogram[3][255]).toBe(2);
    const g = renderDisplay(mono, { ...defaultDisplay, gamma: 2 });
    expect(g.rgba[0]).toBeGreaterThan(64); // Gamma > 1 hellt auf
  });

  it("Speichern wie angezeigt liefert 8-bit-RGB", () => {
    const f = processedFrame(mosaic(4, 4, [100, 100, 100], "RGGB"), defaultDisplay);
    expect(f).toMatchObject({ planes: 3, bitDepth: 8, colorId: 100 });
    expect(f.data[0]).toBe(100);
  });
});

describe("SER-Reparatur", () => {
  it("bestimmt die Frame-Zahl aus der Dateigrösse, wenn der Header 0 sagt", async () => {
    const { SerWriter, SerReader } = await import("../src/engine/ser");
    const w = new SerWriter({ luId: 0, colorId: 0, littleEndianFlag: 0, width: 4, height: 4, bitDepth: 8, observer: "", instrument: "", telescope: "", dateTime: 0n, dateTimeUtc: 0n });
    for (let i = 0; i < 5; i++) w.add({ width: 4, height: 4, planes: 1, bitDepth: 8, colorId: 0, data: new Uint8Array(16).fill(i) });
    const bytes = new Uint8Array(await w.toBlob().arrayBuffer());
    new DataView(bytes.buffer).setInt32(38, 0, true); // Frame-Zahl kaputt
    const r = await SerReader.open(new Blob([bytes]));
    expect(r.header.frameCount).toBe(5);
    expect((await r.readFrame(4)).data[0]).toBe(4);
  });
});
