import { describe, expect, it } from "vitest";
import { SerColor, SerReader, SerWriter, type Frame } from "../src/engine/ser";
import { detectObject, toLum } from "../src/engine/image";
import { bayerPatternFor, defaultOptions, processSer } from "../src/engine/pipeline";
import { applyPof, parsePof } from "../src/engine/pof";

/** RGGB-Mosaik einer farbigen Scheibe (Rot stark, Blau schwach) auf schwarzem Grund. */
function bayerDisc(w: number, h: number, cx: number, cy: number, r: number, rgb = [200, 120, 40]): Frame {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : (x & 1) === 0 ? 1 : 2;
      const inside = 1 / (1 + Math.exp((Math.hypot(x - cx, y - cy) - r) / 0.7));
      data[y * w + x] = Math.round(rgb[c] * inside);
    }
  return { width: w, height: h, planes: 1, bitDepth: 8, colorId: SerColor.BAYER_RGGB, data };
}

const header = { luId: 0, colorId: SerColor.BAYER_RGGB, littleEndianFlag: 0, observer: "", instrument: "", telescope: "", dateTime: 0n, dateTimeUtc: 0n, bitDepth: 8 };

describe("Debayer in der Verarbeitung", () => {
  it("Helligkeit aus dem Mosaik hat kein Schachbrett-Muster", () => {
    const f = bayerDisc(40, 40, 20, 20, 100); // ganze Fläche farbig
    const l = toLum(f, true);
    const inner = Array.from(l.data.slice(10 * 40 + 10, 10 * 40 + 30));
    const spread = Math.max(...inner) - Math.min(...inner);
    expect(spread).toBeLessThan(1e-6);
    expect(inner[0]).toBeCloseTo((200 / 4 + 120 / 2 + 40 / 4) / 255, 5);
    // ohne Filter springt der Wert von Pixel zu Pixel
    const raw = Array.from(toLum(f).data.slice(10 * 40 + 10, 10 * 40 + 30));
    expect(Math.max(...raw) - Math.min(...raw)).toBeGreaterThan(0.3);
  });

  it("Muster: automatisch aus dem Kopf, fest, aus, und nie bei RGB", () => {
    expect(bayerPatternFor({ debayer: "auto" }, { colorId: SerColor.BAYER_GBRG })).toBe("GBRG");
    expect(bayerPatternFor({ debayer: "auto" }, { colorId: SerColor.MONO })).toBeNull();
    expect(bayerPatternFor({ debayer: "BGGR" }, { colorId: SerColor.MONO })).toBe("BGGR");
    expect(bayerPatternFor({ debayer: "off" }, { colorId: SerColor.BAYER_RGGB })).toBeNull();
    expect(bayerPatternFor({ debayer: "RGGB" }, { colorId: SerColor.RGB, planes: 3 })).toBeNull();
  });

  async function run(debayerSer: boolean) {
    const w = new SerWriter({ ...header, width: 120, height: 100 });
    w.add(bayerDisc(120, 100, 47.3, 41.8, 15), 1n);
    w.add(bayerDisc(120, 100, 70.6, 55.2, 15), 2n);
    const r = await SerReader.open(w.toBlob());
    const { blob } = await processSer(r, { ...defaultOptions, cropWidth: 48, cropHeight: 48, minObjectSize: 10, qualityEnabled: false, debayerSer });
    return SerReader.open(blob);
  }

  it("SER bleibt standardmässig Bayer-Rohdaten (für AutoStakkert!)", async () => {
    const out = await run(false);
    expect(out.header.colorId).toBe(SerColor.BAYER_RGGB);
    const f = await out.readFrame(0);
    expect(f.planes).toBe(1);
    // Muster erhalten: Ausschnitt beginnt auf gerader Position → oben links ist Rot
    expect(f.data[24 * 48 + 24]).toBeGreaterThan(f.data[25 * 48 + 25]);
  });

  it("SER auf Wunsch farbig, zentriert und mit richtigen Farben", async () => {
    const out = await run(true);
    expect(out.header.colorId).toBe(SerColor.RGB);
    for (let i = 0; i < 2; i++) {
      const f = await out.readFrame(i);
      expect(f.planes).toBe(3);
      const c = (24 * 48 + 24) * 3;
      expect(f.data[c]).toBeGreaterThan(180); // R
      expect(f.data[c + 1]).toBeGreaterThan(100); // G
      expect(f.data[c + 2]).toBeLessThan(60); // B
      const d = detectObject(toLum(f));
      expect(Math.abs(d.cx - 24)).toBeLessThan(1.5);
      expect(Math.abs(d.cy - 24)).toBeLessThan(1.5);
    }
  });

  it(".pof: DEBAYER_ENABLED und PROTECT_BAYER", () => {
    const on = applyPof(defaultOptions, parsePof("[PIPP OPTIONS FILE]\nDEBAYER_ENABLED True\nDEBAYER_PATTERN 1\nDEBAYER_TYPE 0\n"));
    expect(on.options).toMatchObject({ debayer: "BGGR", debayerSer: true });
    expect(on.ignored).toEqual([]);
    const prot = applyPof(defaultOptions, parsePof("[PIPP OPTIONS FILE]\nDEBAYER_ENABLED False\nPROTECT_BAYER True\n"));
    expect(prot.options).toMatchObject({ debayer: "off", debayerSer: false });
  });
});
