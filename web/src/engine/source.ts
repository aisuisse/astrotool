// Gemeinsame Schnittstelle für Eingaben: SER-Video oder Serie von Einzelbildern (JPG/PNG/TIFF …).
import { exifTimeMs, readExifBlob, type ExifInfo } from "./exif";
import { SerColor, SerReader, type Frame } from "./ser";
import { cropFrame } from "./image";
import { decodeFitsFrame, FITS_EXT, fitsExif, fitsFrameCount, fitsNum, fitsStr, fitsTimeMs, readFitsHeader, readFitsLayout, type FitsImageHdu } from "./fits";
import { msg } from "../i18n";

export interface FrameSource {
  kind: "ser" | "images" | "video";
  width: number;
  height: number;
  frameCount: number;
  colorId: number;
  bitDepth: number;
  readFrame(index: number): Promise<Frame>;
  /** 100-ns-Ticks seit 0001-01-01 (SER-Konvention) oder null */
  readTimestamps(): Promise<BigInt64Array | null>;
  /** Name für Ausgabedateien, z. B. "SAM_3105" */
  frameName(index: number): string;
  meta: { observer?: string; instrument?: string; telescope?: string; startUtc?: bigint };
  /**
   * Zeitbasis der Zeitstempel: "utc" (SER, EXIF mit Zeitzone) oder "local" (Kamerauhr ohne Zeitzone –
   * die Ticks enthalten dann die Ortszeit der Kamera, als wäre sie UTC).
   */
  clock: "utc" | "local";
  /** Relative Belichtung eines Bildes (Zeit × ISO/100 / Blende²) aus EXIF – für HDR-Reihen; sonst fehlt die Methode */
  exposure?(index: number): number | undefined;
  /** Lineare Sensordaten (RAW, SER) statt sRGB-kodierter Bilder – wichtig für HDR */
  readonly linear?: boolean;
  /** Bildrate laut Datei (Videos ohne Zeitstempel je Bild) */
  readonly fps?: number | null;
}

export function serSource(r: SerReader, baseName: string): FrameSource {
  const h = r.header;
  const digits = String(h.frameCount).length;
  return {
    kind: "ser",
    width: h.width,
    height: h.height,
    get frameCount() {
      return h.frameCount;
    },
    colorId: h.colorId,
    bitDepth: h.bitDepth,
    readFrame: (i) => r.readFrame(i),
    readTimestamps: () => r.readTimestamps(),
    frameName: (i) => `${baseName}_${String(i + 1).padStart(digits, "0")}`,
    // Startzeit aus dem Kopf – für Dateien ohne Zeitstempel je Bild
    meta: { observer: h.observer, instrument: h.instrument, telescope: h.telescope, startUtc: h.dateTimeUtc > 0n ? h.dateTimeUtc : undefined },
    clock: "utc",
  };
}

/** Dekodiert ein Bild zu RGBA (8 bit). Im Browser: createImageBitmap + OffscreenCanvas; in Node: z. B. jpeg-js. */
/** raw = true: Kamera-RAW (NEF, CR2, …). Ergebnis: RGBA-Bild oder – bei RAW-Rohdaten – direkt ein Frame (Bayer, 16 bit). */
export type DecodedImage = { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; frame?: undefined } | { width: number; height: number; frame: Frame; rgba?: undefined };
export type ImageDecoder = (file: Blob, raw?: boolean) => Promise<DecodedImage>;

const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
export const msToTicks = (ms: number) => UNIX_EPOCH_TICKS + BigInt(Math.round(ms)) * 10_000n;

export interface ImageEntry {
  file: Blob;
  name: string;
  exif: ExifInfo;
  timeMs: number | null;
  /** Kamera-RAW */
  raw?: boolean;
}

/**
 * Bildserie. Sortierung nach Aufnahmezeit (EXIF), sonst nach Dateiname.
 * Grösse und Farbe werden vom ersten Bild übernommen; abweichende Bilder werden mittig eingepasst.
 */
export class ImageSequenceSource implements FrameSource {
  readonly kind = "images" as const;
  readonly colorId: number;
  readonly bitDepth: number;
  /** RAW-Rohdaten (Bayer, linear) */
  readonly linear: boolean;
  meta: FrameSource["meta"] = {};
  get clock(): "utc" | "local" {
    return this.entries.every((e) => e.exif.offsetTimeOriginal) ? "utc" : "local";
  }

  private constructor(
    readonly entries: ImageEntry[],
    readonly width: number,
    readonly height: number,
    private readonly decode: ImageDecoder,
    first: DecodedImage,
  ) {
    this.colorId = first.frame ? first.frame.colorId : SerColor.RGB;
    this.bitDepth = first.frame ? first.frame.bitDepth : 8;
    this.linear = !!first.frame;
    const e = entries[0]?.exif;
    if (e?.model) this.meta.instrument = [e.make, e.model].filter(Boolean).join(" ");
    if (e?.focalLength) this.meta.telescope = `${Math.round(e.focalLength)} mm`;
  }

  static async open(files: { file: Blob; name: string; raw?: boolean }[], decode: ImageDecoder): Promise<ImageSequenceSource> {
    if (!files.length) throw new Error(msg("noImages"));
    const entries: ImageEntry[] = [];
    for (const f of files) {
      // FITS: Zeit, Belichtung und Kamera aus dem FITS-Kopf statt aus EXIF
      const fits = FITS_EXT.test(f.name) ? await readFitsHeader(f.file) : null;
      const exif = fits ? fitsExif(fits.header) : await readExifBlob(f.file);
      entries.push({ file: f.file, name: f.name.replace(/\.[^.]+$/, ""), exif, timeMs: exifTimeMs(exif), raw: f.raw });
    }
    const allTimed = entries.every((e) => e.timeMs !== null);
    entries.sort((a, b) =>
      allTimed && a.timeMs !== b.timeMs ? a.timeMs! - b.timeMs! : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    // Bildgrösse vom ersten lesbaren Bild übernehmen
    for (const e of entries) {
      try {
        const first = await decode(e.file, e.raw);
        return new ImageSequenceSource(entries, first.width, first.height, decode, first);
      } catch { /* nächstes Bild versuchen */ }
    }
    throw new Error(msg("unsupportedFiles"));
  }

  get frameCount() {
    return this.entries.length;
  }

  frameName(i: number) {
    return this.entries[i].name;
  }

  exposure(i: number): number | undefined {
    const e = this.entries[i].exif;
    if (!(e.exposureTime && e.exposureTime > 0)) return undefined;
    return (e.exposureTime * (e.iso && e.iso > 0 ? e.iso : 100)) / 100 / (e.fNumber && e.fNumber > 0 ? e.fNumber ** 2 : 1);
  }

  async readFrame(index: number): Promise<Frame> {
    const img = await this.decode(this.entries[index].file, this.entries[index].raw);
    const w = this.width, h = this.height;
    if (img.frame || this.linear) {
      // RAW-Rohdaten: gleiche Art wie das erste Bild verlangt (sonst wäre das Mosaik gemischt)
      if (!img.frame || img.frame.colorId !== this.colorId) throw new Error(msg("unreadable"));
      const f = img.frame;
      if (f.width === w && f.height === h) return f;
      // abweichende Grösse: mittig einpassen, gerade Versätze (Bayer)
      return cropFrame(f, (Math.floor((f.width - w) / 2)) & ~1, (Math.floor((f.height - h) / 2)) & ~1, w, h);
    }
    const data = new Uint8Array(w * h * 3);
    const ox = Math.floor((w - img.width) / 2), oy = Math.floor((h - img.height) / 2);
    for (let y = 0; y < h; y++) {
      const sy = y - oy;
      if (sy < 0 || sy >= img.height) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - ox;
        if (sx < 0 || sx >= img.width) continue;
        const s = (sy * img.width + sx) * 4, d = (y * w + x) * 3;
        data[d] = img.rgba![s];
        data[d + 1] = img.rgba![s + 1];
        data[d + 2] = img.rgba![s + 2];
      }
    }
    return { width: w, height: h, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
  }

  async readTimestamps(): Promise<BigInt64Array | null> {
    if (this.entries.some((e) => e.timeMs === null)) return null;
    return BigInt64Array.from(this.entries.map((e) => msToTicks(e.timeMs!)));
  }
}

/**
 * Mehrere Bilder in einer FITS-Datei (Würfel oder ein Bild je Erweiterung) – verhält sich wie ein SER-Video.
 * Zeitstempel: je Bildteil DATE-OBS; in einem Würfel gleichmässig verteilt bis DATE-END (ohne DATE-END keine
 * Zeitstempel, ausser jeder Bildteil hat genau ein Bild). Alle Bilder müssen gleich gross und gleich aufgebaut sein.
 */
export class FitsCubeSource implements FrameSource {
  readonly kind = "ser" as const;
  readonly linear = true;
  readonly clock = "utc" as const;
  readonly width: number;
  readonly height: number;
  readonly colorId: number;
  readonly bitDepth: number;
  readonly frameCount: number;
  meta: FrameSource["meta"] = {};
  /** Bild k → Bildteil und Nummer darin */
  private readonly where: { hdu: FitsImageHdu; index: number }[] = [];
  private readonly digits: number;

  private constructor(
    private readonly file: Blob,
    private readonly baseName: string,
    private readonly layout: FitsImageHdu[],
    first: Frame,
    private readonly scale: number,
  ) {
    for (const hdu of layout) for (let i = 0; i < hdu.frames; i++) this.where.push({ hdu, index: i });
    this.frameCount = this.where.length;
    this.digits = String(this.frameCount).length;
    this.width = first.width;
    this.height = first.height;
    this.colorId = first.colorId;
    this.bitDepth = first.bitDepth;
    const h = layout[0].header;
    const inst = fitsStr(h, "INSTRUME"), tel = fitsStr(h, "TELESCOP"), obs = fitsStr(h, "OBSERVER");
    if (inst) this.meta.instrument = inst;
    if (tel) this.meta.telescope = tel;
    else if (fitsNum(h, "FOCALLEN", 0) > 0) this.meta.telescope = `${Math.round(fitsNum(h, "FOCALLEN", 0))} mm`;
    if (obs) this.meta.observer = obs;
  }

  /** Öffnet die Datei als Bildfolge; null, wenn sie nur ein Bild enthält */
  static async open(file: Blob, name: string): Promise<FitsCubeSource | null> {
    const layout = await readFitsLayout(file);
    if (fitsFrameCount(layout) < 2) return null;
    const g = layout[0];
    if (layout.some((u) => u.width !== g.width || u.height !== g.height || u.planes !== g.planes || u.bitpix !== g.bitpix))
      throw new Error(msg("fitsUnsupported", "HDU"));
    const { frame, scale } = await decodeFitsFrame(file, g, 0);
    return new FitsCubeSource(file, name.replace(/\.[^.]+$/, ""), layout, frame, scale);
  }

  frameName(i: number) {
    return `${this.baseName}_${String(i + 1).padStart(this.digits, "0")}`;
  }

  async readFrame(i: number): Promise<Frame> {
    const w = this.where[i];
    if (!w) throw new Error(msg("unreadable"));
    return (await decodeFitsFrame(this.file, w.hdu, w.index, this.scale)).frame;
  }

  exposure(i: number): number | undefined {
    const e = fitsNum(this.where[i].hdu.header, "EXPTIME", fitsNum(this.where[i].hdu.header, "EXPOSURE", 0));
    return e > 0 ? e : undefined;
  }

  async readTimestamps(): Promise<BigInt64Array | null> {
    const out: number[] = [];
    for (const hdu of this.layout) {
      const h = hdu.header;
      const t0 = fitsTimeMs(fitsStr(h, "DATE-OBS"), fitsStr(h, "TIME-OBS"));
      if (t0 === null) return null;
      if (hdu.frames === 1) {
        out.push(t0);
        continue;
      }
      const t1 = fitsTimeMs(fitsStr(h, "DATE-END"));
      if (t1 === null || t1 <= t0) return null;
      for (let i = 0; i < hdu.frames; i++) out.push(t0 + ((t1 - t0) * i) / hdu.frames);
    }
    return BigInt64Array.from(out.map(msToTicks));
  }
}
