// Kalibrierung mit Dark- und Flat-Frames: (Rohbild − Master-Dark) × Flat-Gewinn.
// - Master: Mittelwert je Pixel ohne den höchsten und tiefsten Wert (ab 3 Bildern) – entfernt Ausreisser wie
//   kosmische Strahlung, ohne alle Bilder im Speicher zu halten (nur Summe, Minimum, Maximum).
// - Flat: Master-Flat minus Flat-Dark (oder Bias), je 2×2-Zelle bzw. je Farbkanal auf den Mittelwert der
//   Bildmitte normiert – so bleibt bei Bayer-Rohdaten die Farbe neutral. Gewinn = 1 / normiertes Flat.
// - Dark-Skalierung: Hat das Bild eine andere Belichtungszeit als das Dark, wird nur der Wärmeanteil (Dark minus
//   Sockel) mit dem Verhältnis der Zeiten skaliert. Sockel = Flat-Dark/Bias, falls geladen, sonst der Median des Darks.
// - Master lassen sich als FITS (32 bit Gleitkomma) speichern und wieder laden.
// Gerechnet wird auf dem ganzen Rohbild vor Zuschnitt und Debayer.
import { SerColor, type Frame } from "./ser";
import type { FrameSource } from "./source";
import { card } from "./imagewrite";
import { fitsNum, fitsStr, parseFitsHeader } from "./fits";
import { msg } from "../i18n";

export interface Master {
  width: number;
  height: number;
  planes: number;
  colorId: number;
  bitDepth: number;
  frames: number;
  /** Belichtungszeit in Sekunden (gleich für alle Bilder des Masters), sonst undefiniert */
  exposure?: number;
  /** Werte im Bereich der eigenen Bittiefe */
  data: Float32Array;
}

export class MasterBuilder {
  private sum: Float64Array | null = null;
  private min: Float32Array | null = null;
  private max: Float32Array | null = null;
  private first: Frame | null = null;
  private n = 0;
  private exposures: (number | undefined)[] = [];

  add(f: Frame, exposure?: number): void {
    this.exposures.push(exposure);
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
    // Belichtungszeit nur, wenn alle Bilder sie haben und sie (bis auf 1 %) gleich ist
    const ex = this.exposures;
    const e0 = ex[0];
    const exposure = e0 && e0 > 0 && ex.every((x) => x !== undefined && Math.abs(x - e0) <= 0.01 * e0) ? e0 : undefined;
    return { width: f.width, height: f.height, planes: f.planes, colorId: f.colorId, bitDepth: f.bitDepth, frames: n, exposure, data };
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
  /** Dark an die Belichtungszeit des Bildes anpassen (wenn beide bekannt sind) */
  scaleDark?: boolean;
}

/** Verhältnis Belichtungszeit Bild / Dark, oder 1 (unbekannt oder praktisch gleich) */
export function darkRatio(dark: Pick<Master, "exposure">, exposure: number | undefined): number {
  if (!dark.exposure || !exposure || exposure <= 0) return 1;
  const r = exposure / dark.exposure;
  return Math.abs(r - 1) < 0.01 ? 1 : r;
}

function median(a: Float32Array): number {
  const step = Math.max(1, Math.floor(a.length / 200_000));
  const s: number[] = [];
  for (let i = 0; i < a.length; i += step) s.push(a[i]);
  s.sort((x, y) => x - y);
  return s[s.length >> 1] ?? 0;
}

/** Wendet Dark und Flat auf Rohbilder an; prüft einmal, ob die Grössen passen. */
export class Calibrator {
  private dark: Float32Array | null = null;
  private gain: Float32Array | null = null;
  /** für die Dark-Skalierung: Sockel (Bias/Flat-Dark je Pixel oder Median) und Wärmeanteil */
  private pedestal: Float32Array | number = 0;
  private thermal: Float32Array | null = null;

  constructor(readonly cal: Calibration, shape: { width: number; height: number; planes: number; bitDepth: number }) {
    const size = `${shape.width}×${shape.height}`;
    if (cal.dark) {
      if (!sameShape(cal.dark, shape)) throw new Error(msg("calSize", `${cal.dark.width}×${cal.dark.height}`, size));
      this.dark = scaled(cal.dark, shape.bitDepth);
      if (cal.scaleDark && cal.dark.exposure) {
        const bias = cal.flatDark && sameShape(cal.flatDark, shape) ? scaled(cal.flatDark, shape.bitDepth) : null;
        this.pedestal = bias ?? median(this.dark);
        const ped = this.pedestal;
        this.thermal = this.dark.map((v, i) => v - (typeof ped === "number" ? ped : ped[i]));
      }
    }
    if (cal.flat) {
      if (!sameShape(cal.flat, shape)) throw new Error(msg("calSize", `${cal.flat.width}×${cal.flat.height}`, size));
      this.gain = flatGain(cal.flat, cal.flatDark);
    }
  }

  get active(): boolean {
    return !!(this.dark || this.gain);
  }

  /** exposure: Belichtungszeit des Bildes (Sekunden) – für die Dark-Skalierung */
  apply(f: Frame, exposure?: number): Frame {
    if (!this.active) return f;
    const src = f.data, n = src.length, max = 2 ** f.bitDepth - 1;
    const out = src instanceof Uint16Array ? new Uint16Array(n) : new Uint8Array(n);
    const g = this.gain;
    const ratio = this.thermal && this.cal.dark ? darkRatio(this.cal.dark, exposure) : 1;
    let dk = this.dark;
    if (ratio !== 1 && this.thermal) {
      // Sockel bleibt, Wärmeanteil wächst mit der Belichtungszeit
      const th = this.thermal, ped = this.pedestal;
      dk = new Float32Array(n);
      for (let i = 0; i < n; i++) dk[i] = (typeof ped === "number" ? ped : ped[i]) + th[i] * ratio;
    }
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
      if (prop === "readFrame") return async (i: number) => c.apply(await target.readFrame(i), target.exposure?.(i) ?? undefined);
      // Getter und Methoden auf dem Original ausführen (Klassen mit privaten Feldern)
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Kurzbeschreibung eines Masters für die Anzeige */
export function masterStats(m: Master): { frames: number; width: number; height: number; planes: number; mean: number; bitDepth: number; exposure?: number } {
  let s = 0;
  for (let i = 0; i < m.data.length; i++) s += m.data[i];
  return { frames: m.frames, width: m.width, height: m.height, planes: m.planes, mean: s / m.data.length, bitDepth: m.bitDepth, exposure: m.exposure };
}

const BAYER_NAME: Record<number, string> = { [SerColor.BAYER_RGGB]: "RGGB", [SerColor.BAYER_GRBG]: "GRBG", [SerColor.BAYER_GBRG]: "GBRG", [SerColor.BAYER_BGGR]: "BGGR" };
const MASTER_TYPE = { dark: "Master Dark", flat: "Master Flat", flatDark: "Master Bias" } as const;

/**
 * Master als FITS: 32 bit Gleitkomma (Werte im Bereich der eigenen Bittiefe, ohne Rundung), Farbbilder als drei
 * Ebenen R, G, B. Eigene Schlüssel ASTBITS (Bittiefe) und ASTCOLOR (Farbkennung wie SER) machen das Laden genau.
 */
export function encodeMaster(m: Master, kind: keyof typeof MASTER_TYPE, software = "Astrotool"): Uint8Array {
  const { width: w, height: h, planes } = m;
  const cards = [
    card("SIMPLE", true, "conforms to FITS standard"),
    card("BITPIX", -32, "32-bit floating point"),
    card("NAXIS", planes === 3 ? 3 : 2),
    card("NAXIS1", w, "width"),
    card("NAXIS2", h, "height"),
  ];
  if (planes === 3) cards.push(card("NAXIS3", 3, "colour planes R, G, B"));
  cards.push(card("ROWORDER", "TOP-DOWN"), card("IMAGETYP", MASTER_TYPE[kind]), card("NCOMBINE", m.frames, "frames combined"));
  if (m.exposure) cards.push(card("EXPTIME", Number(m.exposure.toPrecision(6)), "seconds"));
  const bayer = planes === 1 ? BAYER_NAME[m.colorId] : undefined;
  if (bayer) cards.push(card("BAYERPAT", bayer, "colour filter array"), card("XBAYROFF", 0), card("YBAYROFF", 0));
  cards.push(card("ASTBITS", m.bitDepth, "bit depth of the source data"), card("ASTCOLOR", m.colorId, "colour id (SER)"), card("CREATOR", software), card("END"));
  const header = new TextEncoder().encode(cards.join(""));
  const headLen = Math.ceil(header.length / 2880) * 2880;
  const plane = w * h, n = plane * planes;
  const out = new Uint8Array(headLen + Math.ceil((n * 4) / 2880) * 2880);
  out.fill(32, 0, headLen);
  out.set(header, 0);
  const v = new DataView(out.buffer, headLen);
  if (planes === 3) for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) v.setFloat32(4 * (c * plane + i), m.data[i * 3 + c]);
  else for (let i = 0; i < plane; i++) v.setFloat32(4 * i, m.data[i]);
  return out;
}

/**
 * Master aus einer FITS-Datei lesen: eigene Master genau; Master anderer Programme (IMAGETYP „Master …“ oder
 * NCOMBINE) mit 16 bit bzw. Gleitkomma 0…1 als 16-bit-Werte. null = kein Master (dann wie Einzelbilder behandeln).
 */
export function decodeMaster(bytes: Uint8Array): Master | null {
  const parsed = parseFitsHeader(bytes);
  if (!parsed) return null;
  const hd = parsed.header;
  const own = hd.has("ASTBITS");
  const type = (fitsStr(hd, "IMAGETYP") ?? "").toLowerCase();
  if (!own && !type.includes("master") && !hd.has("NCOMBINE")) return null;
  const bitpix = fitsNum(hd, "BITPIX", 0), naxis = fitsNum(hd, "NAXIS", 0);
  const w = fitsNum(hd, "NAXIS1", 0), h = fitsNum(hd, "NAXIS2", 0), planes = naxis >= 3 ? fitsNum(hd, "NAXIS3", 1) : 1;
  if (!w || !h || (planes !== 1 && planes !== 3) || ![8, 16, 32, -32, -64].includes(bitpix)) return null;
  const bz = fitsNum(hd, "BZERO", 0), bs = fitsNum(hd, "BSCALE", 1);
  const plane = w * h, size = Math.abs(bitpix) / 8;
  if (bytes.length < parsed.length + plane * planes * size) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset + parsed.length);
  const read = (k: number) =>
    bitpix === -32 ? v.getFloat32(4 * k) : bitpix === -64 ? v.getFloat64(8 * k) :
    bz + bs * (bitpix === 8 ? v.getUint8(k) : bitpix === 16 ? v.getInt16(2 * k) : v.getInt32(4 * k));
  const bottomUp = (fitsStr(hd, "ROWORDER") ?? "BOTTOM-UP").toUpperCase() !== "TOP-DOWN";
  const data = new Float32Array(plane * planes);
  for (let c = 0; c < planes; c++)
    for (let y = 0; y < h; y++) {
      const sy = bottomUp && !own ? h - 1 - y : y;
      for (let x = 0; x < w; x++) data[(y * w + x) * planes + c] = read(c * plane + sy * w + x);
    }
  let bitDepth = own ? fitsNum(hd, "ASTBITS", 16) : 16;
  if (!own && bitpix < 0) {
    // Gleitkomma anderer Programme: meist 0…1 → 16 bit
    let max = 0;
    for (let i = 0; i < data.length; i += 97) if (data[i] > max) max = data[i];
    if (max <= 1.5) for (let i = 0; i < data.length; i++) data[i] *= 65535;
  } else if (!own && bitpix === 8) bitDepth = 8;
  const pat = fitsStr(hd, "BAYERPAT")?.toUpperCase();
  const fromPat = Object.entries(BAYER_NAME).find(([, n]) => n === pat)?.[0];
  const colorId = own ? fitsNum(hd, "ASTCOLOR", SerColor.MONO) : planes === 3 ? SerColor.RGB : fromPat ? Number(fromPat) : SerColor.MONO;
  const exposure = fitsNum(hd, "EXPTIME", 0) || fitsNum(hd, "EXPOSURE", 0) || undefined;
  return { width: w, height: h, planes, colorId, bitDepth, frames: fitsNum(hd, "NCOMBINE", 1), exposure, data };
}
