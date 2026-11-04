// Minimaler EXIF-Leser für JPEG: liefert Aufnahmezeit und Kamera.
// Liest nur die ersten 128 KB der Datei.

export interface ExifInfo {
  /** Aufnahmezeit als Text "YYYY:MM:DD hh:mm:ss" (lokale Kamerazeit) */
  dateTimeOriginal?: string;
  subSec?: string;
  /** Zeitzonen-Versatz wie "+02:00", falls die Kamera ihn speichert */
  offsetTimeOriginal?: string;
  make?: string;
  model?: string;
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
}

/**
 * Aufnahmedaten aus dem Dateianfang: JPEG (APP1), TIFF-basierte RAW-Dateien (NEF, CR2, ARW, DNG, ORF, RW2, PEF),
 * Fujifilm RAF (eingebettetes JPEG) und Canon CR3 (CMT1/CMT2-Boxen).
 */
export function readExif(buf: ArrayBuffer): ExifInfo {
  const v = new DataView(buf);
  if (v.byteLength < 16) return {};
  const m = v.getUint16(0);
  // TIFF: "II" oder "MM", danach 42 (TIFF/DNG/NEF/CR2/ARW), 0x4f52 (ORF) oder 0x55 (RW2)
  if (m === 0x4949 || m === 0x4d4d) {
    const magic = v.getUint16(2, m === 0x4949);
    if (magic === 42 || magic === 0x4f52 || magic === 0x5352 || magic === 0x55) return parseTiff(v, 0, v.byteLength);
  }
  if (String.fromCharCode(...new Uint8Array(buf, 0, 8)) === "FUJIFILM") {
    const off = v.getUint32(84), len = v.getUint32(88);
    return off + 4 < v.byteLength ? readExif(buf.slice(off, Math.min(v.byteLength, off + len))) : {};
  }
  if (v.getUint32(4) === 0x66747970 /* ftyp */) return readCr3(buf);
  if (m !== 0xffd8) return {};
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966 /* "Exif" */) {
      return parseTiff(v, off + 10, Math.min(v.byteLength, off + 2 + len));
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return {};
}

/** Canon CR3: CMT1 = IFD0 (Kamera), CMT2 = Exif-IFD, je als eigener TIFF-Block. */
function readCr3(buf: ArrayBuffer): ExifInfo {
  const b = new Uint8Array(buf);
  const find = (tag: string) => {
    for (let i = 4; i + 8 < b.length; i++)
      if (b[i] === tag.charCodeAt(0) && b[i + 1] === tag.charCodeAt(1) && b[i + 2] === tag.charCodeAt(2) && b[i + 3] === tag.charCodeAt(3)) return i + 4;
    return -1;
  };
  const v = new DataView(buf);
  const out: ExifInfo = {};
  const c1 = find("CMT1"), c2 = find("CMT2");
  if (c1 > 0) Object.assign(out, parseTiff(v, c1, Math.min(b.length, c1 - 8 + v.getUint32(c1 - 8))));
  if (c2 > 0) Object.assign(out, parseTiff(v, c2, Math.min(b.length, c2 - 8 + v.getUint32(c2 - 8)), true));
  return out;
}

function parseTiff(v: DataView, base: number, end: number, ifd0IsExif = false): ExifInfo {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const out: ExifInfo = {};
  const str = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n && o + i < end; i++) {
      const c = v.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };
  const readIfd = (ifd: number, visit: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (ifd <= 0 || base + ifd + 2 > end) return;
    const n = u16(base + ifd);
    for (let i = 0; i < n; i++) {
      const e = base + ifd + 2 + i * 12;
      if (e + 12 > end) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      const valOff = size * count <= 4 ? e + 8 : base + u32(e + 8);
      visit(u16(e), type, count, valOff);
    }
  };
  const rational = (o: number) => (o + 8 <= end && u32(o + 4) ? u32(o) / u32(o + 4) : undefined);
  const num = (type: number, o: number) => (type === 3 ? u16(o) : type === 4 ? u32(o) : type === 5 ? rational(o) : undefined);

  let exifIfd = ifd0IsExif ? u32(base + 4) : 0;
  if (!ifd0IsExif) readIfd(u32(base + 4), (tag, type, count, o) => {
    if (tag === 0x010f) out.make = str(o, count);
    if (tag === 0x0110) out.model = str(o, count);
    if (tag === 0x8769) exifIfd = num(type, o) ?? 0;
  });
  readIfd(exifIfd, (tag, type, count, o) => {
    if (tag === 0x9003) out.dateTimeOriginal = str(o, count);
    if (tag === 0x9291) out.subSec = str(o, count);
    if (tag === 0x9011) out.offsetTimeOriginal = str(o, count);
    if (tag === 0x829a) out.exposureTime = num(type, o);
    if (tag === 0x829d) out.fNumber = num(type, o);
    if (tag === 0x8827) out.iso = num(type, o);
    if (tag === 0x920a) out.focalLength = num(type, o);
  });
  return out;
}

/** EXIF-Zeit → Millisekunden seit 1970 (als UTC gelesen, wenn kein Versatz bekannt ist). */
export function exifTimeMs(e: ExifInfo): number | null {
  const m = e.dateTimeOriginal?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (e.subSec) ms += Number(`0.${e.subSec.replace(/\D/g, "")}`) * 1000 || 0;
  const tz = e.offsetTimeOriginal?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (tz) ms -= (tz[1] === "-" ? -1 : 1) * (+tz[2] * 60 + +tz[3]) * 60000;
  return ms;
}

/**
 * Wie readExif, aber direkt aus der Datei: Liegt der Exif-Block eines TIFF/DNG weiter hinten (DNG-Konverter
 * schreiben ihn oft ans Ende), wird dieser Bereich nachgeladen.
 */
export async function readExifBlob(file: Blob, headBytes = 262144): Promise<ExifInfo> {
  const head = await file.slice(0, headBytes).arrayBuffer();
  const first = readExif(head);
  if (first.dateTimeOriginal || head.byteLength < 8) return first;
  const v = new DataView(head);
  const m = v.getUint16(0);
  if (m !== 0x4949 && m !== 0x4d4d) return first;
  const le = m === 0x4949;
  const ifd0 = v.getUint32(4, le);
  if (ifd0 + 2 > head.byteLength) return first;
  const n = v.getUint16(ifd0, le);
  let exifPtr = 0;
  for (let i = 0; i < n && ifd0 + 2 + 12 * i + 12 <= head.byteLength; i++) {
    const e = ifd0 + 2 + 12 * i;
    if (v.getUint16(e, le) === 0x8769) exifPtr = v.getUint32(e + 8, le);
  }
  if (!exifPtr || exifPtr < head.byteLength || exifPtr > file.size) return first;
  // Kopf und Exif-Bereich an ihren Originalstellen in einen Puffer legen
  const tail = new Uint8Array(await file.slice(exifPtr, Math.min(file.size, exifPtr + 65536)).arrayBuffer());
  const buf = new Uint8Array(exifPtr + tail.length);
  buf.set(new Uint8Array(head), 0);
  buf.set(tail, exifPtr);
  return { ...first, ...readExif(buf.buffer) };
}
