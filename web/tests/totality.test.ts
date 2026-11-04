import { describe, expect, it } from "vitest";
import { toLum } from "../src/engine/image";
import { SerColor, type Frame } from "../src/engine/ser";
import { bracketGroups, fitMoonDisc, fitMoonInPartial, fitSkyModel, mergeHdr } from "../src/engine/totality";
import { fitSunDisc } from "../src/engine/limb";
import { defaultOptions, detect, processSource, rejectSunInsideTotality, type FrameResult, type ProcessOptions } from "../src/engine/pipeline";
import { ImageSequenceSource } from "../src/engine/source";
import { exifApp1, expose, partialImage, totalityRadiance, withExif, type Geometry } from "../scripts/totality-model.mjs";

const W = 360, H = 280;
const EXPOSURES = [0.5, 2, 8, 32, 128];

function rgbaToFrame(rgba: Uint8Array, w = W, h = H): Frame {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = rgba[i * 4];
    data[i * 3 + 1] = rgba[i * 4 + 1];
    data[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width: w, height: h, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
}

const geo = (dx = 0, dy = 0): Geometry => ({ sx: 181.3 + dx, sy: 139.6 + dy, mx: 183.1 + dx, my: 138.2 + dy, R: 60 });
const lumOf = (rgba: Uint8Array) => toLum(rgbaToFrame(rgba));

describe("Totalität: Mondrand", () => {
  const rad = totalityRadiance(W, H, geo());
  for (const e of EXPOSURES) {
    it(`findet die Mondmitte bei Belichtung ${e}`, () => {
      const f = fitMoonDisc(lumOf(expose(rad, W, H, e, 7)));
      expect(f.found).toBe(true);
      expect(Math.hypot(f.cx - 183.1, f.cy - 138.2)).toBeLessThan(0.4);
      // Überbelichtung lässt den Mond etwas kleiner erscheinen (wie auf echten Fotos); die Mitte bleibt genau
      expect(f.r).toBeGreaterThan(61.8 * 0.93);
      expect(f.r).toBeLessThan(61.8 + 1);
      expect(f.visibleLimb).toBeGreaterThan(0.7);
    });
  }

  it("partielle Phase ist keine Totalität", () => {
    const g = { sx: 180, sy: 140, mx: 215, my: 125, R: 60 };
    expect(fitMoonDisc(lumOf(partialImage(W, H, g))).found).toBe(false);
    const o: ProcessOptions = { ...defaultOptions, centreMode: "disc" };
    expect(detect(lumOf(partialImage(W, H, g)), o).disc?.kind).toBe("sun");
    expect(detect(lumOf(expose(rad, W, H, 8)), o).disc?.kind).toBe("moon");
  });

  it("ringförmige Finsternis bleibt am Sonnenrand", () => {
    const g = { sx: 180.4, sy: 140.3, mx: 183, my: 139, R: 60, Rm: 55 };
    const d = detect(lumOf(partialImage(W, H, g)), { ...defaultOptions, centreMode: "disc" });
    expect(d.disc?.kind).toBe("sun");
    expect(Math.hypot(d.disc!.cx - 180.4, d.disc!.cy - 140.3)).toBeLessThan(0.5);
  });
});

describe("Belichtungsreihen", () => {
  const item = (index: number, t: number, exposure: number | undefined, totality = true) => ({ index, timeMs: t * 1000, exposure, totality });
  it("trennt bei wiederholter Belichtung, Pause und partieller Phase", () => {
    const items = [
      item(0, 0, 1, false),
      item(1, 10, 1), item(2, 10.3, 4), item(3, 10.6, 16),
      item(4, 11, 1), item(5, 11.3, 4), item(6, 11.6, 16),
      item(7, 30, 4), item(8, 30.5, 1),
      item(9, 40, 1), // allein
      item(10, 41, undefined),
      item(11, 42, 1), item(12, 42.2, 1),
    ];
    expect(bracketGroups(items)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8]]);
  });
  it("lange Belichtung verlängert die erlaubte Pause", () => {
    expect(bracketGroups([item(0, 0, 1 / 1000), item(1, 0.5, 8), item(2, 11, 1 / 100)])).toEqual([[0, 1, 2]]);
    expect(bracketGroups([item(0, 0, 1 / 1000), item(1, 5, 1 / 100)])).toEqual([]);
  });
});

/** Radiales Profil (Mittelwert über einen kleinen Winkelbereich) im Grünkanal. */
function profile(f: Frame, cx: number, cy: number, r: number, ang = 0.2): number {
  let s = 0, n = 0;
  for (let a = ang - 0.15; a <= ang + 0.15; a += 0.03) {
    const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
    s += f.data[(y * f.width + x) * 3 + 1];
    n++;
  }
  return s / n;
}

describe("HDR", () => {
  it("zeigt innere und äussere Korona zugleich, ohne Überbelichtung", () => {
    const shifts = [[0, 0], [1.4, -0.6], [-0.8, 1.1], [2.2, 0.4], [-1.5, -1.2]];
    const parts = EXPOSURES.map((e, k) => {
      const [dx, dy] = shifts[k];
      return { frame: rgbaToFrame(expose(totalityRadiance(W, H, geo(dx, dy)), W, H, e, k + 1)), exposure: e, dx, dy };
    });
    const out = mergeHdr(parts, { srgb: true });
    const sat = (f: Frame) => { let c = 0; for (let i = 1; i < f.data.length; i += 3) if (f.data[i] >= 250) c++; return c / (f.width * f.height); };
    const cx = 183.1, cy = 138.2, R = 60;
    const radii = [1.12, 1.4, 1.9, 2.6].map((k) => k * R);
    const hdr = radii.map((r) => profile(out, cx, cy, r));
    // fällt nach aussen ab, innen nicht abgeschnitten, aussen noch über dem Himmel
    for (let i = 1; i < hdr.length; i++) expect(hdr[i]).toBeLessThan(hdr[i - 1] - 5);
    expect(hdr[0]).toBeLessThan(250);
    const moon = profile(out, cx, cy, 0.5 * R);
    expect(hdr[3]).toBeGreaterThan(moon + 20);
    expect(sat(out)).toBeLessThan(0.002);
    // Vergleich: das längste Einzelbild ist innen weiss, das kürzeste zeigt aussen nichts
    expect(profile(parts[4].frame, cx, cy, radii[0])).toBeGreaterThanOrEqual(250);
    expect(profile(parts[0].frame, cx, cy, radii[3])).toBeLessThan(0.5 * hdr[3]);
    // Mondrand bleibt scharf: Ausrichtung stimmt
    const m = fitMoonDisc(toLum(out));
    expect(Math.hypot(m.cx - cx, m.cy - cy)).toBeLessThan(0.5);
    expect(m.rms).toBeLessThan(0.6);
  });
});

describe("Heller Himmel mit Verlauf", () => {
  // kurz nach dem 2. Kontakt: Himmel etwa so hell wie die äussere Korona, nach rechts oben heller, bläulich
  const SKY = { sky: 5e-3, skyGrad: [0.5, -0.25] as [number, number], skyCurve: 0.1, skyTint: [0.7, 0.9, 1.3] as [number, number, number] };
  const skyTrue = (x: number, y: number, c: number) => {
    const u = (x - W / 2) / (W / 2), v = (y - H / 2) / (H / 2);
    return SKY.sky * (1 + SKY.skyGrad[0] * u + SKY.skyGrad[1] * v + SKY.skyCurve * u * v) * SKY.skyTint[c];
  };
  const moon = { cx: 183.1, cy: 138.2, r: 1.03 * 60 };

  it("Himmelsmodell trifft den Verlauf trotz Korona-Strahlen (je Farbe)", () => {
    const rad = totalityRadiance(W, H, { ...geo(), ...SKY });
    const sky = fitSkyModel(rad, W, H, 3, moon)!;
    let worst = 0;
    for (let c = 0; c < 3; c++)
      for (let y = 10; y < H; y += 40)
        for (let x = 10; x < W; x += 40) worst = Math.max(worst, Math.abs(sky(x, y, c) - skyTrue(x, y, c)) / (SKY.sky * SKY.skyTint[c]));
    expect(worst).toBeLessThan(0.12);
  });

  it("gleichmässiger Himmel mit Rauschen: kein erfundener Verlauf", () => {
    const rad = totalityRadiance(W, H, { ...geo(), sky: 5e-3 });
    let seed = 3;
    for (let i = 0; i < rad.length; i++) rad[i] += (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 2e-3;
    const sky = fitSkyModel(rad, W, H, 3, moon)!;
    for (let c = 0; c < 3; c++) {
      expect(sky(0, 0, c)).toBeCloseTo(sky(moon.cx, moon.cy, c), 6);
      expect(sky(W, H, c)).toBeCloseTo(sky(moon.cx, moon.cy, c), 6);
      expect(Math.abs(sky(moon.cx, moon.cy, c) - 5e-3 - 3e-5)).toBeLessThan(2e-4);
    }
    expect(fitSkyModel(rad, W, H, 3, { cx: -500, cy: -500, r: 60 })).toBeNull(); // Mond nicht im Bild
  });

  it("HDR: Ergebnis wie ohne Himmel – Hintergrund gleichmässig, Korona unverändert", () => {
    const hdr = (extra: object, withMoon = true) =>
      mergeHdr(EXPOSURES.map((e, k) => ({ frame: rgbaToFrame(expose(totalityRadiance(W, H, { ...geo(), ...extra }), W, H, e, k + 1)), exposure: e, dx: 0, dy: 0 })), { srgb: true, moon: withMoon ? moon : undefined });
    const clean = hdr({ sky: 0 }), bright = hdr(SKY), raw = hdr(SKY, false);
    // mittlere Abweichung (Grün) ausserhalb des Mondes und in den vier Ecken
    const diff = (f: Frame) => {
      let s = 0, n = 0, corner = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (Math.hypot(x - moon.cx, y - moon.cy) < 1.2 * moon.r) continue;
          const d = Math.abs(f.data[(y * W + x) * 3 + 1] - clean.data[(y * W + x) * 3 + 1]);
          s += d; n++;
          if ((x < 20 || x >= W - 20) && (y < 20 || y >= H - 20)) corner = Math.max(corner, d);
        }
      return { mean: s / n, corner };
    };
    const b = diff(bright), r = diff(raw);
    expect(b.mean).toBeLessThan(3);
    expect(b.corner).toBeLessThan(8);
    // Gegenprobe: ohne Abzug deutlich anders
    expect(r.mean).toBeGreaterThan(2 * b.mean);
    expect(r.corner).toBeGreaterThan(15);
  });
});

describe("Finsternis-Serie mit Totalität", () => {
  it("richtet am Mondrand aus und fasst Belichtungsreihen zusammen", async () => {
    const images = new Map<Blob, { width: number; height: number; rgba: Uint8Array }>();
    const files: { file: Blob; name: string }[] = [];
    let n = 0;
    const add = (rgba: Uint8Array, sec: number, exposure: number) => {
      const s = Math.floor(sec), ms = Math.round((sec - s) * 1000);
      const date = `2027:08:02 10:${String(40 + Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      const file = new Blob([withExif(null, exifApp1({ date, subSec: String(ms).padStart(3, "0"), exposure }))]);
      images.set(file, { width: W, height: H, rgba });
      files.push({ file, name: `IMG_${String(++n).padStart(4, "0")}.JPG` });
    };
    // Kamera ohne Nachführung: die Sonne wandert durchs Bild
    const drift = (sec: number) => [sec * 0.12, -sec * 0.05];
    for (const s of [0, 20, 40]) {
      const [dx, dy] = drift(s);
      add(partialImage(W, H, { sx: 181 + dx, sy: 140 + dy, mx: 181 + dx + 30 - s * 0.6, my: 140 + dy, R: 60 }), s, 1 / 1000);
    }
    for (const start of [60, 70]) EXPOSURES.forEach((e, k) => {
      const sec = start + k * 0.4;
      const [dx, dy] = drift(sec);
      add(expose(totalityRadiance(W, H, geo(dx, dy)), W, H, e, start + k), sec, e / 1000);
    });
    for (const s of [100, 120]) {
      const [dx, dy] = drift(s);
      add(partialImage(W, H, { sx: 181 + dx, sy: 140 + dy, mx: 181 + dx - (s - 90) * 0.6, my: 140 + dy, R: 60 }), s, 1 / 1000);
    }
    const src = await ImageSequenceSource.open(files, async (b) => images.get(b)!);
    const o: ProcessOptions = { ...defaultOptions, centreMode: "disc", cropWidth: 300, cropHeight: 240, qualityEnabled: false, minObjectSize: 50, hdr: true };
    const outs: { frame: Frame; index: number }[] = [];
    const rep = await processSource(src, o, (f, r) => { outs.push({ frame: f, index: r.index }); });
    expect(rep.frames.filter((f) => !f.accepted).map((f) => `${f.index}: ${f.reason}`)).toEqual([]);
    expect(rep.frames.map((f) => f.det.disc!.kind)).toEqual([...Array(3).fill("sun"), ...Array(10).fill("moon"), ...Array(2).fill("sun")]);
    expect(rep.hdrGroups).toEqual([[3, 4, 5, 6, 7], [8, 9, 10, 11, 12]]);
    expect(rep.written).toEqual([0, 1, 2, 3, 8, 13, 14]);
    // HDR-Bilder: Mond in der Mitte des Ausschnitts
    for (const k of [3, 4]) {
      const m = fitMoonDisc(toLum(outs[k].frame));
      expect(m.found).toBe(true);
      expect(Math.abs(m.cx - 149.5)).toBeLessThan(1);
      expect(Math.abs(m.cy - 119.5)).toBeLessThan(1);
    }
    // ohne HDR: alle 15 Bilder einzeln
    const rep2 = await processSource(src, { ...o, hdr: false }, () => {});
    expect(rep2.written.length).toBe(15);
    expect(rep2.hdrGroups).toEqual([]);
  });
});

describe("Plausibilität in der Totalität", () => {
  const fr = (index: number, kind: "sun" | "moon"): FrameResult => ({
    index, accepted: true, score: 0,
    det: { found: true, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 0, threshold: 0, maxValue: 1, touchesEdge: false, overexposed: 0, disc: { cx: 0, cy: 0, r: 250, visibleLimb: 1, rms: 1, kind } },
  });
  it("verwirft einen Sonnenrand zwischen zwei Mondrand-Bildern", () => {
    const r = [fr(0, "sun"), fr(1, "moon"), fr(2, "sun"), fr(3, "moon"), fr(4, "sun")];
    rejectSunInsideTotality(r, null);
    expect(r.map((x) => x.accepted)).toEqual([true, true, false, true, true]);
    expect(r[2].reason).toContain("totalityNoMoon");
  });
  it("nicht, wenn die Mondrand-Bilder weit auseinander liegen (zwei Finsternisse)", () => {
    const r = [fr(0, "moon"), fr(1, "sun"), fr(2, "moon")];
    const t = (min: number) => 621_355_968_000_000_000n + BigInt(min * 60) * 10_000_000n;
    rejectSunInsideTotality(r, BigInt64Array.from([t(0), t(30), t(60)]));
    expect(r[1].accepted).toBe(true);
  });
});

describe("Sonnenmitte in der Totalität", () => {
  it("misst den Mond vor der Sonne in der partiellen Phase", () => {
    const g = { sx: 170.3, sy: 141.2, mx: 205.6, my: 128.9, R: 60 };
    const l = lumOf(partialImage(W, H, g));
    const sun = fitSunDisc(l);
    const m = fitMoonInPartial(l, sun, sun.threshold)!;
    expect(m).not.toBeNull();
    expect(Math.hypot(m.cx - 205.6, m.cy - 128.9)).toBeLessThan(0.6);
    expect(Math.abs(m.r - 61.8)).toBeLessThan(1.5);
  });

  it("zentriert die Totalität auf die (verdeckte) Sonne – kein Sprung an den Kontakten", async () => {
    // Mond zieht gleichmässig vor der Sonne vorbei: Abstand d(t) = (0.2 px/s · (66 − t), −0.5 px)
    const T = 66, v = 0.2, base = 300;
    const moonOff = (t: number) => [v * (T - t), -0.5];
    const drift = (t: number) => [t * 0.08, -t * 0.03];
    const images = new Map<Blob, { width: number; height: number; rgba: Uint8Array }>();
    const files: { file: Blob; name: string }[] = [];
    const truth = new Map<number, [number, number]>();
    let n = 0;
    const add = (rgba: Uint8Array, t: number, exposure: number, sun: [number, number]) => {
      const sec = base + t, s0 = Math.floor(sec), ms = Math.round((sec - s0) * 1000);
      const date = `2027:08:02 10:${String(30 + Math.floor(s0 / 60)).padStart(2, "0")}:${String(s0 % 60).padStart(2, "0")}`;
      const file = new Blob([withExif(null, exifApp1({ date, subSec: String(ms).padStart(3, "0"), exposure }))]);
      images.set(file, { width: W, height: H, rgba });
      truth.set(n, sun);
      files.push({ file, name: `IMG_${String(++n).padStart(4, "0")}.JPG` });
    };
    const frame = (t: number, e?: number, k = 0) => {
      const [dx, dy] = drift(t), sx = 180 + dx, sy = 140 + dy, [ox, oy] = moonOff(t);
      const g = { sx, sy, mx: sx - ox, my: sy - oy, R: 60 };
      if (e === undefined) add(partialImage(W, H, g, Math.round(t + 500)), t, 1 / 1000, [sx, sy]);
      else add(expose(totalityRadiance(W, H, g), W, H, e, Math.round(t * 10 + k)), t, e / 1000, [sx, sy]);
    };
    for (const t of [-200, -120, -40]) frame(t);
    EXPOSURES.forEach((e, k) => frame(62 + k * 0.6, e, k));
    for (const t of [170, 250]) frame(t);
    const src = await ImageSequenceSource.open(files, async (b) => images.get(b)!);
    const o: ProcessOptions = { ...defaultOptions, centreMode: "disc", cropWidth: 300, cropHeight: 240, qualityEnabled: false, minObjectSize: 50, hdr: false };
    const rep = await processSource(src, o, () => {});
    const tot = rep.frames.filter((f) => f.det.disc?.kind === "moon");
    expect(tot.length).toBe(5);
    for (const f of tot) {
      const [sx, sy] = truth.get(f.index)!;
      const d = f.det.disc!;
      expect(d.sun).toBeDefined();
      // geschätzte Sonnenmitte auf ≤ 0.6 px; der Mond allein läge bis 1.4 px daneben
      expect(Math.hypot(d.sun!.cx - sx, d.sun!.cy - sy)).toBeLessThan(0.6);
    }
    // abgeschaltet: wie bisher auf den Mond
    const rep2 = await processSource(src, { ...o, totalitySunCentre: false }, () => {});
    expect(rep2.frames.filter((f) => f.det.disc?.sun).length).toBe(0);
  }, 60_000);
});

