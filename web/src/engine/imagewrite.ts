// Einzelbilder in voller Tiefe schreiben: 16-bit-PNG, 16-bit-TIFF (unkomprimiert) und FITS.
// Eigene, kleine Encoder nach den öffentlichen Spezifikationen (PNG: W3C, TIFF 6.0 Baseline, FITS 4.0),
// ohne DOM – laufen im Worker und in Node (Tests).
import { crc32 } from "./zip";
import { SerColor, type Frame } from "./ser";

export interface ImageMeta {
  /** Aufnahmezeit (UTC) */
  date?: Date;
  /** Belichtungszeit in Sekunden */
  exposure?: number;
  software?: string;
}

/** Wert auf 16 bit strecken: 8 bit × 257, sonst nach links schieben (verlustfrei umkehrbar). */
function scaler(bitDepth: number): (v: number) => number {
  if (bitDepth >= 16) return (v) => v;
  if (bitDepth <= 8) return (v) => v * 257;
  const s = 16 - bitDepth;
  return (v) => v << s;
}

/** Abtastwerte in Zeilenfolge, RGB (BGR wird getauscht) oder grau, auf 16 bit gestreckt. */
function samples16(f: Frame): { spp: 1 | 3; get: (i: number) => number } {
  const up = scaler(f.bitDepth);
  const d = f.data;
  if (f.planes === 3) {
    const bgr = f.colorId === SerColor.BGR;
    return {
      spp: 3,
      get: bgr ? (i) => { const p = i % 3; return up(d[i - p + 2 - p]); } : (i) => up(d[i]),
    };
  }
  return { spp: 1, get: (i) => up(d[i]) };
}

// ---------------------------------------------------------------- PNG

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const out = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** 16-bit-PNG (grau oder RGB), Zeilenfilter „Sub“, optional mit Aufnahmezeit (tIME). */
export async function encodePng16(f: Frame, meta: ImageMeta = {}): Promise<Uint8Array> {
  const { spp, get } = samples16(f);
  const w = f.width, h = f.height, rowBytes = w * spp * 2, bpp = spp * 2;
  const raw = new Uint8Array(h * (rowBytes + 1));
  const row = new Uint8Array(rowBytes);
  for (let y = 0; y < h; y++) {
    const base = y * w * spp;
    for (let x = 0; x < w * spp; x++) {
      const v = get(base + x);
      row[2 * x] = v >> 8;
      row[2 * x + 1] = v & 255;
    }
    const o = y * (rowBytes + 1);
    raw[o] = 1; // Filter Sub
    for (let k = 0; k < rowBytes; k++) raw[o + 1 + k] = (row[k] - (k >= bpp ? row[k - bpp] : 0)) & 255;
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr[8] = 16;
  ihdr[9] = spp === 3 ? 2 : 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (meta.date && !isNaN(meta.date.getTime())) {
    const d = meta.date, t = new Uint8Array(7);
    new DataView(t.buffer).setUint16(0, d.getUTCFullYear());
    t.set([d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], 2);
    parts.push(chunk("tIME", t));
  }
  if (meta.software) parts.push(chunk("tEXt", new TextEncoder().encode(`Software\0${meta.software}`)));
  parts.push(chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

// ---------------------------------------------------------------- TIFF

/** 16-bit-TIFF, Baseline, little-endian, unkomprimiert, ein Streifen. */
export function encodeTiff16(f: Frame, meta: ImageMeta = {}): Uint8Array {
  const { spp, get } = samples16(f);
  const w = f.width, h = f.height, n = w * h * spp;
  const ascii = (s: string) => new TextEncoder().encode(s + "\0");
  const extra: Uint8Array[] = [];
  const tags: [number, number, number, number | Uint8Array][] = []; // tag, typ, anzahl, wert oder daten
  const SHORT = 3, LONG = 4, RATIONAL = 5, ASCII = 2;
  const shorts = (vals: number[]) => { const b = new Uint8Array(vals.length * 2); const v = new DataView(b.buffer); vals.forEach((x, k) => v.setUint16(2 * k, x, true)); return b; };
  const rational = (a: number, b: number) => { const r = new Uint8Array(8); const v = new DataView(r.buffer); v.setUint32(0, a, true); v.setUint32(4, b, true); return r; };
  tags.push([256, LONG, 1, w], [257, LONG, 1, h]);
  tags.push([258, SHORT, spp, spp === 1 ? 16 : shorts([16, 16, 16])]);
  tags.push([259, SHORT, 1, 1], [262, SHORT, 1, spp === 3 ? 2 : 1]);
  tags.push([273, LONG, 1, 0]); // Streifen-Offset, unten gesetzt
  tags.push([277, SHORT, 1, spp], [278, LONG, 1, h], [279, LONG, 1, n * 2]);
  tags.push([282, RATIONAL, 1, rational(72, 1)], [283, RATIONAL, 1, rational(72, 1)], [284, SHORT, 1, 1], [296, SHORT, 1, 2]);
  if (meta.software) tags.push([305, ASCII, meta.software.length + 1, ascii(meta.software)]);
  if (meta.date && !isNaN(meta.date.getTime())) {
    const d = meta.date, p = (x: number) => String(x).padStart(2, "0");
    const s = `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    tags.push([306, ASCII, 20, ascii(s)]);
  }
  tags.sort((a, b) => a[0] - b[0]);
  const ifdSize = 2 + tags.length * 12 + 4;
  let extraOff = 8 + ifdSize;
  const head = new Uint8Array(8 + ifdSize);
  const v = new DataView(head.buffer);
  head.set([0x49, 0x49, 42, 0]);
  v.setUint32(4, 8, true);
  v.setUint16(8, tags.length, true);
  const extraBytes = tags.reduce((s, t) => s + (t[3] instanceof Uint8Array && t[3].length > 4 ? (t[3].length + 1) & ~1 : 0), 0);
  const dataOff = 8 + ifdSize + extraBytes;
  tags.forEach(([tag, type, count, val], k) => {
    const o = 10 + k * 12;
    v.setUint16(o, tag, true);
    v.setUint16(o + 2, type, true);
    v.setUint32(o + 4, count, true);
    if (tag === 273) v.setUint32(o + 8, dataOff, true);
    else if (val instanceof Uint8Array) {
      if (val.length <= 4) head.set(val, o + 8);
      else {
        v.setUint32(o + 8, extraOff, true);
        const padded = new Uint8Array((val.length + 1) & ~1);
        padded.set(val);
        extra.push(padded);
        extraOff += padded.length;
      }
    } else if (type === SHORT) v.setUint16(o + 8, val, true);
    else v.setUint32(o + 8, val, true);
  });
  // IFD-Ende: kein weiteres Bild (bereits 0)
  const data = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = get(i);
    data[2 * i] = x & 255;
    data[2 * i + 1] = x >> 8;
  }
  return concat([head, ...extra, data]);
}

// ---------------------------------------------------------------- FITS

const BAYER: Record<number, string> = {
  [SerColor.BAYER_RGGB]: "RGGB", [SerColor.BAYER_GRBG]: "GRBG", [SerColor.BAYER_GBRG]: "GBRG", [SerColor.BAYER_BGGR]: "BGGR",
};

function card(key: string, value?: string | number | boolean, comment?: string): string {
  let s = key.padEnd(8);
  if (value !== undefined) {
    const v = typeof value === "boolean" ? (value ? "T" : "F")
      : typeof value === "number" ? String(value)
      : `'${value.replace(/'/g, "''").padEnd(8)}'`;
    s += "= " + (typeof value === "string" ? v : v.padStart(20));
    if (comment) s += " / " + comment;
  }
  return s.slice(0, 80).padEnd(80);
}

/**
 * FITS mit 16 bit (BITPIX 16, BZERO 32768 für vorzeichenlose Werte). Farbe als drei Ebenen (NAXIS3 = 3),
 * Bayer-Rohdaten grau mit BAYERPAT. Zeilen von oben nach unten (ROWORDER = 'TOP-DOWN', wie bei
 * Aufnahmeprogrammen üblich; Siril und PixInsight beachten das).
 */
export function encodeFits(f: Frame, meta: ImageMeta = {}): Uint8Array {
  const { spp, get } = samples16(f);
  const w = f.width, h = f.height;
  const cards = [
    card("SIMPLE", true, "conforms to FITS standard"),
    card("BITPIX", 16, "16-bit integers"),
    card("NAXIS", spp === 3 ? 3 : 2),
    card("NAXIS1", w, "width"),
    card("NAXIS2", h, "height"),
  ];
  if (spp === 3) cards.push(card("NAXIS3", 3, "colour planes R, G, B"));
  cards.push(card("BZERO", 32768, "unsigned 16-bit data"), card("BSCALE", 1), card("ROWORDER", "TOP-DOWN"));
  const bayer = spp === 1 ? BAYER[f.colorId] : undefined;
  if (bayer) cards.push(card("BAYERPAT", bayer, "colour filter array"), card("XBAYROFF", 0), card("YBAYROFF", 0));
  if (meta.date && !isNaN(meta.date.getTime())) cards.push(card("DATE-OBS", meta.date.toISOString().replace("Z", ""), "UTC start of exposure"));
  if (meta.exposure !== undefined && meta.exposure > 0) cards.push(card("EXPTIME", Number(meta.exposure.toPrecision(6)), "seconds"));
  if (f.bitDepth < 16) cards.push(`COMMENT  original ${f.bitDepth}-bit values scaled to 16 bit`.padEnd(80));
  if (meta.software) cards.push(card("CREATOR", meta.software));
  cards.push(card("END"));
  const header = new TextEncoder().encode(cards.join(""));
  const headLen = Math.ceil(header.length / 2880) * 2880;
  const plane = w * h, n = plane * spp;
  const dataLen = Math.ceil((n * 2) / 2880) * 2880;
  const out = new Uint8Array(headLen + dataLen);
  out.fill(32, 0, headLen);
  out.set(header, 0);
  const v = new DataView(out.buffer, headLen);
  if (spp === 3) {
    for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) v.setInt16(2 * (c * plane + i), get(i * 3 + c) - 32768);
  } else for (let i = 0; i < plane; i++) v.setInt16(2 * i, get(i) - 32768);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
