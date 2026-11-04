// Kalibrierung mit Dark- und Flat-Frames: (Rohbild − Master-Dark) × Flat-Gewinn.
// - Master: Mittelwert je Pixel ohne den höchsten und tiefsten Wert (ab 3 Bildern) – entfernt Ausreisser wie
//   kosmische Strahlung, ohne alle Bilder im Speicher zu halten (nur Summe, Minimum, Maximum).
// - Flat: Master-Flat minus Flat-Dark (oder Bias), je 2×2-Zelle bzw. je Farbkanal auf den Mittelwert der
//   Bildmitte normiert – so bleibt bei Bayer-Rohdaten die Farbe neutral. Gewinn = 1 / normiertes Flat.
// Gerechnet wird auf dem ganzen Rohbild vor Zuschnitt und Debayer.
import type { Frame } from "./ser";
import type { FrameSource } from "./source";
import { msg } from "../i18n";

export interface Master {
  width: number;
  height: number;
  planes: number;
  colorId: number;
  bitDepth: number;
  frames: number;
  /** Werte im Bereich der eigenen Bittiefe */
  data: Float32Array;
}

export class MasterBuilder {
  private sum: Float64Array | null = null;
  private min: Float32Array | null = null;
  private max: Float32Array | null = null;
  private first: Frame | null = null;
  private n = 0;

  add(f: Frame): void {
    if (!this.first) {
      this.first = { ...f, data: f.data.slice(0, 0) };
      const len = f.data.length;
      this.sum = new Float64Array(len);
      this.min = new Float32Array(len).fill(Infinity);
      this.max = new Float32Array(len).fill(-Infinity);
    } else if (f.width !== this.first.width || f.height !== this.first.height || f.planes !== this.first.planes) {
      throw new Error(msg("calMixed"));
    }
    const d = f.data, s = this.sum!, lo = this.min!, hi = this.max!;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      s[i] += v;
      if (v < lo[i]) lo[i] = v;
      if (v > hi[i]) hi[i] = v;
    }
    this.n++;
  }

  get count(): number {
    return this.n;
  }

  finish(): Master {
    if (!this.first || !this.n) throw new Error(msg("calEmpty"));
    const s = this.sum!, lo = this.min!, hi = this.max!, n = this.n;
    const data = new Float32Array(s.length);
    if (n >= 3) for (let i = 0; i < s.length; i++) data[i] = (s[i] - lo[i] - hi[i]) / (n - 2);
    else for (let i = 0; i < s.length; i++) data[i] = s[i] / n;
    const f = this.first;
    this.sum = this.min = this.max = null;
    return { width: f.width, height: f.height, planes: f.planes, colorId: f.colorId, bitDepth: f.bitDepth, frames: n, data };
  }
}

/** Master auf eine andere Bittiefe umrechnen (z. B. 12-bit-Dark für 16-bit-Daten) */
function scaled(m: Master, bitDepth: number): Float32Array {
  if (m.bitDepth === bitDepth) return m.data;
  const k = (2 ** bitDepth - 1) / (2 ** m.bitDepth - 1);
  return m.data.map((v) => v * k);
}

function sameShape(a: { width: number; height: number; planes: number }, b: { width: number; height: number; planes: number }): boolean {
  return a.width === b.width && a.height === b.height && a.planes === b.planes;
}

/**
 * Flat-Gewinn je Abtastwert. Bayer: je 2×2-Zelle normiert, Farbe: je Kanal, Grau: gesamt. Mittelwert aus der Bildmitte (halbe Breite und Höhe), damit der Randabfall
 * (Vignettierung) nicht mitzählt. Fast schwarze Stellen (< 5 % des Mittels, tote Pixel) bleiben unverändert.
 */
export function flatGain(flat: Master, flatDark?: Master): Float32Array {
  const { width: w, height: h, planes } = flat;
  const f = new Float32Array(flat.data);
  if (flatDark) {
    if (!sameShape(flat, flatDark)) throw new Error(msg("calSize", `${flatDark.width}×${flatDark.height}`, `${w}×${h}`));
    const d = scaled(flatDark, flat.bitDepth);
    for (let i = 0; i < f.length; i++) f[i] = Math.max(0, f[i] - d[i]);
  }
  // Bayer: je 2×2-Zelle (Farbfilter verschieden empfindlich); Farbe: je Kanal; Grau: ein Mittelwert –
  // je Zelle bei echtem Grau würde der Helligkeitsverlauf ein feines Schachbrett erzeugen
  const bayer = planes === 1 && flat.colorId >= 8 && flat.colorId <= 19;
  const cells = planes === 3 ? 3 : bayer ? 4 : 1;
  const cellOf = planes === 3 ? (i: number) => i % 3 : bayer ? (i: number) => ((Math.floor(i / w) & 1) << 1) | (i % w & 1) : () => 0;
  const sum = new Float64Array(cells), cnt = new Float64Array(cells);
  // Bildmitte, auf ganze 2×2-Zellen ausgerichtet: jede Zelle zählt dieselben Blöcke
  const even = (v: number) => v & ~1;
  const x0 = even(Math.floor(w / 4)), x1 = even(Math.ceil((3 * w) / 4)) || 2, y0 = even(Math.floor(h / 4)), y1 = even(Math.ceil((3 * h) / 4)) || 2;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < planes; c++) {
        const i = (y * w + x) * planes + c;
        const k = cellOf(i);
        sum[k] += f[i];
        cnt[k]++;
      }
  const mean = Array.from(sum, (s, k) => (cnt[k] ? s / cnt[k] : 0));
  if (mean.some((m) => !(m > 0))) throw new Error(msg("calFlatDark"));
  const gain = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i] / mean[cellOf(i)];
    gain[i] = v > 0.05 ? 1 / v : 1;
  }
  return gain;
}

export interface Calibration {
  dark?: Master;
  flat?: Master;
  flatDark?: Master;
}

/** Wendet Dark und Flat auf Rohbilder an; prüft einmal, ob die Grössen passen. */
export class Calibrator {
  private dark: Float32Array | null = null;
  private gain: Float32Array | null = null;

  constructor(readonly cal: Calibration, shape: { width: number; height: number; planes: number; bitDepth: number }) {
    const size = `${shape.width}×${shape.height}`;
    if (cal.dark) {
      if (!sameShape(cal.dark, shape)) throw new Error(msg("calSize", `${cal.dark.width}×${cal.dark.height}`, size));
      this.dark = scaled(cal.dark, shape.bitDepth);
    }
    if (cal.flat) {
      if (!sameShape(cal.flat, shape)) throw new Error(msg("calSize", `${cal.flat.width}×${cal.flat.height}`, size));
      this.gain = flatGain(cal.flat, cal.flatDark);
    }
  }

  get active(): boolean {
    return !!(this.dark || this.gain);
  }

  apply(f: Frame): Frame {
    if (!this.active) return f;
    const src = f.data, n = src.length, max = 2 ** f.bitDepth - 1;
    const out = src instanceof Uint16Array ? new Uint16Array(n) : new Uint8Array(n);
    const dk = this.dark, g = this.gain;
    for (let i = 0; i < n; i++) {
      let v = src[i];
      if (dk) v -= dk[i];
      if (g) v *= g[i];
      out[i] = v <= 0 ? 0 : v >= max ? max : Math.round(v);
    }
    return { ...f, data: out };
  }
}

/** Quelle, deren Bilder beim Lesen kalibriert werden */
export function calibratedSource(src: FrameSource, cal: Calibration): FrameSource {
  const c = new Calibrator(cal, { width: src.width, height: src.height, planes: src.colorId >= 100 ? 3 : 1, bitDepth: src.bitDepth });
  if (!c.active) return src;
  return new Proxy(src, {
    get(target, prop) {
      if (prop === "readFrame") return async (i: number) => c.apply(await target.readFrame(i));
      // Getter und Methoden auf dem Original ausführen (Klassen mit privaten Feldern)
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Kurzbeschreibung eines Masters für die Anzeige */
export function masterStats(m: Master): { frames: number; width: number; height: number; planes: number; mean: number; bitDepth: number } {
  let s = 0;
  for (let i = 0; i < m.data.length; i++) s += m.data[i];
  return { frames: m.frames, width: m.width, height: m.height, planes: m.planes, mean: s / m.data.length, bitDepth: m.bitDepth };
}
