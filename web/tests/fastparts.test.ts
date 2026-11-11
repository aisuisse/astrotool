import { describe, expect, it } from "vitest";
import { ImageSequenceSource, type DecodedImage, type ImageDecoder } from "../src/engine/source";
import { cropFrame } from "../src/engine/image";
import { defaultOptions, processSource, type ProcessOptions } from "../src/engine/pipeline";
import type { Frame } from "../src/engine/ser";

type Pic = { width: number; height: number; rgba: Uint8ClampedArray };

/** Dekoder mit Teilansichten über fertige Bilder (wie der Browser: verkleinert oder Ausschnitt) */
function partsDecoder(pics: Map<Blob, Pic>, counter?: { full: number; parts: number }): ImageDecoder {
  const dec: ImageDecoder = async (file, _raw, part): Promise<DecodedImage> => {
    const p = pics.get(file)!;
    if (!part) {
      if (counter) counter.full++;
      return { ...p };
    }
    if (counter) counter.parts++;
    if ("scale" in part) {
      const w = Math.max(1, Math.round(p.width / part.scale)), h = Math.max(1, Math.round(p.height / part.scale));
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          // Mittel über das Feld
          const x0 = Math.floor((x * p.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * p.width) / w));
          const y0 = Math.floor((y * p.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * p.height) / h));
          for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += p.rgba[(yy * p.width + xx) * 4 + c];
            rgba[(y * w + x) * 4 + c] = s / ((x1 - x0) * (y1 - y0));
          }
        }
      return { width: w, height: h, rgba, fullWidth: p.width, fullHeight: p.height };
    }
    const rgba = new Uint8ClampedArray(part.w * part.h * 4);
    for (let y = 0; y < part.h; y++) rgba.set(p.rgba.subarray(((part.y + y) * p.width + part.x) * 4, ((part.y + y) * p.width + part.x + part.w) * 4), y * part.w * 4);
    return { width: part.w, height: part.h, rgba, fullWidth: p.width, fullHeight: p.height };
  };
  dec.parts = true;
  return dec;
}

/** Sonne (mit Mond davor) vor dunklem Himmel als RGBA */
function sunPic(w: number, h: number, sun: { cx: number; cy: number; r: number }, moon?: { cx: number; cy: number; r: number }, sky = 12): Pic {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const edge = (d: number) => 1 / (1 + Math.exp(d / 0.6));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = edge(Math.hypot(x - sun.cx, y - sun.cy) - sun.r);
      if (moon) v *= 1 - edge(Math.hypot(x - moon.cx, y - moon.cy) - moon.r);
      const o = (y * w + x) * 4;
      rgba[o] = sky + v * 220;
      rgba[o + 1] = sky + v * 200;
      rgba[o + 2] = sky + v * 150;
      rgba[o + 3] = 255;
    }
  return { width: w, height: h, rgba };
}

async function sourceOf(pics: Pic[], counter?: { full: number; parts: number }, parts = true) {
  const map = new Map<Blob, Pic>();
  const files = pics.map((p, i) => {
    const file = new Blob([`bild ${i}`]);
    map.set(file, p);
    return { file, name: `IMG_${String(i).padStart(3, "0")}.jpg` };
  });
  const dec = partsDecoder(map, counter);
  if (!parts) dec.parts = false;
  return ImageSequenceSource.open(files, dec, { mainCamera: true });
}

const same = (a: Frame, b: Frame) => a.width === b.width && a.height === b.height && a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);

describe("Teilansichten einer Fotoserie", () => {
  it("Ausschnitt = ganzes Bild lesen und zuschneiden (auch über den Rand hinaus)", async () => {
    const src = await sourceOf([sunPic(400, 300, { cx: 150, cy: 120, r: 40 }), sunPic(400, 300, { cx: 390, cy: 10, r: 40 })]);
    expect(src.hasParts).toBe(true);
    for (const i of [0, 1])
      for (const [x, y, w, h] of [[0, 0, 400, 300], [100, 60, 120, 110], [-50, -40, 200, 150], [300, 200, 200, 200], [-500, 0, 100, 100]])
        expect(same(await src.readRegion(i, x, y, w, h), cropFrame(await src.readFrame(i), x, y, w, h))).toBe(true);
  });

  it("kleineres Foto (Handy-Ausschnitt): mittig im Bildfeld, Rand in der Himmelsfarbe", async () => {
    const src = await sourceOf([sunPic(400, 300, { cx: 150, cy: 120, r: 40 }), sunPic(200, 150, { cx: 100, cy: 75, r: 40 }, undefined, 30)]);
    expect([src.width, src.height]).toEqual([400, 300]);
    for (const [x, y, w, h] of [[0, 0, 400, 300], [60, 40, 250, 200], [-20, -20, 150, 150], [250, 180, 300, 300]])
      expect(same(await src.readRegion(1, x, y, w, h), cropFrame(await src.readFrame(1), x, y, w, h))).toBe(true);
    // Rand: Himmelsfarbe des kleinen Fotos, nicht schwarz
    const f = await src.readRegion(1, 0, 0, 50, 50);
    expect([f.data[0], f.data[1], f.data[2]]).toEqual([30, 30, 30]);
    const { frame, scale } = await src.readPreview(1, 100);
    expect(scale).toBe(4);
    expect([frame.width, frame.height]).toEqual([100, 75]);
    expect(frame.data[0]).toBe(30);
    // Mitte der verkleinerten Ansicht: Sonne
    expect(frame.data[(37 * 100 + 50) * 3]).toBeGreaterThan(200);
  });
});

describe("Schnelle Analyse", () => {
  const easy: ProcessOptions = {
    ...defaultOptions, checkObject: true, minObjectSize: 50, centre: true, centreMode: "disc", cropEnabled: true, cropAuto: true,
    strictSun: true, matchSize: true, qualityEnabled: false, rejectBlurred: true,
  };
  // Sonne wandert durchs Bild, der Mond zieht davor vorbei; ein Bild ohne Sonne, eines mit Sonne am Rand
  const W = 2400, H = 1600, r = 110;
  const pics = [0, 1, 2, 3, 4, 5].map((k) => sunPic(W, H, { cx: 500 + 290.3 * k, cy: 400 + 141.7 * k, r }, { cx: 500 + 290.3 * k + 150 - 40 * k, cy: 400 + 141.7 * k - 60 + 10 * k, r: 114 }));
  pics.push(sunPic(W, H, { cx: -5000, cy: -5000, r }));
  pics.push(sunPic(W, H, { cx: W - 60, cy: 900, r }));

  it("gleiche Sonnenlage und gleiche Ausgabe wie die Analyse am ganzen Bild – ohne ein Foto ganz auszulesen", async () => {
    const run = async (fastAnalyse: boolean) => {
      const counter = { full: 0, parts: 0 };
      const src = await sourceOf(pics, counter);
      counter.full = 0;
      const out: Frame[] = [];
      const rep = await processSource(src, { ...easy, fastAnalyse }, (f) => { out.push(f); });
      return { rep, out, counter };
    };
    const slow = await run(false), fast = await run(true);
    expect(slow.counter.full).toBeGreaterThan(pics.length);
    expect(fast.counter.full).toBe(0);
    expect(fast.rep.frames.map((f) => f.accepted)).toEqual(slow.rep.frames.map((f) => f.accepted));
    expect(fast.rep.frames.map((f) => f.reason?.split("|")[0])).toEqual(slow.rep.frames.map((f) => f.reason?.split("|")[0]));
    expect(slow.rep.frames.filter((f) => f.accepted).length).toBe(7);
    for (let i = 0; i < pics.length; i++) {
      const a = slow.rep.frames[i].det.disc, b = fast.rep.frames[i].det.disc;
      if (!a || !slow.rep.frames[i].accepted) continue;
      expect(b).toBeDefined();
      expect(Math.hypot(a.cx - b!.cx, a.cy - b!.cy)).toBeLessThan(0.15);
      expect(Math.abs(a.r - b!.r)).toBeLessThan(0.15);
      expect(!!a.moon).toBe(!!b!.moon);
      if (a.moon) expect(Math.hypot(a.moon.cx - b!.moon!.cx, a.moon.cy - b!.moon!.cy)).toBeLessThan(0.5);
    }
    expect([fast.rep.outWidth, fast.rep.outHeight]).toEqual([slow.rep.outWidth, slow.rep.outHeight]);
    expect(fast.out.length).toBe(slow.out.length);
    // Ausgabe: gleiche Grösse; Bildpunkte fast gleich (Unterschied nur, wo die Sonnenmitte anders gerundet wurde)
    let diff = 0, n = 0;
    for (let k = 0; k < fast.out.length; k++) {
      expect([fast.out[k].width, fast.out[k].height]).toEqual([slow.out[k].width, slow.out[k].height]);
      for (let i = 0; i < fast.out[k].data.length; i += 7) { diff += Math.abs(fast.out[k].data[i] - slow.out[k].data[i]); n++; }
    }
    expect(diff / n).toBeLessThan(1);
  }, 60_000); // grosse Bilder: auf langsamen Rechnern (Build-Server) mehr als die üblichen 5 s

  it("Blick in die Analyse: jedes Foto einmal, verkleinert, mit dem Ergebnis der Prüfung", async () => {
    const src = await sourceOf(pics);
    const seen: { index: number; w: number; h: number; scale: number; ok: boolean; x?: number; y?: number; r?: number }[] = [];
    const rep = await processSource(src, { ...easy, fastAnalyse: true }, () => {}, () => {}, () => false, ({ index, small, scale, result }) => {
      const d = result.det.disc;
      seen.push({ index, w: small.width, h: small.height, scale, ok: result.accepted, x: d?.cx, y: d?.cy, r: d?.r });
    });
    expect(seen.map((s) => s.index)).toEqual(pics.map((_, i) => i));
    for (const s of seen) {
      expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(800);
      expect(s.scale).toBe(W / s.w);
    }
    // das Bild ohne Sonne ist schon hier verworfen; die anderen zeigen die Sonne an der richtigen Stelle
    expect(seen[6].ok).toBe(false);
    for (const k of [0, 1, 2, 3, 4, 5]) {
      expect(seen[k].ok).toBe(true);
      expect(Math.hypot(seen[k].x! - (500 + 290.3 * k), seen[k].y! - (400 + 141.7 * k))).toBeLessThan(1.5);
      expect(Math.abs(seen[k].r! - r)).toBeLessThan(1.5);
    }
    expect(rep.frames.length).toBe(pics.length);
  }, 60_000);

  it("ohne Teilansichten gibt es keinen Blick in die Analyse – das Ergebnis bleibt gleich", async () => {
    const src = await sourceOf(pics.slice(0, 3), undefined, false);
    let calls = 0;
    const rep = await processSource(src, { ...easy, fastAnalyse: true }, () => {}, () => {}, () => false, () => { calls++; });
    expect(calls).toBe(0);
    expect(rep.written.length).toBe(3);
  });

  it("Quelle ohne Teilansichten: wie gewohnt", async () => {
    const counter = { full: 0, parts: 0 };
    const src = await sourceOf(pics.slice(0, 3), counter, false);
    expect(src.hasParts).toBe(false);
    const rep = await processSource(src, { ...easy, fastAnalyse: true }, () => {});
    expect(rep.written.length).toBe(3);
    expect(counter.parts).toBe(0);
  });
});
