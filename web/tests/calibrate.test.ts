import { describe, expect, it } from "vitest";
import { Calibrator, calibratedSource, flatGain, MasterBuilder } from "../src/engine/calibrate";
import { SerColor, type Frame } from "../src/engine/ser";
import type { FrameSource } from "../src/engine/source";

const W = 40, H = 30;
const mono = (bitDepth: number, f: (x: number, y: number) => number, colorId = SerColor.MONO): Frame => {
  const data = bitDepth > 8 ? new Uint16Array(W * H) : new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.round(f(x, y));
  return { width: W, height: H, planes: 1, bitDepth, colorId, data };
};
// Sensor: Grundrauschen (Offset) 100, heisses Pixel bei (5,5); Optik: Vignettierung und ein Staubschatten
const offset = (x: number, y: number) => 100 + (x === 5 && y === 5 ? 3000 : 0);
const vignette = (x: number, y: number) => 1 - 0.4 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 4;
const dust = (x: number, y: number) => (Math.hypot(x - 30, y - 10) < 3 ? 0.6 : 1);
const optics = (x: number, y: number) => vignette(x, y) * dust(x, y);
// Bayer-Farbempfindlichkeit je 2×2-Zelle (R, G, G, B)
const cfa = (x: number, y: number) => [1, 0.8, 0.8, 0.5][((y & 1) << 1) | (x & 1)];

describe("Master aus mehreren Bildern", () => {
  it("Mittelwert ohne höchsten und tiefsten Wert: ein Ausreisser (kosmischer Strahl) verschwindet", () => {
    const b = new MasterBuilder();
    for (const k of [0, 1, 2, 3, 4]) b.add(mono(16, (x, y) => 100 + k + (k === 2 && x === 1 && y === 1 ? 60000 : 0)));
    const m = b.finish();
    expect(m.frames).toBe(5);
    expect(m.data[1 * W + 1]).toBeCloseTo((1 + 3 + 4 + 100 * 3) / 3 - 0, 5); // 100+1, 100+3, 100+4 übrig (0 und 2 fallen weg)
    expect(m.data[0]).toBeCloseTo(102, 5);
  });

  it("zwei Bilder: einfacher Mittelwert; verschiedene Grössen werden abgelehnt", () => {
    const b = new MasterBuilder();
    b.add(mono(8, () => 10));
    b.add(mono(8, () => 20));
    expect(b.finish().data[7]).toBe(15);
    const c = new MasterBuilder();
    c.add(mono(8, () => 1));
    expect(() => c.add({ width: 2, height: 2, planes: 1, bitDepth: 8, colorId: 0, data: new Uint8Array(4) })).toThrow();
  });
});

describe("Flat", () => {
  it("je 2×2-Zelle normiert: Bayer-Farben bleiben neutral, Vignettierung und Staub werden ausgeglichen", () => {
    const b = new MasterBuilder();
    b.add(mono(16, (x, y) => 100 + 30000 * optics(x, y) * cfa(x, y), SerColor.BAYER_RGGB));
    const bias = new MasterBuilder();
    bias.add(mono(16, () => 100, SerColor.BAYER_RGGB));
    const g = flatGain(b.finish(), bias.finish());
    // Gewinn × Optik × Zelle ist je Zelle konstant (gleich dem Kehrwert des Zellmittels)
    const ratio = (x: number, y: number) => g[y * W + x] * optics(x, y);
    expect(ratio(30, 10) / ratio(20, 14)).toBeCloseTo(1, 3); // im Staub = in der Mitte (gleiche Zelle)
    expect(ratio(1, 1) / ratio(21, 15)).toBeCloseTo(1, 3); // Rand = Mitte
  });
});

describe("Kalibrieren", () => {
  // Aufnahme: Objekt mit Helligkeit 5000 × Optik + Sensor-Offset
  const light = mono(16, (x, y) => offset(x, y) + 5000 * optics(x, y));
  const darkB = new MasterBuilder();
  for (let k = 0; k < 4; k++) darkB.add(mono(16, (x, y) => offset(x, y)));
  const flatB = new MasterBuilder();
  for (let k = 0; k < 3; k++) flatB.add(mono(16, (x, y) => 100 + 20000 * optics(x, y)));
  const biasB = new MasterBuilder();
  biasB.add(mono(16, () => 100));
  const cal = { dark: darkB.finish(), flat: flatB.finish(), flatDark: biasB.finish() };
  const shape = { width: W, height: H, planes: 1, bitDepth: 16 };

  it("Dark + Flat: heisses Pixel, Vignettierung und Staubschatten weg – überall gleich hell", () => {
    const out = new Calibrator(cal, shape).apply(light).data;
    const vals = Array.from(out);
    const mid = out[15 * W + 20];
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(0.003 * mid + 2);
    expect(out[5 * W + 5]).toBeCloseTo(mid, -1); // heisses Pixel
    expect(out[10 * W + 30]).toBeCloseTo(mid, -1); // Staub
  });

  it("nur Dark: Offset und heisses Pixel weg, Vignettierung bleibt", () => {
    const out = new Calibrator({ dark: cal.dark }, shape).apply(light).data;
    expect(out[5 * W + 5]).toBe(Math.round(5000 * optics(5, 5)));
    expect(out[10 * W + 30]).toBeLessThan(out[15 * W + 20] * 0.7);
  });

  it("Werte bleiben im gültigen Bereich (keine negativen, kein Überlauf)", () => {
    const c = new Calibrator({ dark: cal.dark }, { ...shape });
    const out = c.apply(mono(16, () => 50)).data; // dunkler als das Dark
    expect(Math.min(...out)).toBe(0);
    const bright = new Calibrator({ flat: cal.flat, flatDark: cal.flatDark }, shape).apply(mono(16, () => 65535)).data;
    expect(Math.max(...bright)).toBe(65535);
  });

  it("falsche Grösse: verständliche Meldung", () => {
    expect(() => new Calibrator(cal, { ...shape, width: 41 })).toThrow(/@calSize/);
  });

  it("8-bit-Dark für 16-bit-Daten wird umgerechnet", () => {
    const d = new MasterBuilder();
    d.add(mono(8, () => 1)); // 1/255 des Bereichs
    const out = new Calibrator({ dark: d.finish() }, shape).apply(mono(16, () => 1000)).data;
    expect(out[0]).toBe(1000 - 257);
  });

  it("kalibrierte Quelle: liefert kalibrierte Bilder, alles andere wie das Original", async () => {
    const src: FrameSource = {
      kind: "ser", width: W, height: H, frameCount: 2, colorId: 0, bitDepth: 16,
      readFrame: async () => light, readTimestamps: async () => null, frameName: (i) => `f${i}`, meta: {}, clock: "utc",
    };
    const c = calibratedSource(src, cal);
    expect(c.frameName(1)).toBe("f1");
    expect(c.frameCount).toBe(2);
    const f = await c.readFrame(0);
    expect(f.data[5 * W + 5]).toBeCloseTo(f.data[15 * W + 20], -1);
    expect(calibratedSource(src, {})).toBe(src); // ohne Master: unverändert
  });
});
