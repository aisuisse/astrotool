import { describe, expect, it } from "vitest";
import { SerColor, SerReader, SerWriter, type Frame } from "../src/engine/ser";
import { debayer } from "../src/engine/debayer";
import { detectObject, toLum } from "../src/engine/image";
import { defaultOptions, judge, outputColorId, outputSize, processSer } from "../src/engine/pipeline";
import { bayerAfterTransform, defaultTransform, resize, toMono, transformFrame, transformedSize, type TransformOptions } from "../src/engine/transform";

const T = (t: Partial<TransformOptions>): TransformOptions => ({ ...defaultTransform, ...t });

/** RGB-Bild 3 × 2 mit eindeutigen Werten je Pixel und Kanal */
function rgb3x2(): Frame {
  const data = new Uint8Array(3 * 2 * 3);
  for (let i = 0; i < 6; i++) data.set([10 * i + 1, 10 * i + 2, 10 * i + 3], i * 3);
  return { width: 3, height: 2, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
}
const px = (f: Frame, x: number, y: number) => Array.from(f.data.slice((y * f.width + x) * f.planes, (y * f.width + x + 1) * f.planes));

function randomBayer(w: number, h: number, colorId = SerColor.BAYER_RGGB, seed = 7): Frame {
  let s = seed;
  const data = new Uint16Array(w * h).map(() => ((s = (s * 1103515245 + 12345) >>> 0) >>> 20) & 4095);
  return { width: w, height: h, planes: 1, bitDepth: 12, colorId, data };
}

describe("Bilder bearbeiten: Spiegeln und Drehen", () => {
  it("spiegelt und dreht pixelgenau", () => {
    const f = rgb3x2(); // Pixel (x, y) hat Nummer y*3+x
    const h = transformFrame(f, T({ flipH: true }), null);
    expect(px(h, 0, 0)).toEqual(px(f, 2, 0));
    const v = transformFrame(f, T({ flipV: true }), null);
    expect(px(v, 1, 0)).toEqual(px(f, 1, 1));
    const r90 = transformFrame(f, T({ rotate: 90 }), null);
    expect([r90.width, r90.height]).toEqual([2, 3]);
    // im Uhrzeigersinn: die linke untere Ecke wandert nach oben links
    expect(px(r90, 0, 0)).toEqual(px(f, 0, 1));
    expect(px(r90, 1, 0)).toEqual(px(f, 0, 0));
    const r270 = transformFrame(f, T({ rotate: "270" }), null); // aus dem Formular kommt Text
    expect(px(r270, 0, 0)).toEqual(px(f, 2, 0));
    const r180 = transformFrame(f, T({ rotate: 180 }), null);
    expect(px(r180, 0, 0)).toEqual(px(f, 2, 1));
    // zweimal 180° = unverändert; Spiegeln beider Achsen = 180°
    expect(Array.from(transformFrame(r180, T({ rotate: 180 }), null).data)).toEqual(Array.from(f.data));
    expect(Array.from(transformFrame(f, T({ flipH: true, flipV: true }), null).data)).toEqual(Array.from(r180.data));
  });

  it("Bayer-Muster nach Spiegeln/Drehen", () => {
    const id = (t: Partial<TransformOptions>) => bayerAfterTransform(T(t), SerColor.BAYER_RGGB, 64, 48);
    expect(id({ flipH: true })).toBe(SerColor.BAYER_GRBG);
    expect(id({ flipV: true })).toBe(SerColor.BAYER_GBRG);
    expect(id({ rotate: 180 })).toBe(SerColor.BAYER_BGGR);
    expect(id({ rotate: 90 })).toBe(SerColor.BAYER_GRBG);
    expect(id({ rotate: 270 })).toBe(SerColor.BAYER_GBRG);
    // ungerade Grösse, Graustufen oder Grössenänderung: geht nicht roh
    expect(bayerAfterTransform(T({ flipH: true }), SerColor.BAYER_RGGB, 63, 48)).toBeNull();
    expect(id({ flipH: true, mono: true })).toBeNull();
    expect(id({ flipH: true, resizePercent: 50 })).toBeNull();
  });

  it("rohe Bayer-Daten spiegeln/drehen ergibt dasselbe Farbbild wie erst farbig machen", () => {
    const f = randomBayer(16, 12);
    for (const t of [T({ flipH: true }), T({ flipV: true }), T({ rotate: 90 }), T({ rotate: 270, flipH: true })]) {
      const raw = transformFrame(f, t, "RGGB");
      expect(raw.planes).toBe(1);
      const pattern = (["RGGB", "GRBG", "GBRG", "BGGR"] as const)[raw.colorId - SerColor.BAYER_RGGB];
      const a = debayer(raw, pattern);
      const b = transformFrame(debayer(f, "RGGB"), t, null);
      expect(Array.from(a.data)).toEqual(Array.from(b.data));
    }
  });

  it("festes Muster aus den Optionen: vorher farbig machen", () => {
    const f = { ...randomBayer(16, 12), colorId: SerColor.MONO };
    const out = transformFrame(f, T({ flipH: true }), "RGGB", false);
    expect(out.planes).toBe(3);
  });
});

describe("Bilder bearbeiten: Graustufen und Grösse", () => {
  it("Graustufen nach Rec. 601, auch für BGR", () => {
    const red: Frame = { width: 1, height: 1, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data: Uint8Array.from([200, 0, 0]) };
    expect(Array.from(toMono(red).data)).toEqual([60]);
    expect(toMono(red).colorId).toBe(SerColor.MONO);
    const bgr = { ...red, colorId: SerColor.BGR };
    expect(Array.from(toMono(bgr).data)).toEqual([23]); // 200 gilt hier als Blau
    // Bayer-Rohdaten werden erst farbig gemacht
    const m = transformFrame(randomBayer(8, 8), T({ mono: true }), "RGGB");
    expect([m.planes, m.colorId, m.bitDepth]).toEqual([1, SerColor.MONO, 12]);
  });

  it("Verkleinern mittelt die Fläche, Vergrössern bleibt im Wertebereich", () => {
    const n = 8;
    const checker: Frame = { width: n, height: n, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: new Uint8Array(n * n).map((_, i) => (((i % n) + Math.floor(i / n)) % 2 ? 200 : 0)) };
    const half = resize(checker, 4, 4);
    expect(Array.from(half.data)).toEqual(new Array(16).fill(100));
    const third = resize(checker, 3, 3); // keine ganzzahlige Teilung
    for (const v of third.data) expect(Math.abs(v - 100)).toBeLessThanOrEqual(12);
    const big = resize(checker, 20, 20);
    expect([big.width, big.height]).toEqual([20, 20]);
    expect(Math.max(...big.data)).toBeLessThanOrEqual(200);
    // Lage erhalten: Pixelmitte 20 liegt nach Verdoppeln bei (20 + 0.5) · 2 − 0.5 = 40.5
    const disc: Frame = { width: 41, height: 41, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: new Uint8Array(41 * 41).map((_, i) => (Math.hypot((i % 41) - 20, Math.floor(i / 41) - 20) < 8 ? 250 : 0)) };
    const d2 = detectObject(toLum(resize(disc, 82, 82)));
    expect(d2.cx).toBeCloseTo(40.5, 1);
    expect(d2.cy).toBeCloseTo(40.5, 1);
    const d3 = detectObject(toLum(resize(disc, 20, 20))); // Verkleinern: (20 + 0.5) · 20/41 − 0.5
    expect(d3.cx).toBeCloseTo(9.5, 0);
  });

  it("Ausgabegrösse nach Drehen und Grösse", () => {
    expect(transformedSize(T({ rotate: 90 }), 640, 480)).toEqual([480, 640]);
    expect(transformedSize(T({ resizePercent: 50 }), 640, 480)).toEqual([320, 240]);
    expect(transformedSize(T({ resizePercent: 1000 }), 100, 50)).toEqual([400, 200]); // höchstens 400 %
    expect(transformedSize(T({ resizePercent: 0 }), 100, 50)).toEqual([100, 50]); // leeres Feld = unverändert
    expect(outputSize({ width: 1000, height: 800 }, { ...defaultOptions, cropWidth: 300, cropHeight: 200, rotate: 270, resizePercent: 150 })).toEqual([300, 450]);
  });
});

/** RGGB-Mosaik einer Scheibe; core = Radius eines gesättigten Kerns */
function bayerDisc(w: number, h: number, cx: number, cy: number, r: number, core = 0): Frame {
  const rgb = [200, 120, 40];
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : (x & 1) === 0 ? 1 : 2;
      const d = Math.hypot(x - cx, y - cy);
      data[y * w + x] = d < core ? 255 : d < r ? rgb[c] : 0;
    }
  return { width: w, height: h, planes: 1, bitDepth: 8, colorId: SerColor.BAYER_RGGB, data };
}
const header = { luId: 0, colorId: SerColor.BAYER_RGGB, littleEndianFlag: 0, observer: "", instrument: "", telescope: "", dateTime: 0n, dateTimeUtc: 0n, bitDepth: 8 };

async function serOf(frames: Frame[]) {
  const w = new SerWriter({ ...header, width: frames[0].width, height: frames[0].height });
  frames.forEach((f, i) => w.add(f, BigInt(i + 1)));
  return SerReader.open(w.toBlob());
}

describe("Bilder bearbeiten in der Verarbeitung", () => {
  const base = { ...defaultOptions, cropWidth: 48, cropHeight: 32, minObjectSize: 10, qualityEnabled: false };

  it("SER: Spiegeln hält Bayer-Rohdaten mit neuem Muster, Drehen tauscht Breite und Höhe", async () => {
    const r = await serOf([bayerDisc(120, 100, 47.3, 41.8, 12), bayerDisc(120, 100, 70.6, 55.2, 12)]);
    const flipped = await SerReader.open((await processSer(r, { ...base, flipH: true })).blob);
    expect(flipped.header.colorId).toBe(SerColor.BAYER_GRBG);
    expect([flipped.header.width, flipped.header.height]).toEqual([48, 32]);
    const rotated = await SerReader.open((await processSer(r, { ...base, rotate: 90 })).blob);
    expect([rotated.header.width, rotated.header.height, rotated.header.colorId]).toEqual([32, 48, SerColor.BAYER_GRBG]);
    // Lage der Scheibe: genau wie im ungedrehten Ausschnitt, um 90° im Uhrzeigersinn gedreht
    const plain = await SerReader.open((await processSer(r, base)).blob);
    const d0 = detectObject(toLum(await plain.readFrame(1), true));
    const d = detectObject(toLum(await rotated.readFrame(1), true));
    expect(d.cx).toBeCloseTo(31 - d0.cy, 1);
    expect(d.cy).toBeCloseTo(d0.cx, 1);
  });

  it("SER: Graustufen und Grösse ergeben Mono bzw. Farbe in neuer Grösse", async () => {
    const r = await serOf([bayerDisc(120, 100, 50, 50, 12)]);
    const mono = await SerReader.open((await processSer(r, { ...base, mono: true })).blob);
    expect([mono.header.colorId, mono.header.width]).toEqual([SerColor.MONO, 48]);
    const half = await processSer(r, { ...base, resizePercent: 50 });
    const out = await SerReader.open(half.blob);
    expect([out.header.colorId, out.header.width, out.header.height]).toEqual([SerColor.RGB, 24, 16]);
    expect([half.report.outWidth, half.report.outHeight]).toEqual([24, 16]);
    expect((await out.readFrame(0)).data.length).toBe(24 * 16 * 3);
  });

  it("Farbkennung der SER-Ausgabe passt zu den Bildern", () => {
    const src = { colorId: SerColor.BAYER_RGGB };
    expect(outputColorId({ ...defaultOptions }, src, 48, 32)).toBe(SerColor.BAYER_RGGB);
    expect(outputColorId({ ...defaultOptions, flipV: true }, src, 48, 32)).toBe(SerColor.BAYER_GBRG);
    expect(outputColorId({ ...defaultOptions, flipV: true, debayerSer: true }, src, 48, 32)).toBe(SerColor.RGB);
    expect(outputColorId({ ...defaultOptions, flipV: true }, src, 47, 32)).toBe(SerColor.RGB); // ungerade
    expect(outputColorId({ ...defaultOptions, flipV: true, debayer: "RGGB" }, src, 48, 32)).toBe(SerColor.RGB); // festes Muster
    expect(outputColorId({ ...defaultOptions, flipV: true, debayer: "off" }, src, 48, 32)).toBe(SerColor.BAYER_GBRG);
    expect(outputColorId({ ...defaultOptions, mono: true, debayer: "off" }, src, 48, 32)).toBe(SerColor.MONO);
    expect(outputColorId({ ...defaultOptions, mono: true }, { colorId: SerColor.RGB, planes: 3 })).toBe(SerColor.MONO);
  });
});

describe("Überbelichtete Bilder verwerfen", () => {
  const o = { ...defaultOptions, minObjectSize: 10, rejectOverexposed: true, overexposedLimit: 1 };

  it("Anteil gesättigter Pixel an der Objektfläche", () => {
    const det = detectObject(toLum(bayerDisc(120, 100, 60, 50, 20, 8), true));
    // Kern mit Radius 8 in Scheibe mit Radius 20: etwa (8-1)²/20² ≈ 12 %
    expect(det.overexposedObject!).toBeGreaterThan(0.08);
    expect(det.overexposedObject!).toBeLessThan(0.2);
    expect(detectObject(toLum(bayerDisc(120, 100, 60, 50, 20), true)).overexposedObject).toBe(0);
  });

  it("verwirft nur, wenn eingeschaltet und über der Grenze; Totalität ausgenommen", async () => {
    const r = await serOf([bayerDisc(120, 100, 60, 50, 20), bayerDisc(120, 100, 60, 50, 20, 8), bayerDisc(120, 100, 60, 50, 20, 2)]);
    const { report } = await processSer(r, { ...o, qualityEnabled: false });
    expect(report.frames.map((f) => f.accepted)).toEqual([true, false, true]);
    expect(report.frames[1].reason).toMatch(/overexposed\|\d+/); // Meldung mit Prozentwert
    expect((await processSer(r, { ...o, rejectOverexposed: false })).report.written.length).toBe(3);
    expect((await processSer(r, { ...o, overexposedLimit: 50 })).report.written.length).toBe(3);
    expect((await processSer(r, { ...o, checkObject: false })).report.written.length).toBe(3);
    const det = { ...detectObject(toLum(bayerDisc(120, 100, 60, 50, 20, 8), true)), disc: { cx: 60, cy: 50, r: 20, visibleLimb: 1, rms: 0.3, kind: "moon" as const } };
    expect(judge(0, det, { ...o, centreMode: "disc" }).accepted).toBe(true);
    expect(judge(0, { ...det, disc: { ...det.disc, kind: "sun" } }, { ...o, centreMode: "disc" }).accepted).toBe(false);
  });
});
