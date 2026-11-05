import { describe, expect, it } from "vitest";
import { detectObject, type Lum } from "../src/engine/image";
import { fitCircle, fitSunDisc } from "../src/engine/limb";
import { readExif, exifTimeMs } from "../src/engine/exif";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Partielle Finsternis: Sonne (sx, sy, R) minus Mond (mx, my, Rm), mit Halo und Rauschen. */
function eclipse(w: number, h: number, sx: number, sy: number, R: number, mx: number, my: number, Rm: number, seed = 1): Lum {
  const rand = rng(seed);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ds = Math.hypot(x - sx, y - sy);
      const dm = Math.hypot(x - mx, y - my);
      const sun = 1 / (1 + Math.exp((ds - R) / 0.7));
      const moon = 1 / (1 + Math.exp((Rm - dm) / 0.7)); // 1 ausserhalb des Mondes
      const halo = 0.25 * Math.exp(-Math.max(0, ds - R) / (R * 0.3));
      d[y * w + x] = Math.min(1, 0.03 + 0.95 * sun * moon + halo * moon * 0.8 + (rand() - 0.5) * 0.02);
    }
  return { width: w, height: h, data: d };
}

/**
 * Sonne mit starkem Randabfall wie beim Smart-Teleskop Vespera (echte Serie Metz 12.08.2026: Mitte 158, Rand 70–90):
 * Helligkeit 0.3 + 0.7·µ^0.8, µ = cos des Winkels zur Sichtlinie. Mond (mx, my, Rm) davor.
 */
function darkLimb(w: number, h: number, sx: number, sy: number, R: number, mx: number, my: number, Rm: number, seed = 1): Lum {
  const rand = rng(seed);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ds = Math.hypot(x - sx, y - sy), dm = Math.hypot(x - mx, y - my);
      const mu = Math.sqrt(Math.max(0, 1 - Math.min(1, ds / R) ** 2));
      const edge = 1 / (1 + Math.exp((ds - R) / 0.8));
      const moon = 1 / (1 + Math.exp((Rm - dm) / 0.8));
      d[y * w + x] = Math.max(0, 0.6 * edge * moon * (0.3 + 0.7 * mu ** 0.8) + (rand() - 0.5) * 0.01);
    }
  return { width: w, height: h, data: d };
}

describe("Sonnenrand-Anpassung", () => {
  it("Kreisanpassung trifft exakte Punkte", () => {
    const xs: number[] = [], ys: number[] = [];
    for (let a = 0; a < 3; a += 0.1) { xs.push(10 + 5 * Math.cos(a)); ys.push(-3 + 5 * Math.sin(a)); }
    const c = fitCircle(xs, ys)!;
    expect(c.cx).toBeCloseTo(10, 6);
    expect(c.cy).toBeCloseTo(-3, 6);
    expect(c.r).toBeCloseTo(5, 6);
  });

  it("findet die Sonnenmitte bei einer Vollscheibe", () => {
    const f = fitSunDisc(eclipse(400, 300, 201.3, 148.7, 90, -500, -500, 10), { random: rng(3) });
    expect(f.found).toBe(true);
    expect(f.cx).toBeCloseTo(201.3, 0);
    expect(f.cy).toBeCloseTo(148.7, 0);
    expect(f.r).toBeGreaterThan(89);
    expect(f.r).toBeLessThan(91.5);
    expect(f.visibleLimb).toBeGreaterThan(0.95);
  });

  it("starker Randabfall: Vollscheibe und Sichel genau, Mondrand nicht als Sonnenrand", () => {
    const full = fitSunDisc(darkLimb(500, 400, 250.6, 199.3, 150, -900, -900, 10), { random: rng(5) });
    expect(Math.hypot(full.cx - 250.6, full.cy - 199.3)).toBeLessThan(0.3);
    expect(Math.abs(full.r - 150)).toBeLessThan(0.6);
    expect(full.visibleLimb).toBeGreaterThan(0.95);
    for (const [mx, my, maxVis] of [[380, 120, 0.85], [300, 170, 0.6]]) {
      const f = fitSunDisc(darkLimb(500, 400, 250.6, 199.3, 150, mx, my, 155, 2), { random: rng(9) });
      expect(Math.hypot(f.cx - 250.6, f.cy - 199.3)).toBeLessThan(0.5);
      expect(Math.abs(f.r - 150)).toBeLessThan(0.8);
      expect(f.visibleLimb).toBeLessThan(maxVis);
      expect(f.visibleLimb).toBeGreaterThan(0.2);
      expect(f.rms).toBeLessThan(0.5);
    }
  });

  for (const [label, mx, my] of [["breite Sichel", 260, 140], ["schmale Sichel", 220, 160]] as const) {
    it(`findet die Sonnenmitte trotz Mond (${label}), Schwerpunkt liegt daneben`, () => {
      const l = eclipse(400, 300, 180.4, 150.2, 90, mx, my, 93);
      const f = fitSunDisc(l, { random: rng(7) });
      expect(f.found).toBe(true);
      expect(Math.hypot(f.cx - 180.4, f.cy - 150.2)).toBeLessThan(0.3);
      expect(Math.abs(f.r - 90)).toBeLessThan(1); // Halo verschiebt den Rand leicht nach aussen
      expect(f.visibleLimb).toBeLessThan(0.8);
      const centroid = detectObject(l);
      expect(Math.hypot(centroid.cx - 180.4, centroid.cy - 150.2)).toBeGreaterThan(10);
    });
  }
});

describe("EXIF", () => {
  it("liest Aufnahmezeit und Kamera aus einem minimalen JPEG", () => {
    // TIFF little-endian: IFD0 mit Model + ExifIFD-Zeiger, ExifIFD mit DateTimeOriginal
    const model = "NX500\0", dt = "2026:08:12 19:33:09\0";
    const tiff = new Uint8Array(200);
    const v = new DataView(tiff.buffer);
    tiff.set([0x49, 0x49, 0x2a, 0x00]); v.setUint32(4, 8, true);
    v.setUint16(8, 2, true);
    // Model (0x0110), ASCII, Wert bei Offset 100
    v.setUint16(10, 0x0110, true); v.setUint16(12, 2, true); v.setUint32(14, model.length, true); v.setUint32(18, 100, true);
    // ExifIFD (0x8769), LONG → 60
    v.setUint16(22, 0x8769, true); v.setUint16(24, 4, true); v.setUint32(26, 1, true); v.setUint32(30, 60, true);
    v.setUint32(34, 0, true);
    v.setUint16(60, 1, true);
    v.setUint16(62, 0x9003, true); v.setUint16(64, 2, true); v.setUint32(66, dt.length, true); v.setUint32(70, 120, true);
    [...model].forEach((c, i) => (tiff[100 + i] = c.charCodeAt(0)));
    [...dt].forEach((c, i) => (tiff[120 + i] = c.charCodeAt(0)));
    const app1 = new Uint8Array(10 + tiff.length);
    const a = new DataView(app1.buffer);
    a.setUint16(0, 0xffe1); a.setUint16(2, 8 + tiff.length);
    app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    app1.set(tiff, 10);
    const jpeg = new Uint8Array(2 + app1.length + 2);
    jpeg.set([0xff, 0xd8]); jpeg.set(app1, 2); jpeg.set([0xff, 0xd9], 2 + app1.length);
    const e = readExif(jpeg.buffer);
    expect(e.model).toBe("NX500");
    expect(e.dateTimeOriginal).toBe("2026:08:12 19:33:09");
    expect(exifTimeMs(e)).toBe(Date.UTC(2026, 7, 12, 19, 33, 9));
  });
});

describe("Radius-Plausibilität über die Serie", () => {
  it("verwirft Frames, deren Sonnenrand stark von den Nachbarn abweicht", async () => {
    const { rejectRadiusOutliers } = await import("../src/engine/pipeline");
    const radii = [260, 261, 259, 262, 400, 260, 258, 245, 243, 242];
    const results = radii.map((r, index) => ({
      index, score: 0, accepted: true,
      det: { found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 0, threshold: 0, maxValue: 1, touchesEdge: false, overexposed: 0,
        disc: { cx: 0, cy: 0, r, visibleLimb: 0.5, rms: 1, kind: "sun" as const } },
    }));
    rejectRadiusOutliers(results);
    expect(results.filter((r) => !r.accepted).map((r) => r.index)).toEqual([4]);
  });

  it("grobe Ausreisser verfälschen den Vergleich mit den Nachbarn nicht (Diamantring hinter Wolken)", async () => {
    const { rejectRadiusOutliers } = await import("../src/engine/pipeline");
    // zwei riesige Fehlfits direkt neben einem richtigen Bild: ohne den Serien-Median zöge der lokale Median hoch
    const radii = [236, 236, 235, 236, 737, 783, 236, 235, 236, 234, 236, 235];
    const results = radii.map((r, index) => ({
      index, score: 0, accepted: true,
      det: { found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 0, threshold: 0, maxValue: 1, touchesEdge: false, overexposed: 0,
        disc: { cx: 0, cy: 0, r, visibleLimb: 0.5, rms: 1, kind: "sun" as const } },
    }));
    rejectRadiusOutliers(results);
    expect(results.filter((r) => !r.accepted).map((r) => r.index)).toEqual([4, 5]);
  });
});

describe("Fast schwarze Bilder (Wolken, zu dichter Filter)", () => {
  const det = (maxValue: number, disc?: { r: number; rms: number }) => ({
    found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 400, threshold: 0, maxValue, touchesEdge: false, overexposed: 0,
    disc: disc && { cx: 0, cy: 0, r: disc.r, visibleLimb: 0.4, rms: disc.rms, kind: "sun" as const },
  });
  it("nennt „zu dunkel“ statt „Rand nicht gefunden“ und verwirft unsichere Fits", async () => {
    const { judge, defaultOptions } = await import("../src/engine/pipeline");
    const o = { ...defaultOptions, centreMode: "disc" as const, centre: true, checkObject: true, minObjectSize: 50 };
    expect(judge(0, det(0.05), o).reason).toBe("@tooDark");
    expect(judge(0, det(0.5), o).reason).toBe("@noLimb");
    expect(judge(0, det(0.06, { r: 124, rms: 2.8 }), o).reason).toBe("@tooDark");
    // dunkel, aber sauber gefittet (z. B. schmale Sichel mit dichtem Filter): bleibt
    expect(judge(0, det(0.06, { r: 236, rms: 0.6 }), o).accepted).toBe(true);
    expect(judge(0, det(0.5, { r: 236, rms: 2.5 }), o).accepted).toBe(true);
  });
});
