// FITS lesen (eigene Umsetzung nach dem FITS-Standard 4.0): Einzelbild (grau, Bayer-Rohdaten oder Farbe mit
// NAXIS3 = 3) und mehrere Bilder in einer Datei – Würfel (NAXIS3 = N Bilder grau/Bayer, oder NAXIS3 = 3 Farben
// × NAXIS4 = N Bilder) sowie ein Bild je Erweiterung (XTENSION = 'IMAGE', z. B. FITS-Sequenzen von Siril).
// Datentypen: BITPIX 8, 16, 32 (ganzzahlig) und -32, -64 (Gleitkomma), mit BZERO/BSCALE.
// Ergebnis ist ein Frame mit 8 oder 16 bit, wie bei SER:
// - 16 bit vorzeichenlos (BZERO 32768) und 8 bit: Werte unverändert
// - Gleitkomma im Bereich 0…1 (Siril, PixInsight): × 65535
// - sonst: in den 16-bit-Bereich eingepasst (grösster Wert ≤ 65535 bleibt, darüber skaliert); bei mehreren Bildern
//   gilt der Faktor des ersten Bildes für alle (sonst flackert die Helligkeit)
// Zeilenfolge: ohne ROWORDER = 'TOP-DOWN' steht die unterste Zeile zuerst (FITS-Norm) – dann wird gespiegelt.
// Mehrdeutig ist NAXIS3 = 3: ohne BAYERPAT gilt das als ein Farbbild, mit BAYERPAT als drei Rohbilder.
import type { ExifInfo } from "./exif";
import { SerColor, type Frame } from "./ser";
import { msg } from "../i18n";

export const FITS_EXT = /\.(fits?|fts)$/i;

export type FitsHeader = Map<string, string | number | boolean>;

/**
 * Kopfzeilen (80 Zeichen) bis END lesen; liefert Schlüssel und Länge des Kopfs (Vielfaches von 2880).
 * ext = true: Kopf einer Erweiterung (beginnt mit XTENSION statt SIMPLE).
 */
export function parseFitsHeader(bytes: Uint8Array, ext = false): { header: FitsHeader; length: number } | null {
  const text = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 80));
  if (bytes.length < 2880 || !text(0).startsWith(ext ? "XTENSION=" : "SIMPLE  =")) return null;
  const header: FitsHeader = new Map();
  for (let o = 0; o + 80 <= bytes.length; o += 80) {
    const c = text(o);
    const key = c.slice(0, 8).trim();
    if (key === "END") return { header, length: Math.ceil((o + 80) / 2880) * 2880 };
    if (c.slice(8, 10) !== "= " || !key) continue;
    const raw = c.slice(10).trim();
    let value: string | number | boolean;
    if (raw.startsWith("'")) {
      // Zeichenkette; '' steht für ein Apostroph
      let s = "", i = 1;
      while (i < raw.length) {
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") { s += "'"; i += 2; continue; }
          break;
        }
        s += raw[i++];
      }
      value = s.trimEnd();
    } else {
      const v = raw.split("/")[0].trim();
      if (v === "T" || v === "F") value = v === "T";
      else {
        const n = Number(v.replace(/D/i, "E"));
        if (!v || isNaN(n)) continue;
        value = n;
      }
    }
    header.set(key, value);
  }
  return null; // kein END im gelesenen Bereich
}

/** Kopf aus der Datei lesen (wächst bei sehr langen Köpfen); offset > 0: Kopf einer Erweiterung */
export async function readFitsHeader(file: Blob, offset = 0): Promise<{ header: FitsHeader; length: number } | null> {
  for (let n = 2880 * 4; ; n *= 4) {
    const bytes = new Uint8Array(await file.slice(offset, offset + n).arrayBuffer());
    const r = parseFitsHeader(bytes, offset > 0);
    if (r || bytes.length < n) return r;
  }
}

export async function isFits(file: Blob): Promise<boolean> {
  return String.fromCharCode(...new Uint8Array(await file.slice(0, 9).arrayBuffer())) === "SIMPLE  =";
}

export const fitsNum = (h: FitsHeader, k: string, def: number) => (typeof h.get(k) === "number" ? (h.get(k) as number) : def);
export const fitsStr = (h: FitsHeader, k: string) => (typeof h.get(k) === "string" ? (h.get(k) as string).trim() : undefined);
const num = fitsNum, str = fitsStr;

const PATTERN: Record<string, number> = { RGGB: SerColor.BAYER_RGGB, GRBG: SerColor.BAYER_GRBG, GBRG: SerColor.BAYER_GBRG, BGGR: SerColor.BAYER_BGGR };

/** Bayer-Muster aus BAYERPAT (+ XBAYROFF/YBAYROFF), bezogen auf die Zeilen in Dateireihenfolge */
function bayerOf(h: FitsHeader, flipRows: boolean, height: number): number {
  let p = str(h, "BAYERPAT")?.toUpperCase();
  if (!p || !(p in PATTERN)) return SerColor.MONO;
  const swapCols = (s: string) => s[1] + s[0] + s[3] + s[2];
  const swapRows = (s: string) => s[2] + s[3] + s[0] + s[1];
  if (num(h, "XBAYROFF", 0) & 1) p = swapCols(p);
  if (num(h, "YBAYROFF", 0) & 1) p = swapRows(p);
  // Spiegeln bei gerader Höhe: die erste Zeile wird zur letzten (andere Parität)
  if (flipRows && height % 2 === 0) p = swapRows(p);
  return PATTERN[p];
}

/** Ein Bildteil (HDU) mit einem oder mehreren Bildern */
export interface FitsImageHdu {
  header: FitsHeader;
  /** Beginn der Daten in der Datei */
  dataOffset: number;
  bitpix: number;
  width: number;
  height: number;
  /** 1 = grau/Bayer, 3 = Farbe */
  planes: 1 | 3;
  /** Bilder in diesem Teil (Würfel: > 1) */
  frames: number;
}

/** Bildgeometrie eines Kopfs; null, wenn er keine Bilddaten hat (NAXIS < 2 oder eine Achse 0) */
function imageGeometry(h: FitsHeader): { width: number; height: number; planes: 1 | 3; frames: number } | null {
  const naxis = num(h, "NAXIS", 0);
  if (naxis < 2) return null;
  const ax = (k: number) => (k <= naxis ? num(h, `NAXIS${k}`, 0) : 1);
  const w = ax(1), ht = ax(2), n3 = ax(3), n4 = ax(4);
  if (w <= 0 || ht <= 0 || n3 <= 0 || n4 <= 0) return null;
  for (let k = 5; k <= naxis; k++) if (ax(k) !== 1) throw new Error(msg("fitsUnsupported", `NAXIS${k}`));
  if (n4 > 1) {
    // Würfel aus Farbbildern: Achse 3 = Farben, Achse 4 = Bilder
    if (n3 !== 1 && n3 !== 3) throw new Error(msg("fitsUnsupported", `NAXIS3 = ${n3}, NAXIS4 = ${n4}`));
    return { width: w, height: ht, planes: n3 as 1 | 3, frames: n4 };
  }
  if (n3 === 3 && !str(h, "BAYERPAT")) return { width: w, height: ht, planes: 3, frames: 1 };
  return { width: w, height: ht, planes: 1, frames: n3 };
}

/**
 * Alle Bildteile einer FITS-Datei: Hauptteil und Erweiterungen vom Typ IMAGE (Tabellen u. a. werden übersprungen).
 * Liest nur die Köpfe.
 */
export async function readFitsLayout(file: Blob): Promise<FitsImageHdu[]> {
  const out: FitsImageHdu[] = [];
  let offset = 0;
  for (let k = 0; k < 100000 && offset < file.size; k++) {
    const head = await readFitsHeader(file, offset);
    if (!head) {
      if (k === 0) throw new Error(msg("fitsBad"));
      break; // Rest ohne gültigen Kopf – ignorieren
    }
    const h = head.header;
    const bitpix = num(h, "BITPIX", 0), naxis = num(h, "NAXIS", 0);
    let elems = naxis > 0 ? 1 : 0;
    for (let a = 1; a <= naxis; a++) elems *= num(h, `NAXIS${a}`, 0);
    const bytes = (Math.abs(bitpix) / 8) * num(h, "GCOUNT", 1) * (num(h, "PCOUNT", 0) + elems);
    const dataOffset = offset + head.length;
    const image = k === 0 || str(h, "XTENSION")?.toUpperCase() === "IMAGE";
    const g = image ? imageGeometry(h) : null;
    if (g) {
      if (![8, 16, 32, -32, -64].includes(bitpix)) throw new Error(msg("fitsUnsupported", `BITPIX = ${bitpix}`));
      out.push({ header: h, dataOffset, bitpix, ...g });
    }
    offset = dataOffset + Math.ceil(bytes / 2880) * 2880;
  }
  if (!out.length) throw new Error(msg("fitsUnsupported", "NAXIS < 2"));
  return out;
}

/**
 * Ein Bild aus einem Bildteil lesen. scale: Faktor auf 0…65535 (von einem früheren Bild derselben Datei);
 * ohne Angabe wird er aus diesem Bild bestimmt. Ergebnis enthält den verwendeten Faktor.
 */
export async function decodeFitsFrame(file: Blob, hdu: FitsImageHdu, index: number, scale?: number): Promise<{ frame: Frame; scale: number }> {
  const { header: h, bitpix, width: w, height: ht, planes } = hdu;
  const plane = w * ht, count = plane * planes, bytes = Math.abs(bitpix) / 8;
  const start = hdu.dataOffset + index * count * bytes;
  const buf = await file.slice(start, start + count * bytes).arrayBuffer();
  if (buf.byteLength < count * bytes) throw new Error(msg("fitsBad"));
  const v = new DataView(buf);
  const bzero = num(h, "BZERO", 0), bscale = num(h, "BSCALE", 1);
  const blank = typeof h.get("BLANK") === "number" ? (h.get("BLANK") as number) : null;
  const read: (i: number) => number =
    bitpix === 8 ? (i) => v.getUint8(i)
    : bitpix === 16 ? (i) => v.getInt16(2 * i)
    : bitpix === 32 ? (i) => v.getInt32(4 * i)
    : bitpix === -32 ? (i) => v.getFloat32(4 * i)
    : (i) => v.getFloat64(8 * i);
  // physikalische Werte; fehlende (BLANK, NaN) als 0. Zweimal gelesen statt zwischengespeichert (grosse Bilder)
  const phys = (i: number) => {
    const r = read(i);
    return (blank !== null && bitpix > 0 && r === blank) || Number.isNaN(r) ? 0 : r * bscale + bzero;
  };
  const eight = bitpix === 8 && bscale === 1 && bzero === 0;
  let k = scale ?? 1;
  if (!eight && scale === undefined) {
    let max = -Infinity, min = Infinity;
    for (let i = 0; i < count; i++) {
      const p = phys(i);
      if (p > max) max = p;
      if (p < min) min = p;
    }
    if (bitpix < 0 && max <= 1.0001 && min >= -0.0001) k = 65535; // normierte Gleitkommawerte
    else if (bitpix === 32 && bzero === 2147483648) k = 1 / 65536; // vorzeichenlos 32 bit
    else if (max > 65535) k = 65535 / max;
  }
  const top = eight ? 255 : 65535;
  const flip = str(h, "ROWORDER")?.toUpperCase() !== "TOP-DOWN";
  const data = eight ? new Uint8Array(count) : new Uint16Array(count);
  for (let c = 0; c < planes; c++)
    for (let y = 0; y < ht; y++) {
      const sy = flip ? ht - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const p = phys(c * plane + sy * w + x) * k;
        data[(y * w + x) * planes + c] = p <= 0 ? 0 : p >= top ? top : Math.round(p);
      }
    }
  const colorId = planes === 3 ? SerColor.RGB : bayerOf(h, flip, ht);
  return { frame: { width: w, height: ht, planes, bitDepth: eight ? 8 : 16, colorId, data }, scale: k };
}

/** Anzahl Bilder einer FITS-Datei (Summe über alle Bildteile) */
export const fitsFrameCount = (layout: FitsImageHdu[]) => layout.reduce((s, u) => s + u.frames, 0);

/** FITS-Datei mit genau einem Bild → Frame (8 oder 16 bit). Mehrere Bilder: als Würfel allein öffnen. */
export async function decodeFits(file: Blob): Promise<Frame> {
  const layout = await readFitsLayout(file);
  const n = fitsFrameCount(layout);
  if (n > 1) throw new Error(msg("fitsCube", n));
  return (await decodeFitsFrame(file, layout[0], 0)).frame;
}

/** Zeit aus DATE-OBS/DATE-END (ISO, UTC) in ms seit 1970; null ohne gültige Angabe */
export function fitsTimeMs(value: string | undefined, time?: string): number | null {
  if (value && !value.includes("T") && time) value = `${value}T${time}`;
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + (m[7] ? Number(`0.${m[7]}`) * 1000 : 0);
}

/** Aufnahmedaten aus dem FITS-Kopf in der Form der EXIF-Angaben (Zeit immer UTC) */
export function fitsExif(h: FitsHeader): ExifInfo {
  const e: ExifInfo = {};
  let date = str(h, "DATE-OBS");
  const time = str(h, "TIME-OBS");
  if (date && !date.includes("T") && time) date = `${date}T${time}`;
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (m) {
    e.dateTimeOriginal = `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    if (m[7]) e.subSec = m[7];
    e.offsetTimeOriginal = "+00:00";
  }
  const exp = num(h, "EXPTIME", num(h, "EXPOSURE", 0));
  if (exp > 0) e.exposureTime = exp;
  const inst = str(h, "INSTRUME");
  if (inst) e.model = inst;
  const fl = num(h, "FOCALLEN", 0);
  if (fl > 0) e.focalLength = fl;
  return e;
}
