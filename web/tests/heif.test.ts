import { describe, expect, it } from "vitest";
import { existsSync, openAsBlob, readdirSync } from "node:fs";
import { hevcCodec, isHeif, readHeif, readHeifExif } from "../src/engine/heif";
import { exifTimeMs, readExifBlob } from "../src/engine/exif";
import { imageSize } from "../src/engine/source";
import { filmLayout } from "../src/engine/timelapse";

// ---------- kleine HEIC-Datei von Hand bauen ----------
const cat = (...parts: (Uint8Array | number[])[]) => {
  const a = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(a.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of a) { out.set(p, o); o += p.length; }
  return out;
};
const u16 = (v: number) => [(v >> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...body: (Uint8Array | number[])[]) => {
  const b = cat(...body);
  return cat(u32(b.length + 8), str(type), b);
};
const full = (type: string, version: number, flags: number, ...body: (Uint8Array | number[])[]) => box(type, [version, 0, 0, flags], ...body);

/** hvcC: Main-Profil, Stufe 3.1 */
const HVCC = cat([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93], new Array(10).fill(0));

/** kleines TIFF (Motorola) mit Hersteller, Modell, Aufnahmezeit und Zeitzone */
function tiff(): Uint8Array {
  const make = str("Apple\0"), model = str("iPhone 15 Pro\0"), date = str("2027:08:02 10:01:02\0"), off = str("+03:00\0");
  // IFD0 bei 8 mit 3 Einträgen (Make, Model, ExifIFD), danach Exif-IFD mit 2 Einträgen, danach die Texte
  const ifd0 = 8, exifIfd = ifd0 + 2 + 3 * 12 + 4, data = exifIfd + 2 + 2 * 12 + 4;
  const entry = (tag: number, type: number, count: number, value: number) => [...u16(tag), ...u16(type), ...u32(count), ...u32(value)];
  const pMake = data, pModel = pMake + make.length, pDate = pModel + model.length, pOff = pDate + date.length;
  return cat(
    str("MM"), u16(42), u32(ifd0),
    u16(3), entry(0x010f, 2, make.length, pMake), entry(0x0110, 2, model.length, pModel), entry(0x8769, 4, 1, exifIfd), u32(0),
    u16(2), entry(0x9003, 2, date.length, pDate), entry(0x9011, 2, off.length, pOff), u32(0),
    make, model, date, off,
  );
}

/**
 * HEIC wie vom iPhone: Raster aus 2 × 2 Kacheln (je 512 × 512) für ein Bild 1000 × 700, um 90° im Uhrzeigersinn
 * gedreht (irot 3), Exif als eigener Teil.
 */
function heic(opts: { rot?: number; single?: boolean } = {}): Uint8Array {
  const ftyp = box("ftyp", str("heic"), u32(0), str("mif1"), str("heic"));
  const tileBytes = [0, 1, 2, 3].map((k) => Uint8Array.from({ length: 20 + k }, () => 0x40 + k));
  const exifData = cat(u32(6), str("Exif\0\0"), tiff());
  const infe = (id: number, type: string) => full("infe", 2, 0, u16(id), u16(0), str(type), [0]);
  const ids = opts.single ? [1] : [1, 2, 3, 4];
  const gridId = 5, exifId = 6, primary = opts.single ? 1 : gridId;
  const build = (mdatOffset: number) => {
    let p = mdatOffset;
    const loc: number[][] = [];
    for (const k of ids) { loc.push([k, p, tileBytes[k - 1].length]); p += tileBytes[k - 1].length; }
    loc.push([exifId, p, exifData.length]);
    const ilocItems = [
      ...loc.map(([id, off, len]) => [...u16(id), ...u16(0), ...u16(0), ...u16(1), ...u32(off), ...u32(len)]),
      ...(opts.single ? [] : [[...u16(gridId), ...u16(1), ...u16(0), ...u16(1), ...u32(0), ...u32(8)]]),
    ];
    const props = [box("hvcC", HVCC), full("ispe", 0, 0, u32(512), u32(512)), full("ispe", 0, 0, u32(1000), u32(700)), box("irot", [opts.rot ?? 3])];
    const assoc = [
      ...ids.map((id) => [...u16(id), 2, 0x81, 0x02]),
      ...(opts.single ? [] : [[...u16(gridId), 2, 0x03, 0x84]]),
    ];
    return full("meta", 0, 0,
      full("hdlr", 0, 0, u32(0), str("pict"), new Array(13).fill(0)),
      full("pitm", 0, 0, u16(primary)),
      full("iinf", 0, 0, u16(ids.length + 2), ...ids.map((id) => infe(id, "hvc1")), infe(gridId, "grid"), infe(exifId, "Exif")),
      full("iloc", 1, 0, [0x44, 0x00], u16(ilocItems.length), ...ilocItems),
      box("iprp", box("ipco", ...props), full("ipma", 0, 0, u32(assoc.length), ...assoc)),
      full("iref", 0, 0, ...(opts.single ? [] : [box("dimg", u16(gridId), u16(4), u16(1), u16(2), u16(3), u16(4))]), box("cdsc", u16(exifId), u16(1), u16(primary))),
      box("idat", [0, 0, 1, 1], u16(1000), u16(700)),
    );
  };
  const metaSize = build(0).length;
  const meta = build(ftyp.length + metaSize + 8);
  return cat(ftyp, meta, box("mdat", ...ids.map((k) => tileBytes[k - 1]), exifData));
}
const blob = (b: Uint8Array) => new Blob([b.slice().buffer as ArrayBuffer]);

describe("HEIC (iPhone-Fotos): Aufbau der Datei", () => {
  it("erkennt HEIC am Dateianfang, AVIF und CR3 nicht", () => {
    expect(isHeif(heic().subarray(0, 64))).toBe(true);
    expect(isHeif(box("ftyp", str("avif"), u32(0), str("mif1"), str("avif")))).toBe(false);
    expect(isHeif(box("ftyp", str("crx "), u32(1), str("crx "), str("isom")))).toBe(false);
    expect(isHeif(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it("HEVC-Kennung aus hvcC", () => {
    expect(hevcCodec(HVCC)).toBe("hvc1.1.6.L93.90");
    // Main Still Picture, hohe Stufe
    expect(hevcCodec(cat([1, 0x23, 0x70, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120], new Array(10).fill(0)))).toBe("hvc1.3.E.H120.B0");
  });

  it("Raster aus Kacheln: Grösse, Lage, Drehung", async () => {
    const b = heic();
    const l = (await readHeif(blob(b)))!;
    expect(l).not.toBeNull();
    expect([l.width, l.height]).toEqual([1000, 700]);
    // irot 3 = 90° im Uhrzeigersinn → Hochformat
    expect([l.displayWidth, l.displayHeight]).toEqual([700, 1000]);
    expect(l.transforms).toEqual([{ rot: 3 }]);
    expect(l.tiles.map((t) => [t.x, t.y])).toEqual([[0, 0], [512, 0], [0, 512], [512, 512]]);
    expect(l.configs).toHaveLength(1);
    expect(l.configs[0].codec).toBe("hvc1.1.6.L93.90");
    // die Kacheldaten liegen dort, wo die Datei es sagt
    l.tiles.forEach((t, k) => {
      const [off, len] = t.extents[0];
      expect(len).toBe(20 + k);
      expect([...b.subarray(off, off + len)].every((x) => x === 0x40 + k)).toBe(true);
    });
  });

  it("einzelnes Bild ohne Raster, ohne Drehung", async () => {
    const l = (await readHeif(blob(heic({ single: true, rot: 0 }))))!;
    expect(l.tiles).toHaveLength(1);
    expect([l.width, l.height, l.displayWidth, l.displayHeight]).toEqual([512, 512, 512, 512]);
    expect(l.transforms).toEqual([]);
  });

  it("Aufnahmezeit, Zeitzone und Kamera aus dem Exif-Teil", async () => {
    const f = blob(heic());
    expect(await readHeifExif(f)).not.toBeNull();
    const e = await readExifBlob(f);
    expect(e.make).toBe("Apple");
    expect(e.model).toBe("iPhone 15 Pro");
    expect(e.dateTimeOriginal).toBe("2027:08:02 10:01:02");
    expect(e.orientation).toBeUndefined();
    expect(exifTimeMs(e)).toBe(Date.UTC(2027, 7, 2, 7, 1, 2));
    expect(await imageSize(f, e)).toEqual({ width: 700, height: 1000 });
  });

  it("beschädigte Datei: kein Absturz", async () => {
    const b = heic();
    expect(await readHeif(blob(b.subarray(0, 120)))).toBeNull();
    expect(await readHeif(blob(Uint8Array.from([1, 2, 3])))).toBeNull();
    const broken = b.slice();
    broken.fill(0xff, 60, 200);
    await expect(readHeif(blob(broken))).resolves.toBeDefined();
  });

  // echte Beispieldateien, nur lokal (web/.testdata/heic-samples)
  const DIR = ".testdata/heic-samples";
  const files = existsSync(DIR) ? readdirSync(DIR, { recursive: true }).filter((f) => /\.hei[cf]$/i.test(f)) : [];
  it.skipIf(!files.length)("echte HEIC-Dateien: Aufbau lesbar", async () => {
    let ok = 0;
    for (const f of files) {
      const file = await openAsBlob(`${DIR}/${f}`);
      if (!isHeif(new Uint8Array(await file.slice(0, 64).arrayBuffer()))) continue;
      const l = await readHeif(file);
      if (!l) continue;
      ok++;
      expect(l.width).toBeGreaterThan(0);
      expect(l.tiles.length).toBeGreaterThan(0);
      for (const t of l.tiles) for (const [off, len] of t.extents) expect(off + len).toBeLessThanOrEqual(file.size);
    }
    expect(ok).toBeGreaterThan(0);
  });
});

describe("JPEG im Hochformat", () => {
  it("Bildgrösse folgt der EXIF-Ausrichtung", async () => {
    // JPEG-Kopf mit SOF0 4000 × 3000
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, ...u16(3000), ...u16(4000), 3, 0, 0, 0]);
    expect(await imageSize(blob(jpg), {})).toEqual({ width: 4000, height: 3000 });
    expect(await imageSize(blob(jpg), { orientation: 6 })).toEqual({ width: 3000, height: 4000 });
    expect(await imageSize(blob(jpg), { orientation: 3 })).toEqual({ width: 4000, height: 3000 });
  });
});

describe("Format des Films", () => {
  const o = { width: 1080, format: "mp4-h264" as const, upscale: true };
  it("wie die Bilder: füllt den Film", () => {
    expect(filmLayout(1100, 1100, o)).toEqual({ W: 1080, H: 1080, x: 0, y: 0, w: 1080, h: 1080 });
  });
  it("Hochformat 9:16: quadratisches Bild mittig, 1080 × 1920", () => {
    expect(filmLayout(1100, 1100, { ...o, shape: "portrait" })).toEqual({ W: 1080, H: 1920, x: 0, y: 420, w: 1080, h: 1080 });
  });
  it("Querformat 16:9: quadratisches Bild mittig, 1920 × 1080", () => {
    expect(filmLayout(1100, 1100, { ...o, shape: "landscape" })).toEqual({ W: 1920, H: 1080, x: 420, y: 0, w: 1080, h: 1080 });
  });
  it("breites Bild im Hochformat: lange Seite höchstens 1920, gerade Kanten", () => {
    const l = filmLayout(1920, 1080, { width: 0, format: "mp4-h264", shape: "portrait" });
    expect(Math.max(l.W, l.H)).toBeLessThanOrEqual(1920);
    expect(l.W % 2 + l.H % 2).toBe(0);
    expect(l.w).toBeLessThanOrEqual(l.W);
    expect(Math.abs(l.W / l.H - 9 / 16)).toBeLessThan(0.01);
    expect(Math.abs(l.w / l.h - 16 / 9)).toBeLessThan(0.02);
  });
});
