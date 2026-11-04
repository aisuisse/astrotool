// Sonnenscheibe über ihren Rand finden – auch wenn der Mond einen Teil verdeckt.
//
// Ablauf:
// 1. Verkleinern, Schwelle bei halber Höhe zwischen Hintergrund und Scheibe.
// 2. Grösste zusammenhängende helle Fläche, davon die Randpunkte.
// 3. RANSAC: Kreise durch je 3 Randpunkte. Gültig ist nur ein Kreis, der die ganze helle Fläche
//    enthält – so wird der Mondrand (die Sichel liegt ausserhalb des Mondes) nie gewählt.
// 4. Verfeinern: Strahlen vom Mittelpunkt, Schwellen-Durchgang subpixelgenau im Originalbild,
//    Kreis nach kleinsten Quadraten (Kåsa) nur durch Punkte auf dem Sonnenrand.
import { downsample, type Lum } from "./image";

export interface DiscFit {
  found: boolean;
  cx: number;
  cy: number;
  r: number;
  /** Anteil des Sonnenrands, der sichtbar ist (0..1). Bei Vollscheibe ≈ 1. */
  visibleLimb: number;
  /** Mittlere Abweichung der Randpunkte vom Kreis in Pixel */
  rms: number;
  threshold: number;
  /** Begrenzungsrahmen der hellen Fläche */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DiscOptions {
  /** Schwelle 0..1; undefined = halbe Höhe zwischen Hintergrund und Scheibe */
  threshold?: number;
  /** Arbeitsauflösung für die Grobsuche (längere Seite) */
  workSize?: number;
  /** Zufallsquelle (für reproduzierbare Tests) */
  random?: () => number;
}

const notFound = (thr: number): DiscFit => ({ found: false, cx: 0, cy: 0, r: 0, visibleLimb: 0, rms: 0, threshold: thr, x0: 0, y0: 0, x1: 0, y1: 0 });

export function percentile(d: Float32Array, p: number): number {
  const hist = new Uint32Array(1024);
  for (let i = 0; i < d.length; i++) hist[Math.min(1023, (d[i] * 1023) | 0)]++;
  const target = p * d.length;
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += hist[i];
    if (acc >= target) return i / 1023;
  }
  return 1;
}

/** Schwelle bei halber Höhe zwischen Hintergrund (Median) und Scheibe (99.9 %-Wert). */
export function halfMaxThreshold(l: Lum): number {
  const bg = percentile(l.data, 0.5);
  const peak = percentile(l.data, 0.999);
  return bg + (peak - bg) / 2;
}

/** Kreis nach kleinsten Quadraten (Kåsa). */
export function fitCircle(xs: ArrayLike<number>, ys: ArrayLike<number>): { cx: number; cy: number; r: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx, v = ys[i] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const a = 0.5 * (suuu + suvv), b = 0.5 * (svvv + svuu);
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

function circleFrom3(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return null;
  const s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
  const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d;
  const cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d;
  return { cx, cy, r: Math.hypot(x1 - cx, y1 - cy) };
}

/** Grösste 4-zusammenhängende Fläche über der Schwelle als Maske. */
function largestBlob(s: Lum, thr: number): { mask: Uint8Array; count: number } {
  const { width: w, height: h, data } = s;
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0, bestLabel = 0, next = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i] <= thr || label[i]) continue;
    next++;
    let sp = 0, count = 0;
    stack[sp++] = i;
    label[i] = next;
    while (sp) {
      const p = stack[--sp];
      count++;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q >= 0 && q < w * h && !label[q] && data[q] > thr) {
          label[q] = next;
          stack[sp++] = q;
        }
      }
    }
    if (count > best) { best = count; bestLabel = next; }
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (label[i] === bestLabel && bestLabel) mask[i] = 1;
  return { mask, count: best };
}

/** Wert im Originalbild mit bilinearer Interpolation. */
export function sample(l: Lum, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= l.width - 1 || y0 >= l.height - 1) return -1;
  const fx = x - x0, fy = y - y0, i = y0 * l.width + x0, d = l.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + l.width] * (1 - fx) + d[i + l.width + 1] * fx) * fy;
}

export function fitSunDisc(l: Lum, opts: DiscOptions = {}): DiscFit {
  const rand = opts.random ?? seeded(12345);
  const f = Math.max(1, Math.ceil(Math.max(l.width, l.height) / (opts.workSize ?? 1200)));
  const s = downsample(l, f);
  const thr = opts.threshold ?? halfMaxThreshold(s);
  const { mask, count } = largestBlob(s, thr);
  if (count < 30) return notFound(thr);

  // Randpunkte der Fläche (Pixelmitten) und Begrenzungsrahmen
  const w = s.width, h = s.height;
  const ex: number[] = [], ey: number[] = [];
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) {
        ex.push(x + 0.5);
        ey.push(y + 0.5);
      }
    }
  const n = ex.length;
  const extent = Math.max(bx1 - bx0 + 1, by1 - by0 + 1);
  const minR = extent / 4, maxR = Math.hypot(w, h);
  const tol = 1.5;

  // RANSAC mit Enthaltensein-Bedingung
  let best: { cx: number; cy: number; r: number } | null = null, bestScore = 0;
  const iters = 600;
  for (let it = 0; it < iters; it++) {
    const a = (rand() * n) | 0, b = (rand() * n) | 0, c = (rand() * n) | 0;
    if (a === b || b === c || a === c) continue;
    const circ = circleFrom3(ex[a], ey[a], ex[b], ey[b], ex[c], ey[c]);
    if (!circ || circ.r < minR || circ.r > maxR) continue;
    let inl = 0, outside = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(ex[i] - circ.cx, ey[i] - circ.cy) - circ.r;
      if (Math.abs(d) <= tol) inl++;
      else if (d > tol * 2) outside++;
    }
    if (outside > n * 0.02) continue; // helle Fläche ragt aus dem Kreis → Mondrand oder Unsinn
    if (inl > bestScore) { bestScore = inl; best = circ; }
  }
  if (!best || bestScore < 12) return notFound(thr);

  // Grob verfeinern auf Arbeitsauflösung
  {
    const ix: number[] = [], iy: number[] = [];
    for (let i = 0; i < n; i++) if (Math.abs(Math.hypot(ex[i] - best.cx, ey[i] - best.cy) - best.r) <= tol) { ix.push(ex[i]); iy.push(ey[i]); }
    best = fitCircle(ix, iy) ?? best;
  }

  // Fein: Strahlen im Originalbild
  // Arbeitsauflösung → Originalbild. Konvention wie im Rest der Engine: Pixel i hat seine Mitte bei i.
  let cx = best.cx * f - 0.5, cy = best.cy * f - 0.5, r = best.r * f;
  const fullThr = opts.threshold ?? thr;
  // Der Rand ist dort, wo die Helligkeit am steilsten abfällt – nicht dort, wo sie eine Schwelle kreuzt.
  // So verschiebt Dunst oder ein Halo um die Sonne den Rand nicht.
  let visible = 0, rms = 0;
  const step = 0.5;
  for (const winFactor of [0.15, 0.06, 0.03]) {
    const rays = 720;
    const win = Math.max(6, winFactor * r);
    const cand: { x: number; y: number; g: number }[] = [];
    const prof: number[] = [];
    for (let k = 0; k < rays; k++) {
      const ang = (2 * Math.PI * k) / rays, ca = Math.cos(ang), sa = Math.sin(ang);
      prof.length = 0;
      let ok = true;
      for (let t = r + win; t >= r - win; t -= step) {
        const v = sample(l, cx + ca * t, cy + sa * t);
        if (v < 0) { ok = false; break; }
        prof.push(v);
      }
      if (!ok || prof.length < 5) continue;
      // grösster Anstieg nach innen (geglättet über 3 Schritte)
      let best = -1, bestG = 0;
      for (let i = 1; i < prof.length - 2; i++) {
        const g = (prof[i + 2] - prof[i - 1]) / 3;
        if (g > bestG) { bestG = g; best = i; }
      }
      if (best < 2 || best > prof.length - 4) continue;
      // innen muss es hell sein (Sonne, nicht Mond oder Wolke)
      if (prof[Math.min(prof.length - 1, best + 6)] < fullThr) continue;
      const gm = (prof[best + 1] - prof[best - 2]) / 3, gp = (prof[best + 3] - prof[best]) / 3;
      const den = gm - 2 * bestG + gp;
      const sub = den < 0 ? (0.5 * (gm - gp)) / den : 0;
      const t = r + win - (best + 0.5 + Math.max(-0.5, Math.min(0.5, sub))) * step;
      cand.push({ x: cx + ca * t, y: cy + sa * t, g: bestG });
    }
    if (cand.length < 12) break;
    // nur deutliche Kanten; schwache (Dunst, Wolkenränder) verwerfen
    const gSorted = cand.map((c) => c.g).sort((a, b) => a - b);
    const gRef = gSorted[Math.floor(gSorted.length * 0.9)];
    const strong = cand.filter((c) => c.g >= 0.3 * gRef);
    // Ausreisser (Mondrand, Störungen) robust über die Median-Abweichung entfernen
    const res = strong.map((c) => Math.hypot(c.x - cx, c.y - cy) - r);
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    const mad = [...res.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(1, 3 * 1.4826 * mad);
    const keep = strong.filter((_, i) => Math.abs(res[i] - med) <= lim);
    const c = fitCircle(keep.map((p) => p.x), keep.map((p) => p.y));
    if (!c) break;
    ({ cx, cy, r } = c);
    visible = keep.length / rays;
    rms = Math.sqrt(keep.reduce((acc, p) => acc + (Math.hypot(p.x - cx, p.y - cy) - r) ** 2, 0) / keep.length);
  }

  return {
    found: true, cx, cy, r, visibleLimb: visible, rms, threshold: fullThr,
    x0: bx0 * f, y0: by0 * f, x1: (bx1 + 1) * f - 1, y1: (by1 + 1) * f - 1,
  };
}

/** Reproduzierbare Zufallsfolge: gleiches Bild → gleiches Ergebnis. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
