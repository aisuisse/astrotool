// Oberflächen-Stabilisierung: Mond- oder Sonnenoberfläche ohne ganzen Rand (Nahaufnahmen, Krater, Flecken,
// Protuberanzen). Jedes Bild wird über die Phasenkorrelation am Referenzbild ausgerichtet:
// 1. auf dem ganzen, verkleinerten Bild (höchstens 256 × 256) – findet auch grosse Verschiebungen,
// 2. bei grossen Bildern (≥ 3× verkleinert) zusätzlich auf einem Ausschnitt von 256 × 256 Pixeln in voller
//    Auflösung um die Bildmitte, falls dort genug Struktur ist.
// Unterpixel-Schätzung: Korrelation auf einem 1/20-Pixel-Gitter direkt aus dem Spektrum.
// Korrelation: Kreuzspektrum F(aktuell) · conj(F(Referenz)), halb normiert (siehe correlate), bandpass-
// gefiltert und zurücktransformiert – das Maximum liegt bei der Verschiebung, seine Höhe (1 = gleiches Bild)
// dient als Sicherheit.
import type { Lum } from "./image";

/** Schnelle Fourier-Transformation (Radix 2, an Ort und Stelle); n Zweierpotenz */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti;
        re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 2-D-FFT eines n × n-Feldes (zeilenweise abgelegt) */
function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const r = new Float64Array(n), i2 = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const row = re.subarray(y * n, y * n + n), rowI = im.subarray(y * n, y * n + n);
    fft(row, rowI, inverse);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { r[y] = re[y * n + x]; i2[y] = im[y * n + x]; }
    fft(r, i2, inverse);
    for (let y = 0; y < n; y++) { re[y * n + x] = r[y]; im[y * n + x] = i2[y]; }
  }
}

/** Feld n × n aus einem Bildausschnitt (w × h ab x0, y0, Faktor f verkleinert): Mittelwert ab, Hann-Fenster */
export function prepare(lum: Lum, x0: number, y0: number, w: number, h: number, f: number, n: number): Float64Array {
  const dw = Math.min(n, Math.floor(w / f)), dh = Math.min(n, Math.floor(h / f));
  const out = new Float64Array(n * n);
  let sum = 0;
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const sy = Math.min(lum.height - 1, Math.max(0, y0 + y * f + yy));
        for (let xx = 0; xx < f; xx++) {
          const sx = Math.min(lum.width - 1, Math.max(0, x0 + x * f + xx));
          s += lum.data[sy * lum.width + sx];
        }
      }
      out[y * n + x] = s / (f * f);
      sum += out[y * n + x];
    }
  const mean = sum / (dw * dh);
  // Tukey-Fenster: innen flach, nur die äusseren 15 % weich ausgeblendet – ein volles Hann-Fenster zöge die
  // Schätzung zur Verschiebung 0 hin (das Fenster selbst bewegt sich nicht mit)
  const taper = (i: number, len: number) => {
    const e = 0.15 * len, d = Math.min(i + 0.5, len - i - 0.5);
    return d >= e ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / e);
  };
  for (let y = 0; y < dh; y++) {
    const wy = taper(y, dh);
    for (let x = 0; x < dw; x++) out[y * n + x] = (out[y * n + x] - mean) * wy * taper(x, dw);
  }
  return out;
}

/** Spektrum eines vorbereiteten Feldes */
export function spectrum(a: Float64Array, n: number): [Float64Array, Float64Array] {
  const re = Float64Array.from(a), im = new Float64Array(n * n);
  fft2(re, im, n);
  return [re, im];
}

/**
 * Bandpass-Gewichte und ihre Summe: oben Gauss (halbe Breite ≈ 0.3 × Nyquist, gegen Rauschen), unten die
 * tiefsten Frequenzen gedämpft (Fenster, Helligkeitsverlauf, Rand der Scheibe tragen dort am meisten).
 */
export function lowpass(n: number, width = 0.3): { w: Float64Array; sum: number } {
  const w = new Float64Array(n * n);
  let sum = 0;
  const s = width * (n / 2), s0 = 2;
  for (let y = 0; y < n; y++) {
    const fy = y <= n / 2 ? y : y - n;
    for (let x = 0; x < n; x++) {
      const fx = x <= n / 2 ? x : x - n;
      const f2 = fx * fx + fy * fy;
      const v = Math.exp(-f2 / (2 * s * s)) * (1 - Math.exp(-f2 / (2 * s0 * s0)));
      w[y * n + x] = v;
      sum += v;
    }
  }
  return { w, sum };
}

/**
 * Verschiebung von cur gegenüber ref (beide als Spektren) mit Unterpixel-Schätzung.
 * Kreuzspektrum durch die Wurzel seines Betrags geteilt (halbe Normierung): schärfer als die gewöhnliche
 * Korrelation, aber robuster als die volle Phasenkorrelation, bei der in glatten Bildern das unbewegte Fenster
 * die schwachen Frequenzen beherrscht. peak: auf beide Bilder normiert, 1 = gleiches Bild (Cauchy-Schwarz ≤ 1).
 */
export function correlate(cur: [Float64Array, Float64Array], ref: [Float64Array, Float64Array], n: number, lp: { w: Float64Array; sum: number }, fine = true) {
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  let ec = 0, er = 0;
  for (let i = 0; i < n * n; i++) {
    const a = cur[0][i], b = cur[1][i], c = ref[0][i], d = -ref[1][i];
    const pr = a * c - b * d, pi = a * d + b * c;
    const m = Math.sqrt(Math.hypot(pr, pi)) + 1e-12;
    re[i] = (pr / m) * lp.w[i];
    im[i] = (pi / m) * lp.w[i];
    ec += lp.w[i] * Math.hypot(a, b);
    er += lp.w[i] * Math.hypot(c, d);
  }
  const norm = Math.sqrt(ec * er) / (n * n) || 1;
  const gRe = fine ? Float64Array.from(re) : null, gIm = fine ? Float64Array.from(im) : null;
  fft2(re, im, n, true);
  let best = 0, bi = 0;
  for (let i = 0; i < n * n; i++) if (re[i] > best) { best = re[i]; bi = i; }
  const px = bi % n, py = Math.floor(bi / n);
  const ix = px > n / 2 ? px - n : px, iy = py > n / 2 ? py - n : py;
  if (!gRe || !gIm) return { dx: ix, dy: iy, peak: best / norm };
  // Unterpixel: Korrelation direkt aus dem Spektrum auf einem feinen Gitter (1/20 Pixel, ±1 Pixel um das
  // Maximum) auswerten – trennbar in x und y. Eine Parabel durch drei Punkte zöge zu ganzen Pixeln hin.
  const steps = 41, step = 0.05;
  const grid = Array.from({ length: steps }, (_, j) => -1 + j * step);
  const sf = (k: number) => (k <= n / 2 ? k : k - n);
  // A[ky][j] = Σ_kx G[ky][kx] · exp(2πi·kx·(ix + u_j)/n)
  const aRe = new Float64Array(n * steps), aIm = new Float64Array(n * steps);
  const ex = (pos: number) => {
    const c = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) { const t = (2 * Math.PI * sf(k) * pos) / n; c[2 * k] = Math.cos(t); c[2 * k + 1] = Math.sin(t); }
    return c;
  };
  for (let j = 0; j < steps; j++) {
    const e = ex(ix + grid[j]);
    for (let ky = 0; ky < n; ky++) {
      let sr = 0, si = 0;
      const o = ky * n;
      for (let kx = 0; kx < n; kx++) {
        const gr = gRe[o + kx], gi = gIm[o + kx], er2 = e[2 * kx], ei = e[2 * kx + 1];
        sr += gr * er2 - gi * ei; si += gr * ei + gi * er2;
      }
      aRe[ky * steps + j] = sr; aIm[ky * steps + j] = si;
    }
  }
  let fb = -Infinity, fx = ix, fy = iy;
  for (let i = 0; i < steps; i++) {
    const e = ex(iy + grid[i]);
    for (let j = 0; j < steps; j++) {
      let sr = 0;
      for (let ky = 0; ky < n; ky++) sr += aRe[ky * steps + j] * e[2 * ky] - aIm[ky * steps + j] * e[2 * ky + 1];
      if (sr > fb) { fb = sr; fx = ix + grid[j]; fy = iy + grid[i]; }
    }
  }
  return { dx: fx, dy: fy, peak: Math.max(best, fb / (n * n)) / norm };
}

export interface SurfaceShift {
  /** Verschiebung des Bildinhalts gegenüber dem Referenzbild (Pixel) */
  dx: number;
  dy: number;
  /** Sicherheit 0…1 (Korrelation des ausgewerteten Bereichs, 1 = gleiches Bild) */
  peak: number;
}

const N = 256;

/** Rechteck in Pixeln des Referenzbildes */
export interface SurfaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Kleinste sinnvolle Ankerbox (Pixel je Seite) */
export const MIN_ANCHOR = 24;

/** Sicherheit, ab der eine gefundene Verschiebung als Vorhersage für das nächste Bild dient */
const TRACK_MIN_PEAK = 0.2;

/** Ankerbox ins Bild legen; null, wenn sie fehlt oder zu klein ist */
export function clampAnchor(box: SurfaceBox | null | undefined, w: number, h: number): SurfaceBox | null {
  if (!box) return null;
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(w, Math.round(box.x + box.width)), y1 = Math.min(h, Math.round(box.y + box.height));
  if (x1 - x0 < MIN_ANCHOR || y1 - y0 < MIN_ANCHOR) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Richtet Bilder gleicher Grösse an einem Referenzbild aus. Ohne Ankerbox zählt das ganze Bild; mit Ankerbox nur
 * dieser Bereich (eine markante Stelle, z. B. ein Krater). Mit Ankerbox folgt das Suchfenster der zuletzt sicher
 * gefundenen Verschiebung – so verlässt die Stelle bei langsamer Drift das Fenster nicht. Dafür die Bilder in
 * Aufnahmereihenfolge ausrichten.
 */
export class SurfaceAligner {
  private readonly f: number;
  private readonly coarse: [Float64Array, Float64Array];
  private readonly lpCoarse = lowpass(N);
  private readonly box: SurfaceBox;
  /** Feinstufe nur bei stark verkleinertem Bereich (f ≥ 3): Ausschnitt in voller Auflösung */
  private readonly fine: { p: number; lp: { w: Float64Array; sum: number }; spec: [Float64Array, Float64Array]; x0: number; y0: number } | null = null;
  /** Vorhersage (nur mit Ankerbox) */
  private track: { dx: number; dy: number } | null;

  constructor(
    private readonly ref: Lum,
    anchor: SurfaceBox | null = null,
  ) {
    const { width: w, height: h } = ref;
    const a = clampAnchor(anchor, w, h);
    this.box = a ?? { x: 0, y: 0, width: w, height: h };
    this.track = a ? { dx: 0, dy: 0 } : null;
    const { x, y, width: bw, height: bh } = this.box;
    this.f = Math.max(1, Math.ceil(Math.max(bw, bh) / N));
    this.coarse = spectrum(prepare(ref, x, y, bw, bh, this.f, N), N);
    if (this.f >= 3) {
      // grösste Zweierpotenz ≤ 256, die mit Rand in den Bereich passt
      let p = 256;
      while (p > 32 && p > Math.min(bw, bh) * 0.75) p >>= 1;
      const x0 = Math.round(x + bw / 2 - p / 2), y0 = Math.round(y + bh / 2 - p / 2);
      this.fine = { p, lp: lowpass(p, 0.2), spec: spectrum(prepare(ref, x0, y0, p, p, 1, p), p), x0, y0 };
    }
  }

  /** Ausgewerteter Bereich im Referenzbild */
  get region(): SurfaceBox {
    return { ...this.box };
  }

  align(cur: Lum): SurfaceShift {
    if (cur.width !== this.ref.width || cur.height !== this.ref.height) return { dx: 0, dy: 0, peak: 0 };
    const px = this.track ? Math.round(this.track.dx) : 0, py = this.track ? Math.round(this.track.dy) : 0;
    const { x, y, width: bw, height: bh } = this.box;
    // ganzer Bereich (bei grossen Bereichen verkleinert): Verschiebung und Sicherheit
    const c = correlate(spectrum(prepare(cur, x + px, y + py, bw, bh, this.f, N), N), this.coarse, N, this.lpCoarse);
    const dx = px + c.dx * this.f, dy = py + c.dy * this.f;
    let res: SurfaceShift = { dx, dy, peak: c.peak };
    if (this.fine) {
      // Feinstufe: Ausschnitt dort, wohin sich der Referenzausschnitt verschoben hat
      const { p, lp, spec, x0, y0 } = this.fine;
      const sx = Math.round(dx), sy = Math.round(dy);
      const r = correlate(spectrum(prepare(cur, x0 + sx, y0 + sy, p, p, 1, p), p), spec, p, lp);
      // Feinstufe nur nehmen, wenn sie zur Grobstufe passt (≤ 1 verkleinerter Pixel) und sicher genug ist –
      // sonst ist der Ausschnitt zu arm an Struktur oder zu verrauscht
      if (Math.abs(r.dx) <= this.f && Math.abs(r.dy) <= this.f && r.peak >= 0.8 * c.peak) res = { dx: sx + r.dx, dy: sy + r.dy, peak: c.peak };
    }
    if (this.track && res.peak >= TRACK_MIN_PEAK) this.track = { dx: res.dx, dy: res.dy };
    return res;
  }
}
