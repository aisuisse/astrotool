// HEIF/HEIC lesen (ISO/IEC 23008-12, Behälter nach ISO/IEC 14496-12): Fotos von iPhone und neueren Handys.
// Hier nur der Behälter: welche Bildteile (HEVC-Kacheln) zum Hauptbild gehören, wo sie in der Datei liegen, wie
// gross das Bild ist, wie es gedreht wird und wo der Exif-Block steht. Dekodiert werden die Kacheln mit dem
// HEVC-Dekoder des Systems (heif-decode.ts, WebCodecs) – Astrotool enthält keinen eigenen HEVC-Dekoder.

/** Byte-Bereiche in der Datei: [Anfang, Länge] */
export type HeifExtents = [number, number][];

export interface HeifTile {
  extents: HeifExtents;
  /** Lage im Bild (vor dem Drehen) */
  x: number;
  y: number;
  /** Index in HeifLayout.configs */
  config: number;
}

/** Drehen um 90° gegen den Uhrzeigersinn (1–3 mal) oder Spiegeln (0: links/rechts, 1: oben/unten) */
export type HeifTransform = { rot: number } | { mirror: number };

export interface HeifLayout {
  /** Grösse vor dem Drehen */
  width: number;
  height: number;
  /** Grösse so, wie das Bild gezeigt wird */
  displayWidth: number;
  displayHeight: number;
  configs: { codec: string; description: Uint8Array }[];
  tiles: HeifTile[];
  /** in dieser Reihenfolge anzuwenden */
  transforms: HeifTransform[];
  exif: HeifExtents | null;
}

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Dateianfang (mindestens 12 Byte, besser 64): HEIF mit HEVC-Bildern? AVIF liest der Browser selbst. */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12 || fourcc(head, 4) !== "ftyp") return false;
  const size = Math.min(head.length, ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0);
  const brands = [fourcc(head, 8)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(fourcc(head, o));
  if (brands.includes("avif") || brands.includes("avis")) return false;
  return brands.some((b) => HEIF_BRANDS.has(b));
}

interface Box { type: string; start: number; end: number }

/** Boxen in b[start, end): start/end der Box sind die Grenzen des Inhalts (ohne Kopf). */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p), head = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = v.getUint32(p + 8) * 2 ** 32 + v.getUint32(p + 12);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head || p + size > end) break;
    out.push({ type: fourcc(b, p + 4), start: p + head, end: p + size });
    p += size;
  }
  return out;
}

/** meta-Box der Datei (Inhalt nach Version/Flags) – oder null */
async function readMeta(file: Blob): Promise<Uint8Array | null> {
  let p = 0;
  for (let guard = 0; guard < 64 && p + 8 <= file.size; guard++) {
    const h = new DataView(await file.slice(p, p + 16).arrayBuffer());
    if (h.byteLength < 8) return null;
    let size = h.getUint32(0), head = 8;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) {
      if (h.byteLength < 16) return null;
      size = h.getUint32(8) * 2 ** 32 + h.getUint32(12);
      head = 16;
    } else if (size === 0) size = file.size - p;
    if (size < head) return null;
    if (p === 0 && type !== "ftyp") return null;
    if (type === "meta") {
      if (size > 64 << 20) return null;
      // FullBox: 4 Byte Version/Flags überspringen
      return new Uint8Array(await file.slice(p + head + 4, p + size).arrayBuffer());
    }
    p += size;
  }
  return null;
}

interface Item { type: string; method: number; extents: HeifExtents }

/** HEVC-Kennung für WebCodecs aus dem hvcC-Block, z. B. "hvc1.1.6.L93.B0" */
export function hevcCodec(c: Uint8Array): string {
  const space = ["", "A", "B", "C"][c[1] >> 6], tier = (c[1] >> 5) & 1, profile = c[1] & 31;
  let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev * 2 + (compat & 1)) >>> 0;
    compat >>>= 1;
  }
  const cons = [...c.subarray(6, 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `hvc1.${space}${profile}.${rev.toString(16).toUpperCase()}.${tier ? "H" : "L"}${c[12]}${cons.map((x) => "." + x.toString(16).toUpperCase()).join("")}`;
}

/** Aufbau des Hauptbilds aus dem Inhalt der meta-Box – oder null (kein HEVC-Bild, unbekannter Aufbau). */
export function parseHeifMeta(m: Uint8Array): HeifLayout | null {
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const top = boxes(m, 0, m.length);
  const box = (t: string) => top.find((x) => x.type === t);
  const uint = (o: number, n: number) => {
    let r = 0;
    for (let i = 0; i < n; i++) r = r * 256 + m[o + i];
    return r;
  };

  // Hauptbild
  const pitm = box("pitm");
  if (!pitm) return null;
  const primary = m[pitm.start] === 0 ? v.getUint16(pitm.start + 4) : v.getUint32(pitm.start + 4);

  // Art der Teile
  const items = new Map<number, Item>();
  const iinf = box("iinf");
  if (!iinf) return null;
  for (const e of boxes(m, iinf.start + 4 + (m[iinf.start] === 0 ? 2 : 4), iinf.end)) {
    if (e.type !== "infe") continue;
    const ver = m[e.start];
    if (ver < 2) continue;
    const id = ver === 2 ? v.getUint16(e.start + 4) : v.getUint32(e.start + 4);
    items.set(id, { type: fourcc(m, e.start + (ver === 2 ? 8 : 10)), method: 0, extents: [] });
  }

  // Lage der Teile; method 1: im idat-Block dieser meta-Box
  const iloc = box("iloc"), idat = box("idat");
  if (!iloc) return null;
  {
    const ver = m[iloc.start];
    let p = iloc.start + 4;
    const offSize = m[p] >> 4, lenSize = m[p] & 15, baseSize = m[p + 1] >> 4, idxSize = ver > 0 ? m[p + 1] & 15 : 0;
    p += 2;
    const count = ver < 2 ? v.getUint16(p) : v.getUint32(p);
    p += ver < 2 ? 2 : 4;
    for (let i = 0; i < count && p < iloc.end; i++) {
      const id = ver < 2 ? v.getUint16(p) : v.getUint32(p);
      p += ver < 2 ? 2 : 4;
      let method = 0;
      if (ver > 0) {
        method = v.getUint16(p) & 15;
        p += 2;
      }
      p += 2; // data_reference_index
      const base = uint(p, baseSize);
      p += baseSize;
      const n = v.getUint16(p);
      p += 2;
      const ext: HeifExtents = [];
      for (let k = 0; k < n; k++) {
        p += idxSize;
        const off = uint(p, offSize);
        p += offSize;
        const len = uint(p, lenSize);
        p += lenSize;
        ext.push([base + off, len]);
      }
      const it = items.get(id);
      if (it) {
        it.method = method;
        it.extents = ext;
      }
    }
  }

  // Eigenschaften (ipco, Nummern ab 1) und ihre Zuordnung (ipma)
  const iprp = box("iprp");
  if (!iprp) return null;
  const sub = boxes(m, iprp.start, iprp.end);
  const ipco = sub.find((x) => x.type === "ipco");
  if (!ipco) return null;
  const props = boxes(m, ipco.start, ipco.end);
  const assoc = new Map<number, number[]>();
  for (const a of sub.filter((x) => x.type === "ipma")) {
    const ver = m[a.start], wide = m[a.start + 3] & 1;
    let p = a.start + 4;
    const count = v.getUint32(p);
    p += 4;
    for (let i = 0; i < count && p < a.end; i++) {
      const id = ver < 1 ? v.getUint16(p) : v.getUint32(p);
      p += ver < 1 ? 2 : 4;
      const n = m[p++];
      const list: number[] = [];
      for (let k = 0; k < n; k++) {
        list.push(wide ? v.getUint16(p) & 0x7fff : m[p] & 0x7f);
        p += wide ? 2 : 1;
      }
      assoc.set(id, list);
    }
  }
  const propsOf = (id: number) => (assoc.get(id) ?? []).map((i) => props[i - 1]).filter(Boolean);

  // Bezüge: dimg (Kacheln eines Rasters), cdsc (Exif beschreibt das Bild)
  const refs: { type: string; from: number; to: number[] }[] = [];
  const iref = box("iref");
  if (iref) {
    const wide = m[iref.start] > 0;
    for (const r of boxes(m, iref.start + 4, iref.end)) {
      let p = r.start;
      const from = wide ? v.getUint32(p) : v.getUint16(p);
      p += wide ? 4 : 2;
      const n = v.getUint16(p);
      p += 2;
      const to: number[] = [];
      for (let k = 0; k < n; k++) {
        to.push(wide ? v.getUint32(p) : v.getUint16(p));
        p += wide ? 4 : 2;
      }
      refs.push({ type: r.type, from, to });
    }
  }

  // Daten eines kleinen Teils aus dem idat-Block (Rasterbeschreibung)
  const idatBytes = (it: Item): Uint8Array | null => {
    if (it.method !== 1 || !idat || it.extents.length !== 1) return null;
    const [off, len] = it.extents[0];
    return idat.start + off + len <= idat.end ? m.subarray(idat.start + off, idat.start + off + len) : null;
  };

  const transforms: HeifTransform[] = [];
  const collect = (id: number) => {
    for (const p of propsOf(id)) {
      if (p.type === "irot" && m[p.start] & 3) transforms.push({ rot: m[p.start] & 3 });
      if (p.type === "imir") transforms.push({ mirror: m[p.start] & 1 });
    }
  };
  const ispe = (id: number) => {
    const p = propsOf(id).find((x) => x.type === "ispe");
    return p ? { width: v.getUint32(p.start + 4), height: v.getUint32(p.start + 8) } : null;
  };

  // "iden": abgeleitetes Bild, das nur dreht/spiegelt – der Quelle folgen (deren Drehung gilt zuerst)
  let id = primary;
  const chain: number[] = [];
  for (let guard = 0; guard < 4 && items.get(id)?.type === "iden"; guard++) {
    chain.unshift(id);
    const next = refs.find((r) => r.type === "dimg" && r.from === id)?.to[0];
    if (next === undefined) return null;
    id = next;
  }
  const main = items.get(id);
  if (!main) return null;

  const configs: HeifLayout["configs"] = [];
  const configIndex = new Map<number, number>();
  const tile = (tid: number, x: number, y: number): HeifTile | null => {
    const it = items.get(tid);
    if (!it || it.type !== "hvc1" || it.method !== 0 || !it.extents.length) return null;
    const pi = (assoc.get(tid) ?? []).find((i) => props[i - 1]?.type === "hvcC");
    if (pi === undefined) return null;
    if (!configIndex.has(pi)) {
      const c = m.slice(props[pi - 1].start, props[pi - 1].end);
      if (c.length < 23) return null;
      configIndex.set(pi, configs.length);
      configs.push({ codec: hevcCodec(c), description: c });
    }
    return { extents: it.extents, x, y, config: configIndex.get(pi)! };
  };

  let width: number, height: number;
  const tiles: HeifTile[] = [];
  if (main.type === "grid") {
    const g = idatBytes(main);
    // Rasterbeschreibung liegt bei manchen Dateien im Datenteil statt im idat – das wird hier nicht unterstützt
    if (!g || g.length < 8) return null;
    const rows = g[2] + 1, cols = g[3] + 1, big = g[1] & 1;
    const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
    if (big && g.length < 12) return null;
    width = big ? gv.getUint32(4) : gv.getUint16(4);
    height = big ? gv.getUint32(8) : gv.getUint16(6);
    const ids = refs.find((r) => r.type === "dimg" && r.from === id)?.to ?? [];
    if (ids.length < rows * cols) return null;
    const size = ispe(ids[0]);
    if (!size) return null;
    for (let k = 0; k < rows * cols; k++) {
      const t = tile(ids[k], (k % cols) * size.width, Math.floor(k / cols) * size.height);
      if (!t) return null;
      tiles.push(t);
    }
  } else if (main.type === "hvc1") {
    const size = ispe(id), t = tile(id, 0, 0);
    if (!size || !t) return null;
    ({ width, height } = size);
    tiles.push(t);
  } else return null;
  if (!(width > 0 && height > 0) || width * height > 400e6) return null;

  collect(id);
  for (const c of chain) collect(c);
  const turned = transforms.filter((t): t is { rot: number } => "rot" in t).reduce((a, t) => a + t.rot, 0) % 2 === 1;

  // Exif-Block: bevorzugt der, der das Hauptbild beschreibt
  const exifIds = [...items].filter(([, it]) => it.type === "Exif" && it.method === 0 && it.extents.length).map(([k]) => k);
  const exifId = exifIds.find((e) => refs.some((r) => r.type === "cdsc" && r.from === e && (r.to.includes(primary) || r.to.includes(id)))) ?? exifIds[0];

  return {
    width, height,
    displayWidth: turned ? height : width,
    displayHeight: turned ? width : height,
    configs, tiles, transforms,
    exif: exifId !== undefined ? items.get(exifId)!.extents : null,
  };
}

/** Aufbau des Hauptbilds einer HEIC-Datei – oder null */
export async function readHeif(file: Blob): Promise<HeifLayout | null> {
  const m = await readMeta(file);
  if (!m) return null;
  try {
    return parseHeifMeta(m);
  } catch {
    return null; // beschädigte Datei: Zugriff ausserhalb der Box
  }
}

/** Bytes mehrerer Bereiche, aneinandergehängt */
export async function heifBytes(file: Blob, extents: HeifExtents): Promise<Uint8Array> {
  if (extents.length === 1) return new Uint8Array(await file.slice(extents[0][0], extents[0][0] + extents[0][1]).arrayBuffer());
  const out = new Uint8Array(extents.reduce((a, e) => a + e[1], 0));
  let p = 0;
  for (const [off, len] of extents) {
    out.set(new Uint8Array(await file.slice(off, off + len).arrayBuffer()), p);
    p += len;
  }
  return out;
}

/** Exif-Daten (TIFF-Block) einer HEIC-Datei – oder null */
export async function readHeifExif(file: Blob): Promise<ArrayBuffer | null> {
  const l = await readHeif(file);
  if (!l?.exif) return null;
  const b = await heifBytes(file, l.exif);
  if (b.length < 12) return null;
  // 4 Byte: Abstand bis zum TIFF-Kopf (meist 6 für "Exif\0\0")
  const skip = 4 + (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  return skip + 8 <= b.length ? b.slice(skip).buffer : null;
}
