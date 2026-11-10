import { describe, expect, it } from "vitest";
import { defaultOptions, detect, judge, rejectIsolatedRadii, type FrameResult } from "../src/engine/pipeline";
import { movieSeconds } from "../src/engine/timelapse";
import type { Lum } from "../src/engine/image";

/**
 * Mond in der partiellen Phase einer Mondfinsternis: helle Scheibe, ein Teil im Erdschatten (Kreis mit 2.7-fachem
 * Radius, weiche Kante). `umbra` ist die Helligkeit im Schatten: 0 = nicht zu sehen (kurz belichtet).
 */
function moonLum(w: number, h: number, moon: { cx: number; cy: number; r: number }, shadow?: { cx: number; cy: number }, umbra = 0): Lum {
  const data = new Float32Array(w * h);
  const edge = (d: number, soft: number) => 1 / (1 + Math.exp(d / soft));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const disc = edge(Math.hypot(x - moon.cx, y - moon.cy) - moon.r, 0.5);
      const lit = shadow ? 1 - edge(Math.hypot(x - shadow.cx, y - shadow.cy) - 2.7 * moon.r, moon.r * 0.03) : 1;
      data[y * w + x] = 0.02 + disc * (umbra + (0.85 - umbra) * lit);
    }
  return { width: w, height: h, data };
}

const o = { ...defaultOptions, centreMode: "disc" as const, strictSun: true, subject: "moon" as const };

describe("Mondfinsternis: Mondrand finden", () => {
  const moon = { cx: 330, cy: 250, r: 90 };
  it("Vollmond", () => {
    const d = detect(moonLum(640, 480, moon), o).disc!;
    expect(Math.hypot(d.cx - moon.cx, d.cy - moon.cy)).toBeLessThan(0.5);
    expect(Math.abs(d.r - moon.r)).toBeLessThan(0.7);
    expect(d.moon).toBeUndefined();
    expect(d.moonLoose).toBeUndefined();
  });
  it("partielle Phase, Schattenteil nicht zu sehen: der ganze Mondkreis, nicht nur die helle Sichel", () => {
    // Erdschatten deckt gut die Hälfte ab
    const lum = moonLum(640, 480, moon, { cx: moon.cx - 2.7 * 90 - 10, cy: moon.cy + 30 });
    const d = detect(lum, o).disc!;
    expect(Math.hypot(d.cx - moon.cx, d.cy - moon.cy)).toBeLessThan(1.5);
    expect(Math.abs(d.r - moon.r)).toBeLessThan(1.5);
    // keine „Mond vor der Sonne“-Messung wie bei der Sonnenfinsternis
    expect(d.moon).toBeUndefined();
    expect(d.moonLoose).toBeUndefined();
    expect(judge(0, detect(lum, o), o).accepted).toBe(true);
  });
  it("Totalität: dunkelrote Scheibe vor schwarzem Himmel", () => {
    const lum = moonLum(640, 480, moon);
    for (let i = 0; i < lum.data.length; i++) lum.data[i] = 0.01 + (lum.data[i] - 0.02) * 0.2;
    const d = detect(lum, o).disc!;
    expect(Math.abs(d.r - moon.r)).toBeLessThan(1);
  });
  it("Meldung nennt den Mond", () => {
    // heller Himmel über das ganze Bild, kleiner Mond: kein brauchbares Mondfoto
    const lum = moonLum(640, 480, { cx: 500, cy: 100, r: 30 });
    for (let y = 300; y < 480; y++) for (let x = 0; x < 640; x++) lum.data[y * 640 + x] = 0.9;
    const r = judge(0, detect(lum, o), o);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("@noMoon");
  });
});

describe("Mondfinsternis: Zoomstufen", () => {
  const res = (index: number, r: number, rms = 0.8, visibleLimb = 0.4, over = 0): FrameResult => ({
    index, accepted: true, score: 0,
    det: { found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 2 * r, threshold: 0.5, maxValue: 1, touchesEdge: false, overexposed: 0, overexposedObject: over, disc: { cx: 500, cy: 400, r, visibleLimb, rms, kind: "sun" } },
  });
  it("einzelnes sauber gemessenes Foto mit anderem Zoom bleibt (Handy: oft nur ein Foto je Zoomstufe)", () => {
    const rs = [res(0, 415), res(1, 417), res(2, 415), res(3, 848, 2.0, 0.26), res(4, 416), res(5, 414)];
    rejectIsolatedRadii(rs, 12, 0.06, 2, "moon");
    expect(rs.every((r) => r.accepted)).toBe(true);
  });
  it("unsauberer Rand oder überstrahlt: wird verworfen, mit Mond-Meldung", () => {
    const rs = [res(0, 415), res(1, 417), res(2, 415), res(3, 297, 4.4, 0.49), res(4, 600, 1, 0.5, 0.8), res(5, 416), res(6, 414)];
    rejectIsolatedRadii(rs, 12, 0.06, 2, "moon");
    expect(rs.filter((r) => !r.accepted).map((r) => r.index)).toEqual([3, 4]);
    expect(rs[3].reason).toMatch(/^@radiusOutlierMoon\|/);
    expect(rs[4].reason).toMatch(/^@bloomMoon\|/);
  });
  it("Sonne: unverändert – ein Einzelgänger wird verworfen", () => {
    const rs = [res(0, 415), res(1, 417), res(2, 415), res(3, 848, 2.0, 0.26), res(4, 416), res(5, 414)];
    rejectIsolatedRadii(rs);
    expect(rs.filter((r) => !r.accepted).map((r) => r.index)).toEqual([3]);
    expect(rs[3].reason).toMatch(/^@radiusOutlier\|/);
  });
});

describe("Länge des Films", () => {
  it("wenige Fotos: kürzer, mindestens 8 s; viele: die eingestellte Länge", () => {
    const o = { seconds: 24, secondsPerPhoto: 1.5 };
    expect(movieSeconds(4, o)).toBe(8);
    expect(movieSeconds(10, o)).toBe(15);
    expect(movieSeconds(77, o)).toBe(24);
    expect(movieSeconds(4, { seconds: 24 })).toBe(24);
  });
});
