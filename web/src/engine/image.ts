// Grundlegende Bildoperationen auf Frames. Keine DOM-Abhängigkeit (läuft im Worker und in Node-Tests).
import type { Frame } from "./ser";
import { isBayer } from "./ser";

/** Helligkeitsbild 0..1 (Float32). Bayer-Rohdaten werden unverändert als Helligkeit genommen. */
export interface Lum {
  width: number;
  height: number;
  data: Float32Array;
}

export function maxValueFor(bitDepth: number): number {
  return (1 << bitDepth) - 1;
}

/**
 * Helligkeitsbild. Mit bayer = true wird das Farbmosaik einer Farbkamera mit dem 3×3-Binomialfilter
 * [1 2 1; 2 4 2; 1 2 1]/16 geglättet: Jedes Fenster enthält dann R/4 + G/2 + B/4, unabhängig von der Position.
 * So verschwindet das Schachbrett-Muster (stört Erkennung und Schärfemass) ohne Verschiebung des Bildes.
 */
export function toLum(f: Frame, bayer = false): Lum {
  if (bayer && f.planes === 1) return bayerLum(f);
  const n = f.width * f.height;
  const out = new Float32Array(n);
  const scale = 1 / maxValueFor(f.bitDepth);
  const d = f.data;
  if (f.planes === 1) {
    for (let i = 0; i < n; i++) out[i] = Math.min(1, d[i] * scale);
  } else {
    const s3 = scale / 3;
    for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = Math.min(1, (d[j] + d[j + 1] + d[j + 2]) * s3);
  }
  return { width: f.width, height: f.height, data: out };
}

function bayerLum(f: Frame): Lum {
  const { width: w, height: h, data: d } = f;
  const scale = 1 / (16 * maxValueFor(f.bitDepth));
  const tmp = new Float32Array(w * h);
  // waagrecht [1 2 1], Rand gespiegelt (gleiche Farbe liegt 2 Pixel weiter, Nachbar hat die andere Farbe → x±1 spiegeln)
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? d[r + x - 1] : d[r + Math.min(1, w - 1)];
      const rr = x < w - 1 ? d[r + x + 1] : d[r + Math.max(0, w - 2)];
      tmp[r + x] = l + 2 * d[r + x] + rr;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : Math.min(1, h - 1)) * w;
    const dn = (y < h - 1 ? y + 1 : Math.max(0, h - 2)) * w;
    const r = y * w;
    for (let x = 0; x < w; x++) out[r + x] = Math.min(1, (tmp[up + x] + 2 * tmp[r + x] + tmp[dn + x]) * scale);
  }
  return { width: w, height: h, data: out };
}

/** Otsu-Schwelle auf 256 Klassen. Liefert einen Wert 0..1. */
export function otsuThreshold(l: Lum): number {
  const hist = new Float64Array(256);
  const d = l.data;
  for (let i = 0; i < d.length; i++) hist[Math.min(255, (d[i] * 255) | 0)]++;
  const total = d.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestT = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return (bestT + 0.5) / 255;
}

export interface Detection {
  found: boolean;
  cx: number;
  cy: number;
  /** Begrenzungsrahmen des Objekts (inklusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Grösste Ausdehnung in Pixel. */
  size: number;
  threshold: number;
  maxValue: number;
  touchesEdge: boolean;
  /** Anteil Pixel nahe Sättigung (≥ 0.99) am ganzen Bild. */
  overexposed: number;
  /** Anteil gesättigter Pixel an der Objektfläche (über der Schwelle) – für „überbelichtete Bilder verwerfen“. */
  overexposedObject?: number;
}

export interface DetectOptions {
  /** Schwelle 0..1; undefined = automatisch (Otsu). */
  threshold?: number;
  /** Zeilen/Spalten mit weniger Pixeln über der Schwelle zählen nicht zum Objekt (Hotpixel-Schutz). */
  minLineCount?: number;
}

/** Findet ein helles Objekt (Planet, Mond, Sonne) und den Schwerpunkt seiner Fläche über der Schwelle. */
export function detectObject(l: Lum, opts: DetectOptions = {}): Detection {
  const { width: w, height: h, data: d } = l;
  const thr = opts.threshold ?? otsuThreshold(l);
  const minLine = opts.minLineCount ?? 2;
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  let sw = 0, sx = 0, sy = 0, max = 0, over = 0, overObj = 0;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const v = d[r + x];
      if (v > max) max = v;
      if (v >= 0.99) over++;
      if (v > thr) {
        if (v >= 0.99) overObj++;
        // Geometrischer Schwerpunkt der Scheibe: helle Wolkenbänder verschieben ihn nicht.
        sw++;
        sx += x;
        sy += y;
        rows[y]++;
        cols[x]++;
      }
    }
  }
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w && cols[x0] < minLine) x0++;
  while (x1 >= 0 && cols[x1] < minLine) x1--;
  while (y0 < h && rows[y0] < minLine) y0++;
  while (y1 >= 0 && rows[y1] < minLine) y1--;
  const found = sw > 0 && x1 >= x0 && y1 >= y0;
  const size = found ? Math.max(x1 - x0 + 1, y1 - y0 + 1) : 0;
  return {
    found,
    cx: found ? sx / sw : w / 2,
    cy: found ? sy / sw : h / 2,
    x0, y0, x1, y1,
    size,
    threshold: thr,
    maxValue: max,
    touchesEdge: found && (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1),
    overexposed: over / d.length,
    overexposedObject: sw > 0 ? overObj / sw : 0,
  };
}

/** Linke obere Ecke eines Ausschnitts um (cx, cy). Bei Bayer-Daten gerade, damit das Muster erhalten bleibt. */
export function cropOrigin(cx: number, cy: number, cw: number, ch: number, colorId: number, forceEven = false): [number, number] {
  let x = Math.round(cx - cw / 2);
  let y = Math.round(cy - ch / 2);
  if (forceEven || isBayer(colorId)) {
    x &= ~1;
    y &= ~1;
  }
  return [x, y];
}

/** Schneidet einen Ausschnitt aus. Bereiche ausserhalb des Bildes werden schwarz aufgefüllt. */
export function cropFrame(f: Frame, x0: number, y0: number, cw: number, ch: number): Frame {
  const p = f.planes;
  const out = f.data instanceof Uint16Array ? new Uint16Array(cw * ch * p) : new Uint8Array(cw * ch * p);
  for (let y = 0; y < ch; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= f.height) continue;
    const xs = Math.max(0, -x0);
    const xe = Math.min(cw, f.width - x0);
    if (xe <= xs) continue;
    const src = (sy * f.width + x0 + xs) * p;
    out.set(f.data.subarray(src, src + (xe - xs) * p), (y * cw + xs) * p);
  }
  return { ...f, width: cw, height: ch, data: out };
}

export function cropLum(l: Lum, x0: number, y0: number, cw: number, ch: number): Lum {
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= l.height) continue;
    for (let x = 0; x < cw; x++) {
      const sx = x0 + x;
      if (sx >= 0 && sx < l.width) out[y * cw + x] = l.data[sy * l.width + sx];
    }
  }
  return { width: cw, height: ch, data: out };
}

/** Mittelwert-Verkleinerung um einen ganzzahligen Faktor. */
export function downsample(l: Lum, f: number): Lum {
  if (f <= 1) return l;
  const w = Math.floor(l.width / f), h = Math.floor(l.height / f);
  const out = new Float32Array(w * h);
  const inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) {
        const r = (y * f + j) * l.width + x * f;
        for (let i = 0; i < f; i++) s += l.data[r + i];
      }
      out[y * w + x] = s * inv;
    }
  }
  return { width: w, height: h, data: out };
}
