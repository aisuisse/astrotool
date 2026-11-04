// RAW Stufe 2: die echten Sensordaten (Bayer-Mosaik, 12–14 bit) statt des Kamera-JPEGs.
// Unterstützt: DNG (verlustfrei JPEG in Kacheln/Streifen oder unkomprimiert), Canon CR2 (verlustfrei JPEG in
// senkrechten Streifen), Sony ARW (verlustfrei, Kacheln mit 2×2-Blöcken; verlustbehaftet „cRAW“; unkomprimiert),
// NEF, SRW (NX1/NX500, NX300-Familie, NX100-Familie gepackt), Fujifilm RAF unkomprimiert (X-Trans und Bayer,
// auch gepackt) und DNG mit X-Trans-Muster (6×6, wird hier zu RGB rekonstruiert).
// Nicht: CR3 und komprimierte RAF (Kompression nicht öffentlich beschrieben) – dafür gibt es das eingebettete
// JPEG und den Hinweis auf den Adobe DNG Converter.
//
// Ausgabe: 16-bit-Bayer-Frame, Schwarzwert abgezogen und auf 0…65535 gestreckt, auf den sichtbaren Bereich
// zugeschnitten, Farbmuster laut Datei. Weissabgleich: Faktoren je Farbe (siehe applyWhiteBalance).
import { decodeLjpeg } from "./ljpeg";
import { rawPreview } from "./raw";
import { SerColor, type Frame } from "./ser";

type Tags = Map<number, number[]>;

interface Ifd {
  offset: number;
  tags: Tags;
}

async function bytes(b: Blob, off: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await b.slice(off, Math.min(b.size, off + len)).arrayBuffer());
}

/** Liest alle IFDs (Kette und SubIFDs) eines TIFF; Werte als Zahlen (Rationale als Quotient). */
async function readTiff(b: Blob, base = 0): Promise<{ le: boolean; ifds: Ifd[] }> {
  const head = await bytes(b, base, 8);
  const le = head[0] === 0x49;
  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  const readIfd = async (off: number, depth: number): Promise<number> => {
    if (!off || seen.has(off) || depth > 3 || base + off + 2 > b.size) return 0;
    seen.add(off);
    const n = new DataView((await bytes(b, base + off, 2)).buffer).getUint16(0, le);
    if (n > 2000) return 0;
    const raw = await bytes(b, base + off + 2, n * 12 + 4);
    const v = new DataView(raw.buffer);
    const tags: Tags = new Map();
    for (let i = 0; i < n && i * 12 + 12 <= raw.length; i++) {
      const e = i * 12;
      const tag = v.getUint16(e, le), type = v.getUint16(e + 2, le), count = v.getUint32(e + 4, le);
      const size = ({ 1: 1, 3: 2, 4: 4, 5: 8, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 } as Record<number, number>)[type];
      if (!size || count > 1_000_000) continue;
      const total = size * count;
      const src = total <= 4 ? raw.subarray(e + 8, e + 12) : await bytes(b, base + v.getUint32(e + 8, le), Math.min(total, 1 << 20));
      const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const vals: number[] = [];
      for (let k = 0; k < Math.min(count, Math.floor(src.length / size)); k++) {
        const o = k * size;
        vals.push(
          type === 1 ? sv.getUint8(o) : type === 3 ? sv.getUint16(o, le) : type === 8 ? sv.getInt16(o, le) :
          type === 4 || type === 13 ? sv.getUint32(o, le) : type === 9 ? sv.getInt32(o, le) :
          type === 5 ? sv.getUint32(o, le) / (sv.getUint32(o + 4, le) || 1) :
          type === 10 ? sv.getInt32(o, le) / (sv.getInt32(o + 4, le) || 1) :
          type === 11 ? sv.getFloat32(o, le) : sv.getFloat64(o, le),
        );
      }
      tags.set(tag, vals);
    }
    ifds.push({ offset: off, tags });
    for (const s of tags.get(0x14a) ?? []) await readIfd(s, depth + 1);
    // Fujifilm: eigenes IFD (Tag 0xf000) mit Rohdaten-Angaben
    for (const s of tags.get(0xf000) ?? []) await readIfd(s, depth + 1);
    return v.getUint32(n * 12, le);
  };
  let next = new DataView(head.buffer).getUint32(4, le);
  for (let k = 0; next && k < 10; k++) next = await readIfd(next, 0);
  return { le, ifds };
}

const CFA_TO_SER: Record<string, number> = {
  "0,1,1,2": SerColor.BAYER_RGGB, "1,0,2,1": SerColor.BAYER_GRBG, "1,2,0,1": SerColor.BAYER_GBRG, "2,1,1,0": SerColor.BAYER_BGGR,
};

/** Bayer-Muster nach einem Zuschnitt um (dx, dy) Pixel. */
function shiftCfa(cfa: number[], dx: number, dy: number): number[] {
  const at = (x: number, y: number) => cfa[((y + dy) & 1) * 2 + ((x + dx) & 1)];
  return [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
}

export interface RawInfo {
  /** z. B. "DNG lossless JPEG", "CR2", "ARW lossless" */
  format: string;
  /** Weissabgleich laut Kamera (R, G, B), falls in der Datei lesbar */
  cameraWb?: [number, number, number];
  width: number;
  height: number;
  colorId: number;
}

interface Sensor {
  w: number;
  h: number;
  data: Uint16Array;
}

async function decodeTiles(b: Blob, t: Tags, tw: number, th: number, w: number, h: number): Promise<Sensor> {
  const offs = t.get(0x144) ?? [], cnts = t.get(0x145) ?? [];
  const data = new Uint16Array(w * h);
  const across = Math.ceil(w / tw);
  for (let k = 0; k < offs.length; k++) {
    const lj = decodeLjpeg(await bytes(b, offs[k], cnts[k]));
    const x0 = (k % across) * tw, y0 = Math.floor(k / across) * th;
    place(lj, data, w, h, x0, y0, tw, th);
  }
  return { w, h, data };
}

/** Kachel in das Sensorbild legen. Zeilenweise (DNG) oder als 2×2-Blöcke je Abtastung (Sony, 4 Komponenten). */
function place(lj: ReturnType<typeof decodeLjpeg>, out: Uint16Array, w: number, h: number, x0: number, y0: number, tw: number, th: number) {
  const nc = lj.components, rowLen = lj.width * nc;
  if (nc === 4 && lj.width * 2 === tw && lj.height * 2 === th) {
    for (let r = 0; r < lj.height; r++)
      for (let c = 0; c < lj.width; c++)
        for (let k = 0; k < 4; k++) {
          const y = y0 + 2 * r + (k >> 1), x = x0 + 2 * c + (k & 1);
          if (x < w && y < h) out[y * w + x] = lj.data[r * rowLen + c * 4 + k];
        }
    return;
  }
  const rows = Math.min(lj.height, th), cols = Math.min(rowLen, tw);
  for (let r = 0; r < rows; r++) {
    const y = y0 + r;
    if (y >= h) break;
    const n = Math.min(cols, w - x0);
    out.set(lj.data.subarray(r * rowLen, r * rowLen + n), y * w + x0);
  }
}

/** Canon CR2: senkrechte Streifen (Tag 0xc640: Anzahl, Breite, Breite des letzten). */
function unslice(lj: ReturnType<typeof decodeLjpeg>, slices: number[]): Sensor {
  const [n, sw, lw] = slices;
  const w = n * sw + lw, h = lj.height;
  const total = lj.width * lj.components * lj.height;
  const data = new Uint16Array(w * h);
  for (let k = 0; k < total; k++) {
    let s = Math.floor(k / (sw * h));
    let local: number, width: number;
    if (s < n) { local = k - s * sw * h; width = sw; }
    else { s = n; local = k - n * sw * h; width = lw; }
    const y = Math.floor(local / width), x = s * sw + (local % width);
    if (y < h) data[y * w + x] = lj.data[k];
  }
  return { w, h, data };
}

/**
 * Dicht gepackte Werte (12 oder 14 bit ohne Lücken), höchstes Bit zuerst – so liegen die Daten der Samsung
 * NX100-Familie (12 bit, Byte für Byte) und älterer Fujifilm-RAF mit Bayer-Sensor (14 bit, in 32-bit-Wörtern Little
 * Endian, words32) vor. rowBytes: Bytes je Zeile.
 */
export function unpackBits(src: Uint8Array, w: number, h: number, bps: number, rowBytes: number, words32 = false): Uint16Array {
  if (words32) {
    // Bytes jedes 32-bit-Worts umdrehen – danach wie Byte für Byte lesen
    const s2 = new Uint8Array(src.length);
    for (let i = 0; i + 3 < src.length; i += 4) { s2[i] = src[i + 3]; s2[i + 1] = src[i + 2]; s2[i + 2] = src[i + 1]; s2[i + 3] = src[i]; }
    src = s2;
  }
  const out = new Uint16Array(w * h);
  const mask = (1 << bps) - 1;
  for (let y = 0; y < h; y++) {
    let p = y * rowBytes, acc = 0, have = 0;
    for (let x = 0; x < w; x++) {
      while (have < bps) { acc = ((acc << 8) | (src[p++] ?? 0)) & 0xffffff; have += 8; }
      have -= bps;
      out[y * w + x] = (acc >> have) & mask;
    }
  }
  return out;
}

/** Bitleser über 32-bit-Wörter (Little Endian), im Wort höchstes Bit zuerst (Samsung). */
function wordBits(data: Uint8Array, start: number): (n: number) => number {
  let pos = start, word = 0, left = 0;
  return (n: number) => {
    let v = 0;
    while (n > 0) {
      if (!left) {
        word = ((data[pos] ?? 0) | ((data[pos + 1] ?? 0) << 8) | ((data[pos + 2] ?? 0) << 16) | ((data[pos + 3] ?? 0) << 24)) >>> 0;
        pos += 4;
        left = 32;
      }
      const take = Math.min(n, left);
      v = v * (1 << take) + ((word >>> (left - take)) & ((1 << take) - 1));
      left -= take;
      n -= take;
    }
    return v;
  };
}

/**
 * Sony ARW verlustbehaftet („cRAW“, Kompression 32767 mit 1 Byte je Pixel). Aufbau (Reverse Engineering, siehe
 * THIRD_PARTY.md): Jede Zeile besteht aus Blöcken zu 16 Byte; ein Block enthält 16 Pixel derselben Farbe aus einem
 * Abschnitt von 32 Spalten (abwechselnd die geraden, dann die ungeraden Spalten). Ein Block als 128-bit-Zahl
 * (Little Endian, niedrigste Bits zuerst): Höchstwert und Tiefstwert (je 11 bit), deren Lage im Block (je 4 bit),
 * dann für die übrigen 14 Pixel je 7 bit Abstand zum Tiefstwert – um so viele Bits (0–4) nach links geschoben, wie
 * die Spanne Höchst − Tiefst über 7 bit hinausgeht. Die 11-bit-Werte laufen über die Kennlinie aus Tag 0x7010
 * (vier Knickpunkte, dazwischen Steigung 1, 2, 4, 8, 16) in den 14-bit-Bereich (Schwarz 512 laut Tag 0x7310).
 */
export function sonyCurve(knots: number[]): Uint16Array {
  const k = [0, 0, 0, 0, 0, 4095];
  for (let i = 0; i < 4; i++) if (knots[i] !== undefined) k[i + 1] = (knots[i] >> 2) & 0xfff;
  const curve = new Uint16Array(4096);
  for (let i = 0; i < 5; i++) for (let j = k[i] + 1; j <= k[i + 1]; j++) curve[j] = Math.min(65535, curve[j - 1] + (1 << i));
  return curve;
}

export async function decodeSonyLossy(b: Blob, t: Tags, w: number, h: number): Promise<Sensor> {
  const curve = sonyCurve(t.get(0x7010) ?? []);
  const off = t.get(0x111)![0];
  const out = new Uint16Array(w * h);
  const pix = new Uint16Array(16);
  const CHUNK = 128; // Zeilen je Lesevorgang
  for (let r0 = 0; r0 < h; r0 += CHUNK) {
    const rows = Math.min(CHUNK, h - r0);
    const buf = await bytes(b, off + r0 * w, rows * w + 2);
    for (let rr = 0; rr < rows; rr++) {
      const base = rr * w, dst = (r0 + rr) * w;
      for (let blk = 0; (blk + 1) * 16 <= w; blk++) {
        const dp = base + blk * 16;
        const v = (buf[dp] | (buf[dp + 1] << 8) | (buf[dp + 2] << 16) | (buf[dp + 3] << 24)) >>> 0;
        const max = v & 0x7ff, min = (v >>> 11) & 0x7ff, imax = (v >>> 22) & 15, imin = (v >>> 26) & 15;
        let sh = 0;
        while (sh < 4 && 0x80 << sh <= max - min) sh++;
        for (let i = 0, bit = 30; i < 16; i++) {
          if (i === imax) pix[i] = max;
          else if (i === imin) pix[i] = min;
          else {
            const p = dp + (bit >> 3);
            const x = ((((buf[p] | (buf[p + 1] << 8)) >> (bit & 7)) & 0x7f) << sh) + min;
            pix[i] = x > 0x7ff ? 0x7ff : x;
            bit += 7;
          }
        }
        const col0 = (blk >> 1) * 32 + (blk & 1);
        for (let i = 0; i < 16; i++) {
          const col = col0 + 2 * i;
          if (col < w) out[dst + col] = curve[pix[i] << 1];
        }
      }
    }
  }
  return { w, h, data: out };
}

/**
 * Samsung SRW, Kompression 32770 mit Zeilentabelle (NX300, NX2000, NX1000 …). Aufbau (Reverse Engineering, siehe
 * THIRD_PARTY.md): Tag 0xa010 zeigt auf eine Tabelle mit dem Beginn jeder Zeile (32 bit, relativ zu den Daten).
 * Je Zeile Blöcke zu 16 Pixeln: 1 bit Richtung (von oben oder von links vorhersagen), je Gruppe 2 bit Änderung der
 * Bitlänge (gleich, +1, −1, neu mit 4 bit; Startlänge 7 in den ersten zwei Zeilen, sonst 4), dann die Differenzen mit
 * Vorzeichen – erst die 8 geraden, dann die 8 ungeraden Positionen. Vorhersage von oben: 1 bzw. 2 Zeilen höher,
 * von links: letzter Wert gleicher Parität des vorigen Blocks (am Zeilenanfang 128). Zum Schluss werden in jedem
 * 2×2-Feld die Pixel oben rechts und unten links getauscht.
 */
export async function decodeSamsung1(b: Blob, t: Tags, w: number, h: number): Promise<Sensor> {
  const dataOff = t.get(0x111)![0], dataLen = t.get(0x117)![0];
  const tab = await bytes(b, t.get(0xa010)![0], h * 4);
  const tv = new DataView(tab.buffer, tab.byteOffset, tab.byteLength);
  const data = await bytes(b, dataOff, dataLen);
  const out = new Int32Array(w * h);
  const len = [0, 0, 0, 0];
  for (let row = 0; row < h; row++) {
    const bits = wordBits(data, tv.getUint32(row * 4, true));
    len.fill(row < 2 ? 7 : 4);
    const r = row * w;
    for (let col = 0; col < w; col += 16) {
      const dir = bits(1);
      const op = [bits(2), bits(2), bits(2), bits(2)];
      for (let c = 0; c < 4; c++) {
        if (op[c] === 3) len[c] = bits(4);
        else if (op[c] === 2) len[c]--;
        else if (op[c] === 1) len[c]++;
      }
      for (let k = 0; k < 16; k++) {
        const c = k < 8 ? 2 * k : 2 * (k - 8) + 1; // erst gerade, dann ungerade Positionen
        const n = len[((c & 1) << 1) | (c >> 3)];
        let d = n > 0 ? bits(n) : 0;
        if (n > 0 && d >= 1 << (n - 1)) d -= 1 << n;
        let pred: number;
        if (dir) {
          const up = row - (c & 1 ? 2 : 1);
          pred = up >= 0 ? out[up * w + col + c] : 0;
        } else pred = col ? out[r + col - (c & 1 ? 1 : 2)] : 128;
        if (col + c < w) out[r + col + c] = pred + d;
      }
    }
  }
  const res = new Uint16Array(w * h);
  for (let i = 0; i < res.length; i++) { const v = out[i]; res[i] = v < 0 ? 0 : v > 65535 ? 65535 : v; }
  for (let row = 0; row + 1 < h; row += 2)
    for (let col = 0; col + 1 < w; col += 2) {
      const a = row * w + col + 1, c = (row + 1) * w + col;
      const tmp = res[a]; res[a] = res[c]; res[c] = tmp;
    }
  return { w, h, data: res };
}

/** Unkomprimiert, 16 bit je Wert (oder 12/14 bit in 16-bit-Containern). */
async function decodeUncompressed(b: Blob, t: Tags, w: number, h: number, le: boolean): Promise<Sensor | null> {
  const offs = t.get(0x111) ?? [], cnts = t.get(0x117) ?? [];
  const total = cnts.reduce((a, c) => a + c, 0);
  if (total < w * h * 2) return null; // gepackte 12-bit-Daten: noch nicht
  const data = new Uint16Array(w * h);
  let p = 0;
  for (let k = 0; k < offs.length && p < data.length; k++) {
    const raw = await bytes(b, offs[k], cnts[k]);
    const v = new DataView(raw.buffer);
    for (let o = 0; o + 1 < raw.length && p < data.length; o += 2) data[p++] = v.getUint16(o, le);
  }
  return { w, h, data };
}

/**
 * Nikon-komprimierte NEF (Kompression 34713). Aufbau laut öffentlicher Formatbeschreibung (Reverse Engineering,
 * dokumentiert u. a. in RawSpeed und ExifTool): Huffman-kodierte Differenzen je Farbspalte, Startwerte und eine
 * Kennlinie aus der MakerNote (Tag 0x0096), ab einer Zeile ("split") ein zweiter Codebaum. Die Codebäume sind
 * Formatkonstanten: je 16 Anzahlen (Codelänge 1 bis 16), dann die Symbole (Länge der Differenz, ggf. mit Shift).
 */
const NIKON_TREES: number[][] = [
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 4, 3, 6, 2, 7, 1, 0, 8, 9, 11, 10, 12], // 12 bit verlustbehaftet
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0x39, 0x5a, 0x38, 0x27, 0x16, 5, 4, 3, 2, 1, 0, 11, 12, 12], // 12 bit, nach split
  [0, 1, 4, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 11, 12], // 12 bit verlustfrei
  [0, 1, 4, 3, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 6, 4, 7, 8, 3, 9, 2, 1, 0, 10, 11, 12, 13, 14], // 14 bit verlustbehaftet
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 8, 0x5c, 0x4b, 0x3a, 0x29, 7, 6, 5, 4, 3, 2, 1, 0, 13, 14], // 14 bit, nach split
  [0, 1, 4, 2, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 7, 6, 8, 5, 9, 4, 10, 3, 11, 12, 2, 0, 1, 13, 14], // 14 bit verlustfrei
];

function nikonLut(tree: number[]): Uint32Array {
  const lut = new Uint32Array(1 << 16);
  let code = 0, k = 16;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < tree[len - 1]; i++) {
      const sym = tree[k++];
      const shift = 16 - len;
      for (let c = code << shift; c < (code + 1) << shift; c++) lut[c] = (len << 8) | sym;
      code++;
    }
    code <<= 1;
  }
  return lut;
}

interface NikonNote { base: number; le: boolean; tags: Map<number, { type: number; count: number; off: number }> }

async function nikonMakernote(b: Blob, ifds: Ifd[], le: boolean): Promise<NikonNote | null> {
  const exifPtr = ifds[0]?.tags.get(0x8769)?.[0];
  if (!exifPtr) return null;
  const n = new DataView((await bytes(b, exifPtr, 2)).buffer).getUint16(0, le);
  const raw = await bytes(b, exifPtr + 2, n * 12);
  const v = new DataView(raw.buffer);
  let mnOff = 0;
  for (let i = 0; i < n; i++) if (v.getUint16(i * 12, le) === 0x927c) mnOff = v.getUint32(i * 12 + 8, le);
  if (!mnOff) return null;
  const head = await bytes(b, mnOff, 18);
  if (String.fromCharCode(...head.subarray(0, 5)) !== "Nikon") return null;
  const base = mnOff + 10;
  const mle = head[10] === 0x49;
  const first = new DataView(head.buffer).getUint32(14, mle);
  const cnt = new DataView((await bytes(b, base + first, 2)).buffer).getUint16(0, mle);
  const ents = await bytes(b, base + first + 2, cnt * 12);
  const ev = new DataView(ents.buffer);
  const tags = new Map<number, { type: number; count: number; off: number }>();
  for (let i = 0; i < cnt && i * 12 + 12 <= ents.length; i++) {
    const tag = ev.getUint16(i * 12, mle), type = ev.getUint16(i * 12 + 2, mle), count = ev.getUint32(i * 12 + 4, mle);
    const size = type === 3 || type === 8 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 1;
    tags.set(tag, { type, count, off: size * count <= 4 ? base + first + 2 + i * 12 + 8 : base + ev.getUint32(i * 12 + 8, mle) });
  }
  return { base, le: mle, tags };
}

async function decodeNikon(b: Blob, ifds: Ifd[], le: boolean, t: Tags, w: number, h: number, bps: number): Promise<{ sensor: Sensor; white: number; wb?: [number, number, number] } | null> {
  const mn = await nikonMakernote(b, ifds, le);
  const lin = mn?.tags.get(0x0096);
  if (!mn || !lin) return null;
  const meta = await bytes(b, lin.off, Math.max(lin.count, 600));
  const mv = new DataView(meta.buffer);
  const u16 = (o: number) => mv.getUint16(o, mn.le);
  const ver0 = meta[0], ver1 = meta[1];
  let p = 2;
  if (ver0 === 0x49 || ver1 === 0x58) p += 2110;
  let tree = ver0 === 0x46 ? 2 : 0;
  if (bps === 14) tree += 3;
  const vpred = [[u16(p), u16(p + 2)], [u16(p + 4), u16(p + 6)]];
  p += 8;
  let max = (1 << bps) & 0x7fff;
  const curve = new Uint16Array(0x10000);
  for (let i = 0; i < curve.length; i++) curve[i] = i;
  const csize = u16(p);
  p += 2;
  let split = 0;
  const step = csize > 1 ? Math.floor(max / (csize - 1)) : 0;
  if (ver0 === 0x44 && ver1 === 0x20 && step > 0) {
    for (let i = 0; i < csize; i++) curve[i * step] = u16(p + 2 * i);
    for (let i = 0; i < max; i++) {
      const r = i % step;
      curve[i] = Math.floor((curve[i - r] * (step - r) + curve[i - r + step] * r) / step);
    }
    split = u16(562);
  } else if (ver0 !== 0x46 && csize <= 0x4001) {
    max = csize;
    for (let i = 0; i < csize; i++) curve[i] = u16(p + 2 * i);
  }
  while (max > 2 && curve[max - 2] === curve[max - 1]) max--;
  const white = curve[max - 1];
  // Weissabgleich der Kamera: Tag 0x000C (WB_RBLevels), Rationale für Rot und Blau
  let wb: [number, number, number] | undefined;
  const wbTag = mn.tags.get(0x000c);
  if (wbTag && wbTag.type === 5 && wbTag.count >= 2) {
    const r = new DataView((await bytes(b, wbTag.off, 16)).buffer);
    const rat = (o: number) => r.getUint32(o, mn.le) / (r.getUint32(o + 4, mn.le) || 1);
    const red = rat(0), blue = rat(8);
    if (red > 0.2 && red < 8 && blue > 0.2 && blue < 8) wb = [red, 1, blue];
  }

  const data = await bytes(b, t.get(0x111)![0], t.get(0x117)![0]);
  let lut = nikonLut(NIKON_TREES[tree]);
  // Bitleser ohne Byte-Stuffing (anders als JPEG)
  let pos = 0, buf = 0, cnt = 0;
  const need = (n: number) => { while (cnt < n) { buf = ((buf << 8) | (pos < data.length ? data[pos++] : 0)) >>> 0; cnt += 8; } };
  const drop = (n: number) => { cnt -= n; buf = cnt >= 32 ? buf : (buf & ((1 << cnt) - 1)) >>> 0; };
  const getBits = (n: number) => {
    if (n <= 0) return 0;
    need(n);
    const v = (buf >>> (cnt - n)) & ((1 << n) - 1);
    drop(n);
    return v;
  };
  const out = new Uint16Array(w * h);
  const hpred = [0, 0];
  for (let row = 0; row < h; row++) {
    if (split && row === split) {
      lut = nikonLut(NIKON_TREES[tree + 1]);
      max += 32;
    }
    for (let col = 0; col < w; col++) {
      need(16);
      const e = lut[(buf >>> (cnt - 16)) & 0xffff];
      const clen = e >>> 8;
      if (!clen) throw new Error("NEF: ungültiger Huffman-Code");
      drop(clen);
      const sym = e & 0xff;
      const len = sym & 15, shl = sym >> 4;
      let diff = 0;
      if (len) {
        diff = (((getBits(len - shl) << 1) + 1) << shl) >> 1;
        if ((diff & (1 << (len - 1))) === 0) diff -= (1 << len) - (shl ? 0 : 1);
      }
      if (col < 2) hpred[col] = vpred[row & 1][col] += diff;
      else hpred[col & 1] += diff;
      const hv = (hpred[col & 1] << 16) >> 16; // vorzeichenbehaftete 16-bit-Zahl
      out[row * w + col] = curve[hv < 0 ? 0 : hv > 0x3fff ? 0x3fff : hv];
    }
  }
  return { sensor: { w, h, data: out }, white, wb };
}

/**
 * Samsung SRW, Kompression 32773 ("Version 3", NX1/NX500). Aufbau laut öffentlicher Formatbeschreibung
 * (Reverse Engineering): je Zeile auf 16 Byte ausgerichtet, Bits aus 32-bit-Wörtern (Little Endian, höchstes
 * Bit zuerst); Blöcke zu 16 Pixeln mit eigener Vorhersageart, Bitlängen je 4 Pixel und einem Verstärkungsfaktor.
 */
async function decodeSamsung3(b: Blob, t: Tags, w: number, h: number, bps: number): Promise<{ sensor: Sensor; black: number }> {
  const data = await bytes(b, t.get(0x111)![0], t.get(0x117)![0]);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opt = data[9];
  const init = dv.getUint16(12, true);
  let pos = 14; // Byte-Position (ganze 32-bit-Wörter werden gelesen)
  let word = 0, left = 0; // aktuelles Wort und noch ungelesene Bits darin
  const bits = (n: number): number => {
    if (n <= 0) return 0;
    let v = 0;
    while (n > 0) {
      if (left === 0) {
        word = pos + 4 <= data.length ? dv.getUint32(pos, true) : 0;
        pos += 4;
        left = 32;
      }
      const take = Math.min(n, left);
      v = (v << take) | ((word >>> (left - take)) & ((1 << take) - 1));
      left -= take;
      n -= take;
    }
    return v >>> 0;
  };
  const raw = new Uint16Array(w * h);
  const at = (r: number, c: number) => raw[r * w + (c < 0 ? 0 : c >= w ? w - 1 : c)];
  const OFF1 = [-4, -2, -2, 0, 0, 2, 4], OFF2 = [-4, -2, 0, 0, 2, 2, 4];
  const MAG = [0, -2, 2], LEN = [0, 1, -1];
  const len = [0, 0, 0, 0];
  for (let row = 0; row < h; row++) {
    pos = (pos + 15) & ~15; // Zeilenanfang auf 16 Byte
    left = 0;
    let mag = 0, pmode = 7;
    const a = row < 2 ? 7 : 4;
    const lent = [[a, a], [a, a], [a, a]];
    const odd = row & 1;
    for (let tab = 0; tab + 15 < w; tab += 16) {
      if (!(opt & 4) && !(tab & 63)) {
        const i = bits(2);
        mag = i < 3 ? mag + MAG[i] : bits(12);
      }
      if (opt & 2) pmode = 7 - 4 * bits(1);
      else if (!bits(1)) pmode = bits(3);
      if (opt & 1 || !bits(1)) {
        for (let c = 0; c < 4; c++) len[c] = bits(2);
        for (let c = 0; c < 4; c++) {
          const i = ((odd << 1) | (c & 1)) % 3;
          len[c] = len[c] < 3 ? lent[i][0] + LEN[len[c]] : bits(4);
          lent[i][0] = lent[i][1];
          lent[i][1] = len[c];
        }
      }
      for (let c = 0; c < 16; c++) {
        const col = tab + ((((c & 7) << 1) ^ (c >> 3)) ^ odd);
        let pred: number;
        if (pmode === 7 || row < 2) pred = tab ? at(row, tab - 2 + (col & 1)) : init;
        else if ((col & 1) === odd) {
          // gleiche Farbe (Grün) in der Zeile darüber, um ein Pixel versetzt
          const shift = 1 - (odd << 1);
          pred = (at(row - 1, col + OFF1[pmode] + shift) + at(row - 1, col + OFF2[pmode] + shift) + 1) >> 1;
        } else {
          // Rot/Blau: zwei Zeilen darüber
          pred = (at(row - 2, col + OFF1[pmode]) + at(row - 2, col + OFF2[pmode]) + 1) >> 1;
        }
        const n = len[c >> 2];
        let diff = bits(n);
        if (n && diff >> (n - 1)) diff -= 1 << n;
        diff = diff * (mag * 2 + 1) + mag;
        raw[row * w + col] = (pred + diff) & 0xffff;
      }
    }
  }
  // Schwarzwert: 128 bei 14 bit, 32 bei 12 bit (gemessen an eigenen NX500-Aufnahmen und den CC0-Mustern auf
  // raw.pixls.us). Der Startwert der Vorhersage ist in beiden Fällen 128 – er ist also nicht der Schwarzwert.
  void init;
  return { sensor: { w, h, data: raw }, black: 128 >> Math.max(0, 14 - bps) };
}

/** Samsung-MakerNote (IFD, Verweise relativ zum Anfang der MakerNote): sichtbarer Bereich, Weissabgleich. */
async function samsungInfo(b: Blob, ifds: Ifd[], le: boolean): Promise<{ crop?: { left: number; top: number; right: number; bottom: number }; wb?: [number, number, number]; black?: number }> {
  const exifPtr = ifds[0]?.tags.get(0x8769)?.[0];
  if (!exifPtr) return {};
  const n = new DataView((await bytes(b, exifPtr, 2)).buffer).getUint16(0, le);
  const ent = await bytes(b, exifPtr + 2, n * 12);
  const ev = new DataView(ent.buffer);
  let mn = 0;
  for (let i = 0; i < n; i++) if (ev.getUint16(i * 12, le) === 0x927c) mn = ev.getUint32(i * 12 + 8, le);
  if (!mn) return {};
  const cnt = new DataView((await bytes(b, mn, 2)).buffer).getUint16(0, le);
  if (!cnt || cnt > 500) return {};
  const raw = await bytes(b, mn + 2, cnt * 12);
  const v = new DataView(raw.buffer);
  const vals = async (tag: number): Promise<number[] | null> => {
    for (let i = 0; i < cnt; i++) {
      if (v.getUint16(i * 12, le) !== tag) continue;
      const type = v.getUint16(i * 12 + 2, le), count = v.getUint32(i * 12 + 4, le);
      if (type !== 4 && type !== 9) return null;
      const src = count <= 1 ? raw.subarray(i * 12 + 8, i * 12 + 12) : await bytes(b, mn + v.getUint32(i * 12 + 8, le), count * 4);
      const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      return Array.from({ length: count }, (_, k) => (type === 9 ? sv.getInt32(k * 4, le) : sv.getUint32(k * 4, le)));
    }
    return null;
  };
  const out: { crop?: { left: number; top: number; right: number; bottom: number }; wb?: [number, number, number]; black?: number } = {};
  const area = await vals(0xa010); // Sensor gesamt (4 Werte), dann sichtbarer Bereich
  if (area?.length === 8 && area[6] > 0 && area[7] > 0) out.crop = { left: area[4], top: area[5], right: area[4] + area[6], bottom: area[5] + area[7] };
  const lv = await vals(0xa021), bk = await vals(0xa028); // Weissabgleich: Werte minus Schwarz, Reihenfolge R G G B
  if (lv?.length === 4) {
    const k = bk?.length === 4 ? bk : [0, 0, 0, 0];
    if (bk?.length === 4) out.black = (bk[0] + bk[1] + bk[2] + bk[3]) / 4;
    const r = lv[0] - k[0], g = (lv[1] - k[1] + lv[2] - k[2]) / 2, bl = lv[3] - k[3];
    if (r > 0 && g > 0 && bl > 0) out.wb = [r / g, 1, bl / g];
  }
  return out;
}

/** Canon-MakerNote: SensorInfo (0x00e0) mit sichtbarem Bereich. */
async function canonSensorArea(b: Blob, ifds: Ifd[], le: boolean): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  // MakerNote liegt im Exif-IFD; dieses wird über 0x8769 von IFD0 erreicht
  const exifPtr = ifds[0]?.tags.get(0x8769)?.[0];
  let mnOff = 0;
  if (exifPtr) {
    const n = new DataView((await bytes(b, exifPtr, 2)).buffer).getUint16(0, le);
    const raw = await bytes(b, exifPtr + 2, n * 12);
    const v = new DataView(raw.buffer);
    for (let i = 0; i < n; i++) if (v.getUint16(i * 12, le) === 0x927c) mnOff = v.getUint32(i * 12 + 8, le);
  }
  if (!mnOff) return null;
  const n = new DataView((await bytes(b, mnOff, 2)).buffer).getUint16(0, le);
  const raw = await bytes(b, mnOff + 2, n * 12);
  const v = new DataView(raw.buffer);
  for (let i = 0; i < n; i++) {
    if (v.getUint16(i * 12, le) !== 0x00e0) continue;
    const cnt = v.getUint32(i * 12 + 4, le), off = v.getUint32(i * 12 + 8, le);
    const s = new DataView((await bytes(b, off, cnt * 2)).buffer);
    const g = (k: number) => s.getUint16(k * 2, le);
    return { left: g(5), top: g(6), right: g(7), bottom: g(8) };
  }
  return null;
}

/** Mittlerer Wert eines Randstreifens (abgedeckte Sensorpixel = Schwarzwert). */
function borderBlack(s: Sensor, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x++) { sum += s.data[y * s.w + x]; n++; }
  return n ? sum / n : 0;
}

export interface DecodedRaw {
  frame: Frame;
  info: RawInfo;
}

// ---------- Fujifilm RAF ----------
// Aufbau laut öffentlicher Formatbeschreibung (ExifTool-Tagtabellen „FujiFilm RAF“ und „FujiIFD“), Lage des
// Farbmusters und Zuschnitt mit einer echten X-T4-Datei gegen das eingebettete Kamerabild geprüft:
// - Kopf "FUJIFILMCCD-RAW ", ab 0x54 (big-endian): JPEG-Offset/-Länge, Offset/Länge der Rohdaten-Kopfsätze,
//   Offset/Länge des Rohdatenblocks (ein TIFF mit dem Fuji-IFD 0xf000)
// - Kopfsätze (Tag, Länge, Daten): 0x100 Sensorgrösse (Höhe, Breite), 0x110 Zuschnitt oben/links,
//   0x111 sichtbare Grösse (Höhe, Breite), 0x131 X-Trans-Muster (36 Byte, rückwärts gelesen ab Sensorpunkt 0,0)
// - Fuji-IFD: 0xf001/0xf002 Breite/Höhe, 0xf003 Bit, 0xf007/0xf008 Offset/Länge der Daten, 0xf00a Schwarzwerte,
//   0xf00e (sonst 0xf00d) Weissabgleich G, R, B
// Gelesen werden unkomprimierte Daten: 16 bit je Wert oder dicht gepackt (z. B. 14 bit bei der X-A5, höchstes Bit
// zuerst). Ohne X-Trans-Satz 0x131 hat die Kamera einen Bayer-Sensor; das Muster steht nicht in der Datei (siehe
// RAF_BAYER). Die Fuji-Kompression ist nicht öffentlich beschrieben.

const RAF_MAGIC = "FUJIFILMCCD-RAW";

/**
 * Bayer-Muster der Fujifilm-Kameras mit Bayer-Sensor ab Sensorpunkt (0,0), 0 R, 1 G, 2 B. Gegen das eingebettete
 * Kamerabild bestimmt (X-A5: Farbkorrelation siehe docs/testdaten.md).
 */
const RAF_BAYER = [0, 1, 1, 2];

interface RafRaw {
  sensor: Sensor;
  /** X-Trans: 36 Werte; Bayer: 4 Werte */
  pattern: number[];
  crop: { left: number; top: number; right: number; bottom: number };
  black: number;
  white: number;
  wb?: [number, number, number];
}

async function decodeRaf(b: Blob): Promise<RafRaw | "compressed" | null> {
  const head = await bytes(b, 0, 0x6c);
  const hv = new DataView(head.buffer);
  const hdrOff = hv.getUint32(0x5c), hdrLen = hv.getUint32(0x60), cfaOff = hv.getUint32(0x64);
  const hdr = await bytes(b, hdrOff, Math.min(hdrLen, 1 << 16));
  const dv = new DataView(hdr.buffer);
  const rec = new Map<number, Uint8Array>();
  for (let o = 4, k = 0, n = dv.getUint32(0); k < n && o + 4 <= hdr.length; k++) {
    const tag = dv.getUint16(o), size = dv.getUint16(o + 2);
    rec.set(tag, hdr.subarray(o + 4, o + 4 + size));
    o += 4 + size;
  }
  const u16 = (tag: number, i: number) => { const r = rec.get(tag); return r && r.length >= 2 * i + 2 ? (r[2 * i] << 8) | r[2 * i + 1] : undefined; };
  const xt = rec.get(0x131);
  if (xt && xt.length !== 36) return null;
  const { le, ifds } = await readTiff(b, cfaOff);
  const fuji = ifds.find((i) => i.tags.has(0xf001));
  if (!fuji) return null;
  const t = fuji.tags;
  const w = t.get(0xf001)![0], h = t.get(0xf002)![0], bps = t.get(0xf003)?.[0] ?? 14;
  const off = t.get(0xf007)?.[0], len = t.get(0xf008)?.[0];
  if (!w || !h || off === undefined || len === undefined) return null;
  let data: Uint16Array;
  if (len >= w * h * 2) {
    const raw = await bytes(b, cfaOff + off, w * h * 2);
    const v = new DataView(raw.buffer);
    data = new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = v.getUint16(2 * i, le);
  } else if (len * 8 === w * h * bps) {
    data = unpackBits(await bytes(b, cfaOff + off, len), w, h, bps, (w * bps) / 8, true); // dicht gepackt
  } else return "compressed";
  const top = u16(0x110, 0) ?? 0, left = u16(0x110, 1) ?? 0;
  const ch = u16(0x111, 0) ?? h - top, cw = u16(0x111, 1) ?? w - left;
  const bl = t.get(0xf00a);
  const g = t.get(0xf00e) ?? t.get(0xf00d); // G, R, B
  return {
    sensor: { w, h, data },
    pattern: xt ? Array.from(xt).reverse().map((c) => c & 3) : RAF_BAYER,
    crop: { left, top, right: left + cw, bottom: top + ch },
    black: bl?.length ? bl.reduce((a, c) => a + c, 0) / bl.length : 0,
    white: (1 << bps) - 1,
    wb: g?.length === 3 && g[0] > 0 ? [g[1] / g[0], 1, g[2] / g[0]] : undefined,
  };
}

/**
 * Farbrekonstruktion für X-Trans (6×6-Muster): Grün als Mittel der grünen Nachbarn im 3×3-Fenster, Rot und Blau
 * als Grün plus mittlere Differenz (Farbe − Grün) der gleichfarbigen Nachbarn im 3×3-Fenster. In jedem 3×3-Fenster
 * des X-Trans-Musters liegt mindestens ein Pixel jeder Farbe. pattern gilt ab (−ox, −oy), d. h. die Farbe am
 * Ausgabepunkt (x, y) ist pattern[((y + oy) % 6) * 6 + (x + ox) % 6] (0 R, 1 G, 2 B). Ergebnis: RGB verschachtelt.
 */
export function demosaicXTrans(m: Uint16Array, w: number, h: number, pattern: number[], ox = 0, oy = 0): Uint16Array {
  const col = (x: number, y: number) => pattern[((y + oy) % 6) * 6 + ((x + ox) % 6)];
  // Nachbarn je Musterposition und Farbe als Versätze im Bild (nur für Pixel mit vollem 3×3-Fenster)
  const nb: Int32Array[][] = [];
  for (let py = 0; py < 6; py++)
    for (let px = 0; px < 6; px++) {
      const lists: number[][] = [[], [], []];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          lists[pattern[((py + dy + 6) % 6) * 6 + ((px + dx + 6) % 6)]].push(dy * w + dx);
        }
      nb[py * 6 + px] = lists.map((l) => Int32Array.from(l));
    }
  const phase = (x: number, y: number) => ((y + oy) % 6) * 6 + ((x + ox) % 6);
  const inner = (x: number, y: number) => x > 0 && y > 0 && x < w - 1 && y < h - 1;
  /** Mittel über die gleichfarbigen Nachbarn (Rand: nur vorhandene) von f(j) */
  const mean = (x: number, y: number, c: number, f: (j: number) => number): number | null => {
    let s = 0, n = 0;
    if (inner(x, y)) {
      const i = y * w + x, l = nb[phase(x, y)][c];
      for (let k = 0; k < l.length; k++) s += f(i + l[k]);
      n = l.length;
    } else {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && col(xx, yy) === c) { s += f(yy * w + xx); n++; }
        }
    }
    return n ? s / n : null;
  };
  const g = new Uint16Array(w * h);
  const fm = (j: number) => m[j];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      g[i] = col(x, y) === 1 ? m[i] : Math.round(mean(x, y, 1, fm) ?? m[i]);
    }
  const out = new Uint16Array(w * h * 3);
  const diff = (j: number) => m[j] - g[j];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c0 = col(x, y);
      out[i * 3 + 1] = g[i];
      for (let c = 0; c <= 2; c += 2) {
        const v = c0 === c ? m[i] : g[i] + (mean(x, y, c, diff) ?? 0);
        out[i * 3 + c] = v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v);
      }
    }
  return out;
}

/**
 * X-Trans-Sensordaten fertigstellen: zuschneiden (beliebige Kanten), Schwarz/Weiss normieren, Weissabgleich,
 * Farbe rekonstruieren. Ergebnis: lineares RGB mit 16 bit. pattern gilt ab Sensorpunkt (0,0).
 */
function finishXTrans(
  sensor: Sensor, pattern: number[], crop: { left: number; top: number; right: number; bottom: number },
  black: number, white: number, wb: [number, number, number] | undefined, format: string, cameraWb?: [number, number, number],
): DecodedRaw | null {
  const left = Math.max(0, crop.left), top = Math.max(0, crop.top);
  const ow = Math.min(sensor.w, crop.right) - left, oh = Math.min(sensor.h, crop.bottom) - top;
  if (ow < 16 || oh < 16) return null;
  const range = Math.max(1, white - black);
  const gain = wb ?? [1, 1, 1];
  const maxGain = Math.max(...gain);
  const scale = gain.map((g) => (65535 / range) * (g / maxGain));
  const clip = black + 0.97 * range;
  const ox = left % 6, oy = top % 6;
  const m = new Uint16Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const src = (top + y) * sensor.w + left, row = ((y + oy) % 6) * 6;
    for (let x = 0; x < ow; x++) {
      const raw = sensor.data[src + x];
      if (raw >= clip) { m[y * ow + x] = 65535; continue; }
      const v = (raw - black) * scale[pattern[row + ((x + ox) % 6)]];
      m[y * ow + x] = v <= 0 ? 0 : v >= 65535 ? 65535 : v;
    }
  }
  const data = demosaicXTrans(m, ow, oh, pattern, ox, oy);
  return {
    frame: { width: ow, height: oh, planes: 3, bitDepth: 16, colorId: SerColor.RGB, data },
    info: { format, width: ow, height: oh, colorId: SerColor.RGB, cameraWb },
  };
}

/** Komprimierte Formate ohne öffentliche Beschreibung (für den Hinweis „in DNG umwandeln“) */
export async function rawUnsupported(b: Blob): Promise<"CR3" | "RAF" | null> {
  const head = await bytes(b, 0, 16);
  const s = String.fromCharCode(...head);
  if (s.slice(4, 12) === "ftypcrx ") return "CR3";
  if (s.startsWith(RAF_MAGIC) && (await decodeRaf(b).catch(() => null)) === "compressed") return "RAF";
  return null;
}

/**
 * Sensordaten eines RAW oder null, wenn das Format (noch) nicht unterstützt wird.
 * wb: Faktoren für R, G, B (G = 1); ohne Angabe bleibt das Mosaik unverändert.
 */
export async function decodeRawData(b: Blob, wb?: [number, number, number]): Promise<DecodedRaw | null> {
  const head = await bytes(b, 0, 16);
  let sensor: Sensor | null = null;
  let format = "";
  let cfa = [0, 1, 1, 2];
  let black = 0, white = 0;
  let crop = { left: 0, top: 0, right: 0, bottom: 0 };
  let nikonWhite: number | undefined;
  let samsungBlack: number | undefined;
  let cameraWb: [number, number, number] | undefined;
  let nikonCrop: { left: number; top: number; right: number; bottom: number } | undefined;
  if (String.fromCharCode(...head.subarray(0, 15)) === RAF_MAGIC) {
    const r = await decodeRaf(b);
    if (!r || r === "compressed") return null;
    if (r.pattern.length === 36) return finishXTrans(r.sensor, r.pattern, r.crop, r.black, r.white, wb, "RAF uncompressed", r.wb);
    // Bayer-RAF: weiter wie die übrigen Bayer-Formate
    ({ sensor, crop, black, white } = r);
    cfa = r.pattern;
    cameraWb = r.wb;
    format = "RAF uncompressed (Bayer)";
  } else if (!((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d))) return null;
  const { le, ifds } = sensor ? { le: true, ifds: [] as Ifd[] } : await readTiff(b);

  // Canon CR2: IFD mit Streifen-Angabe 0xc640
  const cr2 = ifds.find((i) => i.tags.has(0xc640));
  // Rohdaten-IFD: Farbmosaik (Photometric 32803) oder – wie bei Samsung – nur mit Farbmuster-Tag
  const cfaIfd = sensor ? undefined : ifds.find((i) => (i.tags.get(0x106)?.[0] === 32803 || (i.tags.has(0x828e) && i.tags.has(0x100))) && (i.tags.get(0xfe)?.[0] ?? 0) === 0);
  if (sensor) {
    // Bayer-RAF: schon gelesen
  } else if (cr2) {
    const t = cr2.tags;
    const lj = decodeLjpeg(await bytes(b, t.get(0x111)![0], t.get(0x117)![0]));
    sensor = unslice(lj, t.get(0xc640)!);
    format = "CR2";
    const area = await canonSensorArea(b, ifds, le);
    if (area && area.right < sensor.w && area.bottom < sensor.h) {
      crop = { left: area.left, top: area.top, right: area.right + 1, bottom: area.bottom + 1 };
      // Canon: RGGB beginnt am sichtbaren Bereich, nicht am Sensoranfang
      cfa = shiftCfa([0, 1, 1, 2], -area.left, -area.top);
      black = borderBlack(sensor, 4, Math.max(8, area.left - 4), area.top, area.bottom);
    } else {
      crop = { left: 0, top: 0, right: sensor.w, bottom: sensor.h };
      black = 0;
    }
    white = (1 << lj.precision) - 1;
  } else if (cfaIfd) {
    const t = cfaIfd.tags;
    const w = t.get(0x100)![0], h = t.get(0x101)![0], comp = t.get(0x103)?.[0] ?? 1, bps = t.get(0x102)?.[0] ?? 16;
    if (t.get(0x828e)?.length === 4) cfa = t.get(0x828e)!;
    if (comp === 7 && t.has(0x144)) {
      sensor = await decodeTiles(b, t, t.get(0x142)![0], t.get(0x143)![0], w, h);
      format = t.has(0x7310) ? "ARW lossless" : "DNG lossless";
    } else if (comp === 7 && t.has(0x111)) {
      const rps = t.get(0x116)?.[0] ?? h;
      sensor = await decodeTiles(b, new Map([[0x144, t.get(0x111)!], [0x145, t.get(0x117)!]]), w, rps, w, h);
      format = "DNG lossless";
    } else if (comp === 1) {
      sensor = await decodeUncompressed(b, t, w, h, le);
      format = "uncompressed";
    } else if (comp === 32767) {
      // Sony: 1 Byte je Pixel = verlustbehaftet („cRAW“), 2 Byte = unkomprimiert
      const total = (t.get(0x117) ?? []).reduce((a, c) => a + c, 0);
      if (total === w * h) {
        sensor = await decodeSonyLossy(b, t, w, h);
        format = "ARW compressed";
      } else if (total >= w * h * 2) {
        sensor = await decodeUncompressed(b, t, w, h, le);
        format = "ARW uncompressed";
      } else return null;
    } else if (comp === 32770 || comp === 32769) {
      // Samsung: gepackt (NX100-Familie) oder mit Zeilentabelle komprimiert (NX300-Familie)
      const total = t.get(0x117)?.[0] ?? 0;
      if (total * 8 >= w * h * bps && (bps === 12 || bps === 14)) {
        sensor = { w, h, data: unpackBits(await bytes(b, t.get(0x111)![0], total), w, h, bps, Math.floor(total / h)) };
        format = "SRW packed";
      } else if (t.has(0xa010)) {
        sensor = await decodeSamsung1(b, t, w, h);
        format = "SRW compressed";
        // Das Farbmuster im Tag (RGGB) stimmt bei diesem Verfahren nicht: gegen das Kamerabild ist es GRBG
        cfa = [1, 0, 2, 1];
      } else return null;
      const si = await samsungInfo(b, ifds, le);
      // Sichtbarer Bereich: MakerNote, wenn er im Sensor liegt (NX100); bei der NX300-Familie reicht er darüber
      // hinaus – dort gilt die gegen das Kamerabild gemessene Lage (5472 × 3648 ab links 52, oben 29)
      if (si.crop && si.crop.right <= w && si.crop.bottom <= h) nikonCrop = si.crop;
      else if (w === 5546 && h === 3714) nikonCrop = { left: 52, top: 29, right: 52 + 5472, bottom: 29 + 3648 };
      // Schwarzwert 0: an NX100 und NX300 gegen das Kamerabild geprüft (Farbkorrelation 0.95 bzw. 0.65, Weissabgleich
      // wie die Kamera); der Wert 0xa028 der MakerNote passt hier nicht zu den Rohdaten (rund 390)
      samsungBlack = 0;
      cameraWb = si.wb;
    } else if (comp === 34713) {
      const nk = await decodeNikon(b, ifds, le, t, w, h, bps);
      if (!nk) return null;
      sensor = nk.sensor;
      format = "NEF compressed";
      nikonWhite = nk.white;
      cameraWb = nk.wb;
      // Nikon speichert rechts/unten zusätzliche Sensorspalten: auf die Grösse des Kamerabilds zuschneiden
      const pv = await rawPreview(b);
      if (pv && pv.width <= w && pv.height <= h && pv.width > w * 0.9) nikonCrop = { left: 0, top: 0, right: pv.width, bottom: pv.height };
    } else if (comp === 32773) {
      const sg = await decodeSamsung3(b, t, w, h, bps);
      sensor = sg.sensor;
      samsungBlack = sg.black;
      format = "SRW compressed";
      const si = await samsungInfo(b, ifds, le);
      if (si.crop) nikonCrop = si.crop;
      cameraWb = si.wb;
    } else return null; // andere Verfahren (z. B. Samsung 32772): noch nicht
    if (!sensor) return null;
    // Schwarz und Weiss: DNG-Tags, sonst Sony 0x7310
    const bl = t.get(0xc61a) ?? t.get(0x7310);
    black = bl ? bl.reduce((a, c) => a + c, 0) / bl.length : samsungBlack ?? 0;
    white = t.get(0xc61d)?.[0] ?? nikonWhite ?? (1 << bps) - 1;
    const aa = t.get(0xc68d); // ActiveArea: oben, links, unten, rechts
    crop = aa?.length === 4 ? { top: aa[0], left: aa[1], bottom: aa[2], right: aa[3] } : nikonCrop ?? { left: 0, top: 0, right: w, bottom: h };
    const dco = t.get(0xc61f), dcs = t.get(0xc620); // DefaultCrop relativ zum ActiveArea
    if (dco?.length === 2 && dcs?.length === 2) {
      const l = crop.left + Math.round(dco[0]), tp = crop.top + Math.round(dco[1]);
      crop = { left: l, top: tp, right: Math.min(crop.right, l + Math.round(dcs[0])), bottom: Math.min(crop.bottom, tp + Math.round(dcs[1])) };
    }
    // X-Trans im DNG (z. B. aus dem Adobe DNG Converter): 6×6-Muster, Ursprung am Anfang des ActiveArea
    const dim = t.get(0x828d), pat = t.get(0x828e);
    if (dim?.[0] === 6 && dim?.[1] === 6 && pat?.length === 36) {
      const at = aa?.length === 4 ? aa[0] : 0, al = aa?.length === 4 ? aa[1] : 0;
      const m6 = (v: number) => ((v % 6) + 6) % 6;
      const sensorPat = Array.from({ length: 36 }, (_, k) => pat[m6(Math.floor(k / 6) - at) * 6 + m6((k % 6) - al)]);
      return finishXTrans(sensor, sensorPat, crop, black, white, wb, format);
    }
  } else return null;

  // Zuschneiden auf gerade Kanten (Bayer-Muster bleibt eindeutig), Schwarz/Weiss normieren
  const left = crop.left & ~1, top = crop.top & ~1;
  const ow = (Math.min(sensor.w, crop.right) - left) & ~1, oh = (Math.min(sensor.h, crop.bottom) - top) & ~1;
  if (ow < 16 || oh < 16) return null;
  cfa = shiftCfa(cfa, left, top);
  const colorId = CFA_TO_SER[cfa.join(",")] ?? SerColor.BAYER_RGGB;
  const range = Math.max(1, white - black);
  const gain = wb ? [wb[0], wb[1], wb[2]] : [1, 1, 1];
  // Faktor je Mosaikposition (R/G/B nach CFA), so dass Weiss nach dem Abgleich nicht übersteuert
  const maxGain = Math.max(...gain);
  const scale = [0, 1, 2, 3].map((k) => (65535 / range) * (gain[cfa[k]] / maxGain));
  const out = new Uint16Array(ow * oh);
  // Übersteuerte Sensorpixel bleiben weiss – sonst färbt der Weissabgleich ausgebrannte Stellen rosa
  const clip = black + 0.97 * range;
  for (let y = 0; y < oh; y++) {
    const src = (top + y) * sensor.w + left, dst = y * ow;
    const s0 = scale[(y & 1) * 2], s1 = scale[(y & 1) * 2 + 1];
    for (let x = 0; x < ow; x++) {
      const raw = sensor.data[src + x];
      if (raw >= clip) { out[dst + x] = 65535; continue; }
      const v = (raw - black) * (x & 1 ? s1 : s0);
      out[dst + x] = v <= 0 ? 0 : v >= 65535 ? 65535 : v;
    }
  }
  return {
    frame: { width: ow, height: oh, planes: 1, bitDepth: 16, colorId, data: out },
    info: { format, width: ow, height: oh, colorId, cameraWb },
  };
}

/**
 * Weissabgleich aus dem Vergleich mit dem Kamera-JPEG: mittlere Farbe der hellen, nicht übersteuerten Bildteile
 * im JPEG (linearisiert) gegen die Rohdaten. So stimmen die Farben ohne kameraspezifische Tabellen.
 */
export function whiteBalanceFrom(rawFrame: Frame, preview: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray }): [number, number, number] | null {
  const lut = Float64Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const { width: w, height: h, data, colorId } = rawFrame;
  const rgb = rawFrame.planes === 3; // X-Trans: schon farbig rekonstruiert
  const pat = rgb ? [0, 1, 2] : ({ [SerColor.BAYER_RGGB]: [0, 1, 1, 2], [SerColor.BAYER_GRBG]: [1, 0, 2, 1], [SerColor.BAYER_GBRG]: [1, 2, 0, 1], [SerColor.BAYER_BGGR]: [2, 1, 1, 0] } as Record<number, number[]>)[colorId];
  if (!pat) return null;
  // Gleiche Bildstellen vergleichen: Vorschau auf das Sensorformat abbilden (Seitenverhältnis gleich)
  const sx = preview.width / w, sy = preview.height / h;
  const step = Math.max(2, Math.floor(Math.sqrt((w * h) / 400000)) & ~1);
  const pj = [0, 0, 0], pr = [0, 0, 0];
  let n = 0;
  for (let y = 0; y + 1 < h; y += step)
    for (let x = 0; x + 1 < w; x += step) {
      const px = Math.min(preview.width - 1, Math.floor((x + 1) * sx)), py = Math.min(preview.height - 1, Math.floor((y + 1) * sy));
      const q = (py * preview.width + px) * 4;
      const r = preview.rgba[q], g = preview.rgba[q + 1], b = preview.rgba[q + 2];
      const m = Math.max(r, g, b);
      if (m < 40 || m > 235) continue;
      const v = rgb
        ? [data[(y * w + x) * 3], data[(y * w + x) * 3 + 1], data[(y * w + x) * 3 + 2]]
        : [data[y * w + x], data[y * w + x + 1], data[(y + 1) * w + x], data[(y + 1) * w + x + 1]];
      if (Math.max(...v) >= 65000) continue;
      const c = [0, 0, 0], k3 = [0, 0, 0];
      v.forEach((val, k) => { c[pat[k]] += val; k3[pat[k]]++; });
      for (let k = 0; k < 3; k++) pr[k] += c[k] / k3[k];
      pj[0] += lut[r]; pj[1] += lut[g]; pj[2] += lut[b];
      n++;
    }
  if (n < 50 || !pr[1] || !pj[1]) return null;
  const wbR = (pj[0] / pj[1]) / (pr[0] / pr[1]), wbB = (pj[2] / pj[1]) / (pr[2] / pr[1]);
  if (!(wbR > 0.2 && wbR < 6 && wbB > 0.2 && wbB < 6)) return null;
  return [wbR, 1, wbB];
}
