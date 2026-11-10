import { describe, expect, it } from "vitest";
import { blendFrames, canSynth, fillMoonTrack, limbWidth, planMovie, refineMoon, synthFrame, type MovieFrame, type Rgba } from "../src/engine/eclipsemovie";
import { autoCropSize, defaultOptions, detect, judge, rejectBlurred, rejectIsolatedRadii, type FrameResult } from "../src/engine/pipeline";
import type { Lum } from "../src/engine/image";

/** Sonnenscheibe (hell) vor dunklem Himmel, Rand weichgezeichnet über etwa `blur` Pixel, optional mit Mond davor */
function sunLum(w: number, h: number, sun: { cx: number; cy: number; r: number }, blur: number, moon?: { cx: number; cy: number; r: number }): Lum {
  const data = new Float32Array(w * h);
  const edge = (d: number) => 1 / (1 + Math.exp(d / Math.max(0.2, blur / 3)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0.05 + 0.85 * edge(Math.hypot(x - sun.cx, y - sun.cy) - sun.r);
      if (moon) v = 0.05 + (v - 0.05) * (1 - edge(Math.hypot(x - moon.cx, y - moon.cy) - moon.r));
      data[y * w + x] = v;
    }
  return { width: w, height: h, data };
}

describe("Schärfe am Sonnenrand", () => {
  const sun = { cx: 100, cy: 100, r: 60 };
  it("misst breitere Ränder bei unscharfen Bildern", () => {
    const sharp = limbWidth(sunLum(200, 200, sun, 1), sun)!;
    const soft = limbWidth(sunLum(200, 200, sun, 6), sun)!;
    expect(sharp).toBeLessThan(2);
    expect(soft).toBeGreaterThan(2.5 * sharp);
  });
  it("lässt vom Mond verdeckte Stellen aus", () => {
    const moon = { cx: 130, cy: 100, r: 62 };
    const w = limbWidth(sunLum(200, 200, sun, 1, moon), sun, moon);
    expect(w).not.toBeNull();
    expect(w!).toBeLessThan(2);
  });
});

/** Ergebnis wie aus Durchlauf 1: Sonnenscheibe mit Randbreite */
const res = (index: number, r: number, limbWidth: number, kind: "sun" | "moon" = "sun"): FrameResult => ({
  index, accepted: true, score: 0,
  det: { found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 2 * r, threshold: 0.5, maxValue: 1, touchesEdge: false, overexposed: 0, disc: { cx: 500, cy: 400, r, visibleLimb: 1, rms: 1, kind, limbWidth } },
});

describe("Verwackelte Bilder verwerfen", () => {
  it("verwirft Bilder mit viel breiterem Rand als die Nachbarn", () => {
    const rs = [2, 2.2, 1.9, 2.1, 7, 2, 2.3, 2.0].map((w, i) => res(i, 200, w));
    rejectBlurred(rs, null);
    expect(rs.filter((r) => !r.accepted).map((r) => r.index)).toEqual([4]);
    expect(rs[4].reason).toMatch(/^@blurred\|/);
  });
  it("überbelichtete Serie: alle Ränder breit – nichts verwerfen, nur Abweichler", () => {
    const rs = [8.6, 9.0, 8.4, 12.5, 8.7, 8.2, 8.9].map((w, i) => res(i, 260, w));
    rejectBlurred(rs, null);
    expect(rs.every((r) => r.accepted)).toBe(true);
  });
});

describe("Ausschnitt nach Sonnengrösse", () => {
  it("partielle Finsternis: 2.6 Radien, mit Totalität 5 Radien, höchstens Bildgrösse", () => {
    expect(autoCropSize([res(0, 200, 2), res(1, 202, 2), res(2, 198, 2)], 4000, 3000)).toBe(520);
    expect(autoCropSize([res(0, 200, 2), res(1, 204, 2, "moon")], 4000, 3000)).toBe(1000);
    expect(autoCropSize([res(0, 800, 2), res(1, 810, 2, "moon")], 4000, 3000)).toBe(3000);
    expect(autoCropSize([], 4000, 3000)).toBeNull();
  });
});

describe("Zeittreuer Film", () => {
  const sunF = (t: number, dx: number): MovieFrame => ({ t, kind: "sun", sun: { cx: 100, cy: 100, r: 50 }, moon: { cx: 100 + dx, cy: 100, r: 51 } });
  it("unregelmässige Abstände: Film läuft gleichmässig, Lücken werden gerechnet, dichte Bilder ausgedünnt", () => {
    // Mond wandert gleichmässig 0.03 px/s; Fotos mal nach 5 s, mal nach 60 s, eine Lücke von 20 min
    const times = [0, 5, 10, 70, 130, 135, 1335, 1340, 1400];
    const frames = times.map((t) => sunF(t, 90 - 0.03 * t));
    const steps = planMovie(frames, { seconds: 10, totalitySeconds: 8, fps: 30, holdStart: 0, holdEnd: 0 });
    const body = steps.slice(1, -1);
    // Zeit nimmt in gleichen Schritten zu (± ein halber Schritt bei echten Bildern)
    const dts = body.slice(1).map((s, k) => s.t - body[k].t);
    const step = 1400 / 300;
    for (const d of dts) expect(Math.abs(d - step)).toBeLessThan(step);
    expect(steps.length).toBeGreaterThan(290);
    expect(steps.length).toBeLessThan(310);
    // in der grossen Lücke wird gerechnet
    expect(body.filter((s) => s.mode === "synth" && s.t > 135 && s.t < 1335).length).toBeGreaterThan(200);
    // dichte Bilder (5 s Abstand < ein Videobild): nicht jedes einzeln
    expect(new Set(body.filter((s) => s.mode === "real").map((s) => s.a)).size).toBeLessThan(times.length + 1);
  });
  it("Totalität läuft langsamer als die partiellen Phasen", () => {
    const frames: MovieFrame[] = [];
    for (let t = 0; t <= 3600; t += 60) frames.push(sunF(t, 0));
    for (let t = 3620; t <= 3740; t += 10) frames.push({ t, kind: "moon", sun: { cx: 100, cy: 100, r: 50 } });
    for (let t = 3800; t <= 7200; t += 60) frames.push(sunF(t, 0));
    const steps = planMovie(frames, { seconds: 24, totalitySeconds: 8, fps: 30, holdStart: 0, holdEnd: 0 });
    const inTot = steps.filter((s) => s.t >= 3620 && s.t <= 3740).length / 30;
    expect(inTot).toBeGreaterThan(4);
    expect(steps.length / 30).toBeGreaterThan(20);
    expect(steps.length / 30).toBeLessThan(28);
    // in der Totalität wird nicht gerechnet, nur stehen gelassen und kurz überblendet
    expect(steps.filter((s) => s.t > 3620 && s.t < 3740 && s.mode === "synth")).toHaveLength(0);
  });
  it("nur Zwischenbilder, wenn der Mond plausibel weitergezogen ist", () => {
    expect(canSynth(sunF(0, 60), sunF(60, 58))).toBe(true);
    expect(canSynth(sunF(0, 60), sunF(60, 10))).toBe(false); // Sprung: falsch gemessen
    expect(canSynth(sunF(0, 60), { t: 60, kind: "sun", sun: { cx: 100, cy: 100, r: 50 } })).toBe(false);
  });
});

/** RGBA-Bild aus einer Helligkeitsfunktion */
function rgba(w: number, h: number, f: (x: number, y: number) => number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round(255 * f(x, y)), i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

describe("Gerechnete Zwischenbilder", () => {
  const W = 160, sun = { cx: 80, cy: 80, r: 50 };
  const scene = (mx: number) => (x: number, y: number) => {
    const inSun = Math.hypot(x - sun.cx, y - sun.cy) < sun.r, inMoon = Math.hypot(x - mx, y - 80) < 51;
    return inSun && !inMoon ? 0.9 : 0.04;
  };
  const meta = (t: number, mx: number): MovieFrame => ({ t, kind: "sun", sun, moon: { cx: mx, cy: 80, r: 51 }, limbWidth: 0.6 });
  it("Mond steht in der Mitte zwischen den Aufnahmen – kein doppelter Rand wie beim Überblenden", () => {
    const A = rgba(W, W, scene(150)), B = rgba(W, W, scene(110));
    const want = rgba(W, W, scene(130));
    const got = synthFrame(A, B, meta(0, 150), meta(60, 110), 0.5);
    const blend = blendFrames(A, B, 0.5);
    const err = (d: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - want.data[i]); return s / (W * W); };
    expect(err(got)).toBeLessThan(4);
    expect(err(blend)).toBeGreaterThan(3 * err(got));
  });
  it("am Anfang und Ende genau die Aufnahmen", () => {
    const A = rgba(W, W, scene(150)), B = rgba(W, W, scene(110));
    expect(synthFrame(A, B, meta(0, 150), meta(60, 110), 0)).toEqual(A.data);
    expect(synthFrame(A, B, meta(0, 150), meta(60, 110), 1)).toEqual(B.data);
  });
});

describe("Gerechnete Zwischenbilder über grosse Lücken", () => {
  // überstrahlte Sonne mit weichem Rand und Lichtschein, der nach aussen abfällt – auch vor dem Mond
  const W = 240, sun = { cx: 110, cy: 120, r: 70 };
  const scene = (mx: number, glow = 0.5) => {
    // Rand der sichtbaren Sonne als Punkte: Sonnenrand, wo ihn der Mond nicht verdeckt, und Mondrand vor der Sonne
    const edge: number[] = [];
    for (let k = 0; k < 1440; k++) {
      const a = (k * Math.PI) / 720, c = Math.cos(a), si = Math.sin(a);
      const sx = sun.cx + sun.r * c, sy = sun.cy + sun.r * si;
      if (Math.hypot(sx - mx, sy - 120) >= 72) edge.push(sx, sy);
      const qx = mx + 72 * c, qy = 120 + 72 * si;
      if (Math.hypot(qx - sun.cx, qy - sun.cy) <= sun.r) edge.push(qx, qy);
    }
    return (x: number, y: number) => {
      if (Math.hypot(x - sun.cx, y - sun.cy) <= sun.r && Math.hypot(x - mx, y - 120) >= 72) return 1;
      // Lichtschein: fällt mit dem Abstand zur sichtbaren Sonne ab
      let d2 = Infinity;
      for (let i = 0; i < edge.length; i += 2) d2 = Math.min(d2, (x - edge[i]) ** 2 + (y - edge[i + 1]) ** 2);
      return Math.min(1, 0.03 + glow * Math.exp(-Math.sqrt(d2) / 14));
    };
  };
  const meta = (t: number, mx: number): MovieFrame => ({ t, kind: "sun", sun, moon: { cx: mx, cy: 120, r: 72 }, limbWidth: 3 });
  const err = (d: Uint8ClampedArray, want: Rgba) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - want.data[i]); return s / (W * W); };

  it("Mond weit gewandert: Sichel, Rand und Lichtschein stimmen – keine dunklen Flecken, kein Rest des alten Rands", () => {
    // Mond wandert um 70 px (ein Sonnenradius) – weit über der Grenze für das Modell-Verfahren
    const A = rgba(W, W, scene(230)), B = rgba(W, W, scene(160));
    for (const [w, mx] of [[0.25, 212.5], [0.5, 195], [0.75, 177.5]]) {
      const want = rgba(W, W, scene(mx));
      const got = synthFrame(A, B, meta(0, 230), meta(1200, 160), w);
      expect(err(got, want)).toBeLessThan(3);
      expect(err(blendFrames(A, B, w), want)).toBeGreaterThan(2.5 * err(got, want));
      // grösste Abweichung an einer Stelle (Mittel über 5 × 5): keine Flecken – ein Rand, der um 1 px versetzt ist, ergibt etwa 50
      let worst = 0;
      for (let y = 4; y < W - 4; y += 3)
        for (let x = 4; x < W - 4; x += 3) {
          let s = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += got[((y + dy) * W + x + dx) * 4] - want.data[((y + dy) * W + x + dx) * 4];
          worst = Math.max(worst, Math.abs(s) / 25);
        }
      expect(worst).toBeLessThan(60);
    }
  });

  it("verschieden belichtete Fotos: jede Hälfte der Lücke in der Helligkeit ihres Fotos", () => {
    const A = rgba(W, W, scene(230, 0.2)), B = rgba(W, W, scene(160, 0.8));
    const early = synthFrame(A, B, meta(0, 230), meta(1200, 160), 0.2), late = synthFrame(A, B, meta(0, 230), meta(1200, 160), 0.8);
    // Himmel links neben der Sonne (weit weg vom Mond): unverändert wie im jeweiligen Foto
    const i = (120 * W + 25) * 4;
    expect(early[i]).toBe(A.data[i]);
    expect(late[i]).toBe(B.data[i]);
  });

  it("Mondrand am Foto nachmessen: überstrahlt sitzt der sichtbare Rand neben der Messung", () => {
    // sichtbarer Mond: Radius 64 statt 72, um 5 px verschoben
    const N = rgba(W, W, (x, y) => {
      const ds = Math.hypot(x - sun.cx, y - sun.cy) - sun.r, dm = 64 - Math.hypot(x - 165, y - 123);
      return Math.max(ds, dm) <= 0 ? 1 : 0.05;
    });
    const m = refineMoon(N, sun, { cx: 160, cy: 120, r: 72 });
    expect(Math.abs(m.r - 64)).toBeLessThan(2.5);
    expect(Math.hypot(m.cx - 165, m.cy - 123)).toBeLessThan(3);
    // kein Rand zu finden (Mond ausserhalb der Sonne): Vorgabe bleibt
    const far = { cx: 400, cy: 120, r: 72 };
    expect(refineMoon(N, sun, far)).toEqual(far);
  });
});

describe("Mondbahn ergänzen", () => {
  const f = (t: number, dx?: number): MovieFrame => ({ t, kind: "sun", sun: { cx: 100, cy: 100, r: 50 }, moon: dx === undefined ? undefined : { cx: 100 + dx, cy: 100, r: 51 } });
  it("ergänzt fehlende Messungen linear und ersetzt Ausreisser", () => {
    const fr = [f(0, 80), f(60), f(120, 76), f(180, 40), f(240, 72), f(300)];
    fillMoonTrack(fr);
    expect(fr[1].moon!.cx).toBeCloseTo(178, 0);
    expect(fr[3].moon!.cx).toBeCloseTo(174, 0); // Ausreisser 140 ersetzt
    expect(fr[5].moon).toBeUndefined(); // am Ende nicht verlängert
  });
  it("Mond, der die Sonne noch nicht berührt, bleibt weg", () => {
    const fr = [f(0, 110), f(60), f(120, 96)];
    fillMoonTrack(fr);
    expect(fr[1].moon).toBeUndefined();
  });
});

describe("Zoom-Ausgleich (Handy)", () => {
  it("Sonnengrösse darf springen, Einzelgänger werden verworfen", () => {
    // 5 Bilder mit r ≈ 140 (wenig Zoom), dann r ≈ 280, darin ein überstrahltes mit r = 380
    const radii = [140, 143, 138, 141, 145, 280, 282, 380, 279, 284, 281];
    const rs = radii.map((r, i) => res(i, r, 3));
    rejectIsolatedRadii(rs);
    expect(rs.filter((r) => !r.accepted).map((r) => r.index)).toEqual([7]);
  });
});

describe("Ist das die Sonne? (Einfach-Modus)", () => {
  const o = { ...defaultOptions, centreMode: "disc" as const, strictSun: true };
  it("Sonne vor dunklem Himmel: ja", () => {
    const d = detect(sunLum(300, 200, { cx: 150, cy: 100, r: 40 }, 1), o);
    expect(d.disc?.plausible).toBe(true);
  });
  it("sehr grosser Kreis mit unruhigem Rand (helle Fläche, keine Sonne): nein – mit sauberem Rand: ja", () => {
    // helle Scheibe, Radius ein Drittel der kurzen Bildseite; der Rand schwankt um ±10 px (2.5 % des Radius)
    const W = 1600, H = 1200, r0 = 400;
    const blob = (wobble: number): Lum => {
      const data = new Float32Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const dx = x - 800, dy = y - 600, a = Math.atan2(dy, dx);
          const r = r0 + wobble * (Math.sin(7 * a) + 0.6 * Math.sin(13 * a + 1));
          data[y * W + x] = 0.05 + 0.85 / (1 + Math.exp((Math.hypot(dx, dy) - r) / 0.8));
        }
      return { width: W, height: H, data };
    };
    const rough = detect(blob(8), o);
    expect(rough.disc === undefined || rough.disc.plausible === false).toBe(true);
    expect(judge(0, rough, o).accepted).toBe(false);
    const clean = detect(blob(0), o);
    expect(clean.disc?.plausible).toBe(true);
    expect(judge(0, clean, o).accepted).toBe(true);
  });
  it("Landschaft mit hellem Himmel über die ganze Breite: nein", () => {
    const data = new Float32Array(300 * 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) data[y * 300 + x] = y < 90 ? 0.85 + 0.1 * Math.sin(x / 17) : 0.15 + 0.05 * Math.sin(x / 5 + y / 7);
    const d = detect({ width: 300, height: 200, data }, o);
    expect(d.disc === undefined || d.disc.plausible === false).toBe(true);
    expect(judge(0, d, o).accepted).toBe(false);
  });
  it("kleine überstrahlte Sonne im grossen Lichtschein: am gesättigten Kern gemessen", () => {
    const data = new Float32Array(400 * 300);
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 400; x++) {
        const d = Math.hypot(x - 200, y - 150);
        data[y * 400 + x] = d < 20 ? 1 : Math.min(0.9, 0.05 + 0.8 * Math.exp(-((d - 20) / 70)));
      }
    const d = detect({ width: 400, height: 300, data }, o);
    expect(d.disc).toBeDefined();
    expect(d.disc!.r).toBeGreaterThan(17);
    expect(d.disc!.r).toBeLessThan(23);
  });
});

describe("Bildserie mit und ohne Zeitzone", () => {
  it("fehlt die Zeitzone bei einem Teil der Fotos, gilt für alle die Ortszeit der Kamera", async () => {
    const { sameClock } = await import("../src/engine/source");
    const { exifTimeMs } = await import("../src/engine/exif");
    // Aufnahme 19:45 mit Zeitzone +02:00, 20:15 ohne (bearbeiteter Ausschnitt): 30 min auseinander, nicht 2.5 h
    const ex = [{ dateTimeOriginal: "2026:08:12 19:45:00", offsetTimeOriginal: "+02:00" }, { dateTimeOriginal: "2026:08:12 20:15:00" }];
    const entries = ex.map((e) => ({ exif: e, timeMs: exifTimeMs(e) }));
    expect((entries[1].timeMs! - entries[0].timeMs!) / 1000).toBe(9000);
    sameClock(entries);
    expect((entries[1].timeMs! - entries[0].timeMs!) / 1000).toBe(1800);
    expect(entries[0].exif.offsetTimeOriginal).toBeUndefined();
  });
});
