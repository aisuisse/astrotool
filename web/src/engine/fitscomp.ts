// Komprimierte FITS-Bilder lesen („tiled image compression“, Dateien meist .fits.fz, z. B. von fpack, NSO/GONG,
// vielen Observatorien). Eigene Umsetzung nach der Beschreibung im FITS-Standard 4.0 (Abschnitt 10, „Tiled
// image compression“) – kein fremder Code.
// Das Bild steht in einer Binärtabelle (XTENSION = 'BINTABLE', ZIMAGE = T): jede Zeile ist eine Kachel
// (ZTILEn Pixel je Achse), die komprimierten Bytes liegen im Heap und werden über eine Spalte mit variabler
// Länge (TFORM 1PB/1QB) gefunden. Unterstützt: RICE_1, GZIP_1, GZIP_2, NOCOMPRESS; ganzzahlige Bilder und
// quantisierte Gleitkommabilder (ZSCALE/ZZERO, NO_DITHER, SUBTRACTIVE_DITHER_1/2). Nicht: HCOMPRESS_1, PLIO_1.
import type { FitsHeader } from "./fits";
import { msg } from "../i18n";

const num = (h: FitsHeader, k: string, def: number) => (typeof h.get(k) === "number" ? (h.get(k) as number) : def);
const str = (h: FitsHeader, k: string) => (typeof h.get(k) === "string" ? (h.get(k) as string).trim() : undefined);

export interface TiledInfo {
  /** Verfahren, z. B. "RICE_1" */
  type: string;
  zbitpix: number;
  axes: number[];
  tiles: number[];
  /** Tabelle: Zeilenlänge, Zeilen, Beginn des Heaps (relativ zum Datenbeginn) */
  rowBytes: number;
  rows: number;
  heap: number;
  columns: Map<string, { offset: number; code: string; repeat: number; varQ?: boolean }>;
  blocksize: number;
  bytepix: number;
  quantize: "NO_DITHER" | "SUBTRACTIVE_DITHER_1" | "SUBTRACTIVE_DITHER_2" | null;
  dither0: number;
  /** ZSCALE, ZZERO, ZBLANK als Schlüssel (gilt für alle Kacheln, wenn die Spalte fehlt) */
  keys: { ZSCALE?: number; ZZERO?: number; ZBLANK?: number };
}

/** Ist dieser Kopf ein komprimiertes Bild? */
export const isTiledImage = (h: FitsHeader) => str(h, "XTENSION")?.toUpperCase() === "BINTABLE" && h.get("ZIMAGE") === true;

/**
 * Kopf eines komprimierten Bilds → Kopf, wie ihn das unkomprimierte Bild hätte (BITPIX, NAXISn aus ZBITPIX,
 * ZNAXISn; alle anderen Schlüssel wie BZERO, BAYERPAT, DATE-OBS bleiben), dazu die Angaben zum Entpacken.
 */
export function tiledLayout(h: FitsHeader): { header: FitsHeader; info: TiledInfo } {
  const type = (str(h, "ZCMPTYPE") ?? "").toUpperCase().replace("RICE_ONE", "RICE_1");
  if (!["RICE_1", "GZIP_1", "GZIP_2", "NOCOMPRESS"].includes(type)) throw new Error(msg("fitsUnsupported", `ZCMPTYPE = ${type || "?"}`));
  const zbitpix = num(h, "ZBITPIX", 0), naxis = num(h, "ZNAXIS", 0);
  const axes: number[] = [], tiles: number[] = [];
  for (let a = 1; a <= naxis; a++) {
    axes.push(num(h, `ZNAXIS${a}`, 0));
    // Standard: ohne ZTILEn Kachel = eine Zeile
    tiles.push(num(h, `ZTILE${a}`, a === 1 ? num(h, "ZNAXIS1", 0) : 1));
  }
  // Spalten der Tabelle
  const columns: TiledInfo["columns"] = new Map();
  let off = 0;
  for (let c = 1; c <= num(h, "TFIELDS", 0); c++) {
    const name = (str(h, `TTYPE${c}`) ?? "").toUpperCase();
    const form = (str(h, `TFORM${c}`) ?? "").toUpperCase();
    const m = /^(\d*)([LXBIJKAEDCMPQ])([A-Z]?)/.exec(form);
    if (!m) throw new Error(msg("fitsUnsupported", `TFORM${c} = ${form}`));
    const repeat = m[1] === "" ? 1 : Number(m[1]);
    const code = m[2], size = { L: 1, X: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 }[code]!;
    if (code === "P" || code === "Q") columns.set(name, { offset: off, code: m[3] || "B", repeat, varQ: code === "Q" });
    else columns.set(name, { offset: off, code, repeat });
    off += code === "X" ? Math.ceil(repeat / 8) : repeat * size;
  }
  const rowBytes = num(h, "NAXIS1", 0), rows = num(h, "NAXIS2", 0);
  const param = (name: string, def: number) => {
    for (let i = 1; i < 10; i++) if ((str(h, `ZNAME${i}`) ?? "").toUpperCase() === name) return num(h, `ZVAL${i}`, def);
    return def;
  };
  const floatImg = zbitpix < 0;
  const q = (str(h, "ZQUANTIZ") ?? "").toUpperCase();
  const info: TiledInfo = {
    type, zbitpix, axes, tiles, rowBytes, rows, heap: num(h, "THEAP", rowBytes * rows), columns,
    blocksize: param("BLOCKSIZE", 32),
    // gespeicherte Ganzzahlen: bei quantisierten Gleitkommabildern immer 4 Byte
    bytepix: param("BYTEPIX", floatImg ? 4 : Math.abs(zbitpix) / 8),
    quantize: floatImg ? (q === "SUBTRACTIVE_DITHER_1" || q === "SUBTRACTIVE_DITHER_2" ? q : "NO_DITHER") : null,
    dither0: num(h, "ZDITHER0", 1),
    keys: {},
  };
  for (const k of ["ZSCALE", "ZZERO", "ZBLANK"] as const) if (typeof h.get(k) === "number") info.keys[k] = h.get(k) as number;
  const out: FitsHeader = new Map(h);
  for (const k of [...out.keys()]) if (/^(TTYPE|TFORM|TUNIT|TSCAL|TZERO|TNULL|TDIM)\d+$|^(TFIELDS|THEAP|PCOUNT|GCOUNT|XTENSION)$/.test(k)) out.delete(k);
  out.set("BITPIX", zbitpix);
  out.set("NAXIS", naxis);
  for (let a = 1; a <= naxis; a++) out.set(`NAXIS${a}`, axes[a - 1]);
  out.set("XTENSION", "IMAGE");
  return { header: out, info };
}

/** Pixel einer Bildebene (Achsen 1, 2; Index über die höheren Achsen) – in Dateireihenfolge (Zeile 1 zuerst). */
export async function readTiledPlane(file: Blob, dataOffset: number, dataBytes: number, info: TiledInfo, plane: number, planeCount: number): Promise<Float64Array> {
  const [w, h] = [info.axes[0], info.axes[1] ?? 1];
  const n = w * h * planeCount;
  const out = new Float64Array(n);
  const table = new Uint8Array(await file.slice(dataOffset, dataOffset + dataBytes).arrayBuffer());
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  // Kachelraster
  const grid = info.axes.map((ax, i) => Math.ceil(ax / info.tiles[i]));
  const first = plane * planeCount; // erste Ebene (Achse 3 und höher, zusammengefasst)
  const higher = info.axes.slice(2).reduce((a, b) => a * b, 1);
  if (first + planeCount > higher) throw new Error(msg("fitsBad"));
  let row = 0;
  // Kacheln in Tabellenreihenfolge: Achse 1 läuft am schnellsten
  const pos = info.axes.map(() => 0);
  for (row = 0; row < info.rows; row++) {
    // Kachel-Lage
    let r = row;
    for (let a = 0; a < grid.length; a++) { pos[a] = r % grid[a]; r = Math.floor(r / grid[a]); }
    const t0 = pos.map((p, a) => p * info.tiles[a]);
    const tsz = pos.map((_, a) => Math.min(info.tiles[a], info.axes[a] - t0[a]));
    // höhere Achsen (≥ 3) dieser Kachel als Ebenen-Nummern
    let pLo = 0, pHi = 0, mul = 1;
    for (let a = 2; a < info.axes.length; a++) { pLo += t0[a] * mul; pHi += (t0[a] + tsz[a] - 1) * mul; mul *= info.axes[a]; }
    if (pHi < first || pLo >= first + planeCount) continue;
    const vals = await decodeTile(dv, table, row, info, tsz.reduce((a, b) => a * b, 1));
    // in das Ergebnis einsortieren
    let i = 0;
    const idx = tsz.map(() => 0);
    const total = vals.length;
    for (i = 0; i < total; i++) {
      let k = i;
      for (let a = 0; a < tsz.length; a++) { idx[a] = k % tsz[a]; k = Math.floor(k / tsz[a]); }
      const x = t0[0] + idx[0], y = (t0[1] ?? 0) + (idx[1] ?? 0);
      let p = 0; mul = 1;
      for (let a = 2; a < info.axes.length; a++) { p += (t0[a] + idx[a]) * mul; mul *= info.axes[a]; }
      if (p < first || p >= first + planeCount) continue;
      out[(p - first) * w * h + y * w + x] = vals[i];
    }
  }
  return out;
}

/** Wert einer Spalte fester Länge in einer Zeile (ZSCALE, ZZERO, ZBLANK) */
function cell(dv: DataView, info: TiledInfo, row: number, name: "ZSCALE" | "ZZERO" | "ZBLANK"): number | null {
  const c = info.columns.get(name);
  if (!c || c.varQ !== undefined) return info.keys[name] ?? null;
  const o = row * info.rowBytes + c.offset;
  switch (c.code) {
    case "E": return dv.getFloat32(o);
    case "D": return dv.getFloat64(o);
    case "J": return dv.getInt32(o);
    case "I": return dv.getInt16(o);
    case "K": return Number(dv.getBigInt64(o));
    case "B": return dv.getUint8(o);
  }
  return null;
}

/** Bytes einer Spalte mit variabler Länge (aus dem Heap) oder null */
function heapBytes(dv: DataView, table: Uint8Array, info: TiledInfo, row: number, name: string): { bytes: Uint8Array; code: string } | null {
  const c = info.columns.get(name);
  if (!c || c.varQ === undefined) return null;
  const o = row * info.rowBytes + c.offset;
  const count = c.varQ ? Number(dv.getBigInt64(o)) : dv.getInt32(o);
  const at = c.varQ ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
  if (count <= 0) return null;
  const size = { B: 1, I: 2, J: 4, K: 8, E: 4, D: 8 }[c.code] ?? 1;
  const start = info.heap + at;
  if (start + count * size > table.length) throw new Error(msg("fitsBad"));
  return { bytes: table.subarray(start, start + count * size), code: c.code };
}

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Big-Endian-Werte einer Grösse lesen (ganzzahlig oder Gleitkomma) */
function readValues(b: Uint8Array, n: number, size: number, float: boolean): Float64Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < n * size) throw new Error(msg("fitsBad"));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++)
    out[i] = float ? (size === 4 ? dv.getFloat32(i * 4) : dv.getFloat64(i * 8))
      : size === 1 ? dv.getUint8(i) : size === 2 ? dv.getInt16(i * 2) : size === 4 ? dv.getInt32(i * 4) : Number(dv.getBigInt64(i * 8));
  return out;
}

/** GZIP_2: Bytes wurden umsortiert (alle höchstwertigen Bytes zuerst) – zurücksortieren */
function unshuffle(b: Uint8Array, size: number): Uint8Array {
  if (size === 1) return b;
  const n = b.length / size, out = new Uint8Array(b.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) out[i * size + k] = b[k * n + i];
  return out;
}

/** Eine Kachel entpacken → Werte (physikalisch noch ohne BSCALE/BZERO; Gleitkommabilder schon zurückgerechnet) */
async function decodeTile(dv: DataView, table: Uint8Array, row: number, info: TiledInfo, n: number): Promise<Float64Array> {
  const floatImg = info.zbitpix < 0;
  // Kachel, die nicht komprimiert werden konnte: Werte direkt bzw. gzip-gepackt
  const plain = heapBytes(dv, table, info, row, "UNCOMPRESSED_DATA");
  if (plain) return readValues(plain.bytes, n, { B: 1, I: 2, J: 4, K: 8, E: 4, D: 8 }[plain.code] ?? 4, plain.code === "E" || plain.code === "D");
  const gz = heapBytes(dv, table, info, row, "GZIP_COMPRESSED_DATA");
  if (gz) {
    const size = Math.abs(info.zbitpix) / 8;
    return readValues(await gunzip(gz.bytes), n, size, floatImg);
  }
  const comp = heapBytes(dv, table, info, row, "COMPRESSED_DATA");
  let ints: Float64Array;
  if (!comp) ints = new Float64Array(n); // leere Kachel
  else if (info.type === "RICE_1") ints = riceDecode(comp.bytes, n, info.bytepix as 1 | 2 | 4, info.blocksize);
  else {
    const size = floatImg ? 4 : Math.abs(info.zbitpix) / 8;
    let b = info.type === "NOCOMPRESS" ? comp.bytes : await gunzip(comp.bytes);
    if (info.type === "GZIP_2") b = unshuffle(b, size);
    // Gleitkomma ohne Quantisierung (ZSCALE fehlt) steht direkt als Gleitkomma da
    const direct = floatImg && cell(dv, info, row, "ZSCALE") === null && !info.quantize;
    ints = readValues(b, n, direct ? Math.abs(info.zbitpix) / 8 : size, direct);
    if (direct) return ints;
  }
  if (!floatImg) {
    // ganzzahlig: ZBLANK (Spalte oder Schlüssel) markiert fehlende Werte – als NaN weitergeben
    const zb = cell(dv, info, row, "ZBLANK");
    if (zb !== null) for (let i = 0; i < n; i++) if (ints[i] === zb) ints[i] = NaN;
    return ints;
  }
  // quantisierte Gleitkommawerte zurückrechnen
  const scale = cell(dv, info, row, "ZSCALE"), zero = cell(dv, info, row, "ZZERO") ?? 0;
  if (scale === null) {
    if (info.quantize === "NO_DITHER") return ints;
    throw new Error(msg("fitsBad"));
  }
  const nullVal = cell(dv, info, row, "ZBLANK") ?? -2147483647;
  const out = new Float64Array(n);
  if (info.quantize === "NO_DITHER") {
    for (let i = 0; i < n; i++) out[i] = ints[i] === nullVal ? NaN : ints[i] * scale + zero;
    return out;
  }
  // Subtraktives Zittern: Zufallsfolge wie im Standard festgelegt, Start je Kachel aus ZDITHER0 und Zeilennummer
  const ran = ditherTable();
  let iseed = (row + info.dither0 - 1) % 10000;
  let next = Math.floor(ran[iseed] * 500);
  for (let i = 0; i < n; i++) {
    const v = ints[i];
    if (v === nullVal) out[i] = NaN;
    else if (info.quantize === "SUBTRACTIVE_DITHER_2" && v === -2147483646) out[i] = 0;
    else out[i] = (v - ran[next] + 0.5) * scale + zero;
    if (++next === 10000) {
      iseed = (iseed + 1) % 10000;
      next = Math.floor(ran[iseed] * 500);
    }
  }
  return out;
}

let ditherCache: Float64Array | null = null;
/** 10 000 Zufallszahlen nach Park–Miller (a = 16807, m = 2³¹ − 1, Start 1), wie im FITS-Standard */
export function ditherTable(): Float64Array {
  if (ditherCache) return ditherCache;
  const a = 16807, m = 2147483647;
  let seed = 1;
  const ran = new Float64Array(10000);
  for (let i = 0; i < 10000; i++) {
    const t = a * seed;
    seed = t - m * Math.floor(t / m);
    ran[i] = seed / m;
  }
  return (ditherCache = ran);
}

/**
 * Rice-Dekodierung. Aufbau: erster Wert roh (8·bytepix Bit), dann Blöcke zu `blocksize` Werten. Jeder Block beginnt
 * mit fs+1 in 3/4/5 Bit (1/2/4 Byte je Wert): 0 = alle Differenzen 0; fsmax+1 = Differenzen roh; sonst je Wert
 * eine Einerzählung (Nullen bis zur 1) für den hohen Teil und fs Bit für den niedrigen. Differenzen zum vorigen Wert,
 * gefaltet: gerade → +d/2, ungerade → −(d+1)/2. Bits mit dem höchstwertigen zuerst.
 */
export function riceDecode(src: Uint8Array, n: number, bytepix: 1 | 2 | 4, blocksize = 32): Float64Array {
  const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5;
  const fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25;
  const bbits = 8 * bytepix;
  const out = new Float64Array(n);
  let pos = 0, buf = 0, have = 0; // Bitpuffer
  const bit = (): number => {
    if (have === 0) {
      if (pos >= src.length) throw new Error(msg("fitsBad"));
      buf = src[pos++];
      have = 8;
    }
    have--;
    return (buf >> have) & 1;
  };
  const bits = (k: number): number => {
    let v = 0;
    while (k > 0) {
      if (have === 0) {
        if (pos >= src.length) throw new Error(msg("fitsBad"));
        buf = src[pos++];
        have = 8;
      }
      const take = Math.min(k, have);
      v = v * (1 << take) + ((buf >> (have - take)) & ((1 << take) - 1));
      have -= take;
      k -= take;
    }
    return v;
  };
  // in den Wertebereich der Ganzzahl falten (8 bit vorzeichenlos, 16/32 bit mit Vorzeichen)
  const wrap = bytepix === 1 ? (v: number) => ((v % 256) + 256) % 256 : bytepix === 2 ? (v: number) => ((v << 16) >> 16) : (v: number) => v | 0;
  const unfold = (d: number) => (d % 2 === 0 ? d / 2 : -(d + 1) / 2);
  let last = wrap(bits(bbits));
  for (let i = 0; i < n; i += blocksize) {
    const end = Math.min(n, i + blocksize);
    const fs = bits(fsbits) - 1;
    if (fs < 0) {
      for (let j = i; j < end; j++) out[j] = last;
    } else if (fs === fsmax) {
      for (let j = i; j < end; j++) {
        last = wrap(last + unfold(bits(bbits)));
        out[j] = last;
      }
    } else {
      for (let j = i; j < end; j++) {
        let z = 0;
        while (bit() === 0) z++;
        const d = z * 2 ** fs + (fs ? bits(fs) : 0);
        last = wrap(last + unfold(d));
        out[j] = last;
      }
    }
  }
  return out;
}

/** Rice-Kodierung (Gegenstück zu riceDecode) – für Tests und zum Prüfen der Umsetzung. */
export function riceEncode(values: ArrayLike<number>, bytepix: 1 | 2 | 4, blocksize = 32): Uint8Array {
  const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5;
  const fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25;
  const bbits = 8 * bytepix, mod = 2 ** bbits;
  const bytes: number[] = [];
  let cur = 0, used = 0;
  const put = (v: number, k: number) => {
    for (let b = k - 1; b >= 0; b--) {
      cur = (cur << 1) | (Math.floor(v / 2 ** b) & 1);
      if (++used === 8) { bytes.push(cur); cur = 0; used = 0; }
    }
  };
  const n = values.length;
  put(((values[0] % mod) + mod) % mod, bbits);
  let last = values[0];
  for (let i = 0; i < n; i += blocksize) {
    const end = Math.min(n, i + blocksize);
    const diffs: number[] = [];
    for (let j = i; j < end; j++) {
      // Differenz im Ganzzahl-Ring, dann gefaltet
      let d = (values[j] - last) % mod;
      if (d >= mod / 2) d -= mod;
      if (d < -mod / 2) d += mod;
      diffs.push(d >= 0 ? 2 * d : -2 * d - 1);
      last = values[j];
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (mean === 0) { put(0, fsbits); continue; }
    // Parameter: etwa log2 des Mittelwerts
    let fs = 0;
    while (fs < fsmax && 2 ** (fs + 1) <= mean) fs++;
    if (fs >= fsmax) {
      put(fsmax + 1, fsbits);
      for (const d of diffs) put(d, bbits);
      continue;
    }
    put(fs + 1, fsbits);
    for (const d of diffs) {
      const top = Math.floor(d / 2 ** fs);
      for (let z = 0; z < top; z++) put(0, 1);
      put(1, 1);
      if (fs) put(d % 2 ** fs, fs);
    }
  }
  if (used) bytes.push(cur << (8 - used));
  return Uint8Array.from(bytes);
}
