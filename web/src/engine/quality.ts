// Schärfe-/Qualitätsmasse. Eigenständige Implementierung (kein PIPP-Code).
import { downsample, type Lum } from "./image";

export type QualityMethod = "gradient" | "histogram" | "brightness";

export interface QualityOptions {
  method: QualityMethod;
  /** Kleinster/grösster Verkleinerungsfaktor und Schrittweite (wie PIPP: 3 / 5 / 1). */
  qmin: number;
  qmax: number;
  qinc: number;
}

export const defaultQuality: QualityOptions = { method: "gradient", qmin: 3, qmax: 5, qinc: 1 };

/**
 * Gradienten-Mass über mehrere Verkleinerungsstufen.
 * Durch das Verkleinern zählt vor allem Detail mittlerer Grösse, nicht Rauschen.
 * Normiert auf die mittlere Helligkeit, damit wechselnde Transparenz das Ergebnis wenig verfälscht.
 */
export function gradientQuality(l: Lum, o: QualityOptions = defaultQuality): number {
  let total = 0, n = 0;
  for (let f = Math.max(1, o.qmin); f <= Math.max(o.qmin, o.qmax); f += Math.max(1, o.qinc)) {
    const s = downsample(l, f);
    const { width: w, height: h, data: d } = s;
    if (w < 3 || h < 3) continue;
    let g = 0, m = 0;
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const dx = d[i + 1] - d[i];
        const dy = d[i + w] - d[i];
        g += dx * dx + dy * dy;
        m += d[i];
      }
    }
    if (m > 0) {
      total += g / m;
      n++;
    }
  }
  return n ? total / n : 0;
}

export function histogramPeakQuality(l: Lum): number {
  let max = 0;
  for (const v of l.data) if (v > max) max = v;
  return max;
}

export function brightnessQuality(l: Lum): number {
  let s = 0;
  for (const v of l.data) s += v;
  return s / l.data.length;
}

export function quality(l: Lum, o: QualityOptions = defaultQuality): number {
  switch (o.method) {
    case "histogram":
      return histogramPeakQuality(l);
    case "brightness":
      return brightnessQuality(l);
    default:
      return gradientQuality(l, o);
  }
}
