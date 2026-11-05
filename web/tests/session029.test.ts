import { describe, expect, it } from "vitest";
import { SerColor, type Frame } from "../src/engine/ser";
import { defaultOptions, outputColorId, outputSize } from "../src/engine/pipeline";
import { defaultTransform, hasTransform, tone, transformFrame, transformedSize, type TransformOptions } from "../src/engine/transform";
import { seriesTime, shiftMs, timeFromName, winjuposName, winjuposStamp } from "../src/engine/winjupos";

const T = (t: Partial<TransformOptions>): TransformOptions => ({ ...defaultTransform, ...t });
const utc = (s: string) => Date.parse(s);

describe("WinJUPOS-Dateinamen", () => {
  it("schreibt Datum und Uhrzeit in UT mit Zehntelminute", () => {
    expect(winjuposStamp(utc("2022-10-25T00:55:12Z"))).toBe("2022-10-25-0055_2");
    expect(winjuposStamp(utc("2022-10-25T00:55:17Z"))).toBe("2022-10-25-0055_3"); // gerundet
    expect(winjuposStamp(utc("2022-10-25T00:55:59Z"))).toBe("2022-10-25-0056_0");
    // Übertrag über Tag, Monat und Jahr
    expect(winjuposStamp(utc("2026-12-31T23:59:58Z"))).toBe("2027-01-01-0000_0");
  });

  it("hängt Beobachter und Angabe an, ungeeignete Zeichen werden ersetzt", () => {
    const t = utc("2022-10-25T00:55:12Z");
    expect(winjuposName(t, { wjObserver: "", wjInfo: "" })).toBe("2022-10-25-0055_2");
    expect(winjuposName(t, { wjObserver: "JS", wjInfo: "Jup-RGB" })).toBe("2022-10-25-0055_2-JS-Jup-RGB");
    expect(winjuposName(t, { wjObserver: " J S ", wjInfo: "Sat/IR:685" })).toBe("2022-10-25-0055_2-J_S-Sat_IR_685");
  });

  it("Zeit eines Videos: Beginn, Mitte, Ende; Verschiebung in Minuten", () => {
    const a = utc("2022-10-25T00:54:00Z"), b = utc("2022-10-25T00:57:00Z");
    expect(winjuposStamp(seriesTime(a, b, "start"))).toBe("2022-10-25-0054_0");
    expect(winjuposStamp(seriesTime(a, b, "mid"))).toBe("2022-10-25-0055_5");
    expect(winjuposStamp(seriesTime(a, b, "end"))).toBe("2022-10-25-0057_0");
    expect(shiftMs({ wjShiftMinutes: -120 })).toBe(-7_200_000);
    expect(shiftMs({ wjShiftMinutes: NaN })).toBe(0);
  });

  it("liest die Zeit aus üblichen Dateinamen", () => {
    expect(timeFromName("2022-10-25-0055_2.ser")).toBe(utc("2022-10-25T00:55:12Z"));
    expect(timeFromName("2022-10-25-0055_2-JS-Jup-RGB.ser")).toBe(utc("2022-10-25T00:55:12Z"));
    expect(timeFromName("Jup_2022-10-25-005512.avi")).toBe(utc("2022-10-25T00:55:12Z"));
    expect(timeFromName("2023-01-02T21:05:09.500.ser")).toBe(utc("2023-01-02T21:05:09.500Z"));
    expect(timeFromName("Mars_2024-11-30_03-14-15.ser")).toBe(utc("2024-11-30T03:14:15Z"));
    expect(timeFromName("IMG_20240408_181502.jpg")).toBe(utc("2024-04-08T18:15:02Z"));
    // keine oder ungültige Zeit
    expect(timeFromName("saturn600.ser")).toBeNull();
    expect(timeFromName("2022-13-25-0055_2.ser")).toBeNull();
    expect(timeFromName("2022-10-25-2575_2.ser")).toBeNull();
    expect(timeFromName("DSC_0123.NEF")).toBeNull();
  });
});

describe("Bearbeitung: Breite × Höhe", () => {
  it("feste Grösse, eine Angabe mit Seitenverhältnis, nach dem Drehen", () => {
    expect(transformedSize(T({ resizeMode: "size", resizeWidth: 300, resizeHeight: 200 }), 448, 448)).toEqual([300, 200]);
    expect(transformedSize(T({ resizeMode: "size", resizeWidth: 320 }), 640, 480)).toEqual([320, 240]);
    expect(transformedSize(T({ resizeMode: "size", resizeHeight: 120 }), 640, 480)).toEqual([160, 120]);
    // Breite gilt nach dem Drehen
    expect(transformedSize(T({ resizeMode: "size", resizeWidth: 240, rotate: 90 }), 640, 480)).toEqual([240, 320]);
    // ohne Angabe: unverändert, keine Bearbeitung
    expect(hasTransform(T({ resizeMode: "size" }))).toBe(false);
    // Prozent gilt im Modus Breite × Höhe nicht
    expect(transformedSize(T({ resizeMode: "size", resizePercent: 50 }), 640, 480)).toEqual([640, 480]);
    expect(outputSize({ width: 1000, height: 800 }, { ...defaultOptions, cropWidth: 400, cropHeight: 300, resizeMode: "size", resizeWidth: 200 })).toEqual([200, 150]);
  });

  it("ändert das Bild auf genau diese Grösse", () => {
    const f: Frame = { width: 40, height: 20, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data: new Uint8Array(40 * 20 * 3).fill(100) };
    const o = transformFrame(f, T({ resizeMode: "size", resizeWidth: 30, resizeHeight: 30 }), null);
    expect([o.width, o.height]).toEqual([30, 30]);
    expect(Math.min(...o.data)).toBe(100); // gleichmässige Fläche bleibt gleich hell
  });
});

/** Graues Bild mit Verlauf 0 … max-1 und einem heissen Pixel */
function ramp(w: number, h: number, max: number, bits = 8): Frame {
  const data = bits > 8 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = Math.floor((i / (w * h)) * max);
  return { width: w, height: h, planes: 1, bitDepth: bits, colorId: SerColor.MONO, data };
}

describe("Bearbeitung: Tonwerte", () => {
  it("Verstärkung schneidet am Maximum ab, Gamma hellt die Mitteltöne auf", () => {
    const f: Frame = { width: 4, height: 1, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: Uint8Array.from([0, 64, 128, 200]) };
    expect(Array.from(tone(f, { gain: 2 }, null).data)).toEqual([0, 128, 255, 255]);
    const g = tone(f, { gamma: 2 }, null).data;
    expect(g[0]).toBe(0);
    expect(g[1]).toBe(Math.round(Math.sqrt(64 / 255) * 255)); // 128
    expect(g[3]).toBe(Math.round(Math.sqrt(200 / 255) * 255));
    expect(tone(f, { gain: 1, gamma: 1 }, null)).toBe(f); // nichts zu tun
  });

  it("Strecken: hellste Werte auf das Ziel, einzelne heisse Pixel zählen nicht", () => {
    const f = ramp(200, 100, 100); // Werte 0 … 99
    f.data[5] = 255; // heisses Pixel
    const s = tone(f, { stretch: true, stretchTarget: 100 }, null);
    // 99 → 255 (das heisse Pixel wird abgeschnitten)
    expect(s.data[f.data.length - 1]).toBe(255);
    expect(s.data[Math.floor(f.data.length / 2)]).toBeCloseTo((50 / 99) * 255, -1);
    const s80 = tone(f, { stretch: true, stretchTarget: 80 }, null);
    expect(s80.data[f.data.length - 1]).toBe(Math.round(0.8 * 255));
  });

  it("Strecken mit Schwarzpunkt und 16 bit", () => {
    const f = ramp(100, 100, 3000, 12);
    for (let i = 0; i < f.data.length; i++) f.data[i] += 1000; // Sockel 1000 … 3999
    const s = tone(f, { stretch: true, stretchBlack: true }, null);
    expect(s.data[0]).toBe(0);
    expect(s.data[f.data.length - 1]).toBe(4095);
    const noBlack = tone(f, { stretch: true }, null);
    expect(noBlack.data[0]).toBeGreaterThan(900); // Sockel bleibt anteilig
  });

  it("jede Farbe einzeln gleicht die Farben ab (RGB und Bayer-Rohdaten)", () => {
    const n = 100 * 100;
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set([100, 200, 50].map((v) => Math.floor((v * i) / n)), i * 3);
    const f: Frame = { width: 100, height: 100, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data: rgb };
    const s = tone(f, { stretch: true, stretchPerChannel: true }, null);
    const last = Array.from(s.data.slice((n - 1) * 3));
    expect(last).toEqual([255, 255, 255]);
    const together = tone(f, { stretch: true }, null);
    expect(Array.from(together.data.slice((n - 1) * 3))[2]).toBeLessThan(80);
    // Bayer RGGB: R-Zellen 1000, G 2000, B 500 (12 bit)
    const bayer = new Uint16Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) bayer[y * 64 + x] = (y & 1) === 0 ? ((x & 1) === 0 ? 1000 : 2000) : (x & 1) === 0 ? 2000 : 500;
    const bf: Frame = { width: 64, height: 64, planes: 1, bitDepth: 12, colorId: SerColor.BAYER_RGGB, data: bayer };
    bf.data[0] = 0; // je Farbe ein dunkles Pixel, damit Schwarz- und Weisspunkt verschieden sind
    const out = transformFrame(bf, T({ stretch: true, stretchPerChannel: true }), "RGGB");
    expect(out.planes).toBe(1); // bleibt roh
    expect(out.colorId).toBe(SerColor.BAYER_RGGB);
    expect([out.data[64 * 2 + 2], out.data[64 * 2 + 3], out.data[64 * 3 + 3]]).toEqual([4095, 4095, 4095]);
  });

  it("Tonwerte und Drehen: SER bleibt Bayer-roh mit neuem Muster", () => {
    const o = { ...defaultOptions, gamma: 1.5, flipH: true };
    expect(outputColorId(o, { colorId: SerColor.BAYER_RGGB }, 448, 448)).toBe(SerColor.BAYER_GRBG);
    // Grösse ändern macht farbig
    expect(outputColorId({ ...o, resizeMode: "size", resizeWidth: 200 }, { colorId: SerColor.BAYER_RGGB }, 448, 448)).toBe(SerColor.RGB);
  });
});
