// RAW-Fotos von Systemkameras und Spiegelreflexkameras.
// Stufe 1: das von der Kamera eingebettete JPEG (bei fast allen Modellen in voller Auflösung).
// Eigene Umsetzung nach TIFF 6.0, DNG-Spezifikation, ISO-BMFF (CR3) und dem RAF-Kopf.
//
// Gesucht wird das grösste Baseline-JPEG: in allen IFDs, SubIFDs und – bei Nikon – im Vorschau-IFD der MakerNote;
// bei CR3 die erste Spur (volles JPEG), bei RAF der Verweis im Dateikopf.

export const RAW_EXT = /\.(nef|nrw|cr2|cr3|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|3fr|iiq|erf|kdc|mrw)$/i;

export interface JpegCandidate {
  offset: number;
  length: number;
  width: number;
  height: number;
}

async function bytes(b: Blob, off: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await b.slice(off, Math.min(b.size, off + len)).arrayBuffer());
}

/** Breite/Höhe aus dem SOF-Marker, nur für darstellbare JPEGs (baseline, extended, progressiv). */
export async function jpegSize(b: Blob, off: number): Promise<{ width: number; height: number } | null> {
  const d = await bytes(b, off, 262144);
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < d.length) {
    if (d[p] !== 0xff) return null;
    const m = d[p + 1];
    if (m === 0xff) { p++; continue; }
    const len = (d[p + 2] << 8) | d[p + 3];
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) return { height: (d[p + 5] << 8) | d[p + 6], width: (d[p + 7] << 8) | d[p + 8] };
    if (m === 0xc3 || m === 0xda) return null; // verlustfrei (Rohdaten) oder Bilddaten ohne passenden SOF
    p += 2 + len;
  }
  return null;
}

/** Alle JPEG-Kandidaten eines TIFF-basierten RAW (NEF, CR2, ARW, DNG, ORF, RW2, PEF …). */
async function tiffCandidates(b: Blob, base = 0, limit = 4): Promise<{ offset: number; length: number }[]> {
  const head = await bytes(b, base, 8);
  if (head.length < 8) return [];
  const le = head[0] === 0x49;
  const out: { offset: number; length: number }[] = [];
  const seen = new Set<number>();
  const readIfd = async (ifd: number, depth: number): Promise<number> => {
    if (ifd <= 0 || depth > limit || seen.has(ifd) || base + ifd + 2 > b.size) return 0;
    seen.add(ifd);
    const cnt = new DataView((await bytes(b, base + ifd, 2)).buffer).getUint16(0, le);
    if (cnt > 1000) return 0;
    const raw = await bytes(b, base + ifd + 2, cnt * 12 + 4);
    const v = new DataView(raw.buffer);
    const t: Record<number, number[]> = {};
    for (let i = 0; i < cnt && i * 12 + 12 <= raw.length; i++) {
      const tag = v.getUint16(i * 12, le), type = v.getUint16(i * 12 + 2, le), n = v.getUint32(i * 12 + 4, le);
      const sz = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
      if (!sz || ![0x103, 0x106, 0x111, 0x117, 0x14a, 0x201, 0x202, 0x8769, 0x927c].includes(tag)) {
        if (tag === 0x927c) t[tag] = [v.getUint32(i * 12 + 8, le), n];
        continue;
      }
      const vals: number[] = [];
      if (sz * n <= 4) for (let k = 0; k < n; k++) vals.push(sz === 2 ? v.getUint16(i * 12 + 8 + 2 * k, le) : v.getUint32(i * 12 + 8, le));
      else {
        const arr = await bytes(b, base + v.getUint32(i * 12 + 8, le), sz * Math.min(n, 64));
        const av = new DataView(arr.buffer);
        for (let k = 0; k < Math.min(n, 64); k++) vals.push(sz === 2 ? av.getUint16(2 * k, le) : av.getUint32(4 * k, le));
      }
      t[tag] = vals;
    }
    if (t[0x201] && t[0x202]) out.push({ offset: base + t[0x201][0], length: t[0x202][0] });
    const comp = t[0x103]?.[0];
    if (t[0x111]?.length === 1 && t[0x117] && (comp === 6 || (comp === 7 && t[0x106]?.[0] === 6))) out.push({ offset: base + t[0x111][0], length: t[0x117][0] });
    for (const s of t[0x14a] ?? []) await readIfd(s, depth + 1);
    // Nikon: MakerNote "Nikon\0" + eigener TIFF-Kopf, Vorschau-IFD (Tag 0x0011)
    if (t[0x8769]) await readIfd(t[0x8769][0], depth + 1);
    if (t[0x927c]) {
      const [mOff] = t[0x927c];
      const mn = await bytes(b, base + mOff, 18);
      if (String.fromCharCode(...mn.subarray(0, 5)) === "Nikon") {
        const nb = base + mOff + 10;
        const nh = await bytes(b, nb, 8);
        const nle = nh[0] === 0x49;
        const first = new DataView(nh.buffer).getUint32(4, nle);
        const cntB = await bytes(b, nb + first, 2);
        const nc = new DataView(cntB.buffer).getUint16(0, nle);
        const ents = await bytes(b, nb + first + 2, nc * 12);
        const ev = new DataView(ents.buffer);
        for (let i = 0; i < nc && i * 12 + 12 <= ents.length; i++) {
          if (ev.getUint16(i * 12, nle) === 0x0011) {
            const pre = ev.getUint32(i * 12 + 8, nle);
            const sub = await tiffIfdJpeg(b, nb, pre, nle);
            if (sub) out.push(sub);
          }
        }
      }
    }
    return v.getUint32(cnt * 12, le);
  };
  let next = new DataView(head.buffer).getUint32(4, le);
  for (let k = 0; next && k < 8; k++) next = await readIfd(next, 0);
  return out;
}

/** JPEG-Verweis (0x201/0x202) in einem einzelnen IFD mit eigener Basis (Nikon-Vorschau). */
async function tiffIfdJpeg(b: Blob, base: number, ifd: number, le: boolean): Promise<{ offset: number; length: number } | null> {
  const cnt = new DataView((await bytes(b, base + ifd, 2)).buffer).getUint16(0, le);
  const raw = await bytes(b, base + ifd + 2, cnt * 12);
  const v = new DataView(raw.buffer);
  let off = 0, len = 0;
  for (let i = 0; i < cnt && i * 12 + 12 <= raw.length; i++) {
    const tag = v.getUint16(i * 12, le);
    if (tag === 0x201) off = v.getUint32(i * 12 + 8, le);
    if (tag === 0x202) len = v.getUint32(i * 12 + 8, le);
  }
  return off && len ? { offset: base + off, length: len } : null;
}

/** CR3: Spur 1 enthält das JPEG in voller Grösse (Lage aus stco/co64, Länge aus stsz). */
async function cr3Candidates(b: Blob): Promise<{ offset: number; length: number }[]> {
  const out: { offset: number; length: number }[] = [];
  const walk = async (start: number, end: number, path: string[], trak: { n: number }) => {
    let off = start;
    while (off + 8 <= end) {
      const h = new DataView((await bytes(b, off, 16)).buffer);
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      let hdr = 8;
      if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; }
      if (size === 0) size = end - off;
      if (size < 8) return;
      if (type === "moov" || type === "mdia" || type === "minf" || type === "stbl") await walk(off + hdr, off + size, [...path, type], trak);
      else if (type === "trak") { trak.n++; if (trak.n === 1) await walk(off + hdr, off + size, [...path, type], trak); }
      else if (path.includes("trak") && trak.n === 1 && (type === "stsz" || type === "stco" || type === "co64")) {
        const d = new DataView((await bytes(b, off + hdr, 24)).buffer);
        if (type === "stsz") (out[0] ??= { offset: 0, length: 0 }).length = d.getUint32(4) || d.getUint32(12);
        if (type === "stco") (out[0] ??= { offset: 0, length: 0 }).offset = d.getUint32(8);
        if (type === "co64") (out[0] ??= { offset: 0, length: 0 }).offset = Number(d.getBigUint64(8));
      }
      off += size;
      if (type === "moov") return;
    }
  };
  await walk(0, b.size, [], { n: 0 });
  return out.filter((c) => c.offset > 0 && c.length > 0);
}

/** Das grösste eingebettete JPEG eines RAW, oder null. */
export async function rawPreview(b: Blob): Promise<JpegCandidate | null> {
  const head = await bytes(b, 0, 96);
  let cands: { offset: number; length: number }[] = [];
  const magic = String.fromCharCode(...head.subarray(0, 8));
  if (magic === "FUJIFILM") {
    const v = new DataView(head.buffer);
    cands = [{ offset: v.getUint32(84), length: v.getUint32(88) }];
  } else if (magic.slice(4, 8) === "ftyp") cands = await cr3Candidates(b);
  else if (magic.startsWith("II") || magic.startsWith("MM")) cands = await tiffCandidates(b);
  let best: JpegCandidate | null = null;
  for (const c of cands) {
    if (c.offset <= 0 || c.length <= 0 || c.offset + c.length > b.size) continue;
    const s = await jpegSize(b, c.offset);
    if (s && (!best || s.width * s.height > best.width * best.height)) best = { ...c, ...s };
  }
  return best;
}
