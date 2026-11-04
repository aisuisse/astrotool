// AVI lesen – wie es Aufnahmeprogramme für Planeten schreiben (SharpCap, FireCapture, Genika, ASICap …).
// Eigene Umsetzung nach der RIFF/AVI-Beschreibung (Microsoft) und der OpenDML-Erweiterung für Dateien > 1 GB.
//
// Unterstützt: unkomprimiert 8 bit grau (Palette, Y800/Y8/GREY), 16 bit grau (Y16), 24/32 bit BGR(A)
// (auch von unten nach oben gespeichert), MJPEG (über den Bild-Dekoder). Bayer-Rohdaten kommen als 8/16 bit grau;
// das Muster lässt sich unter „Farbkamera (Debayer)“ einstellen.
// Gelesen wird nur, was gebraucht wird: Beim Öffnen die Chunk-Köpfe, danach je Bild genau dessen Daten.
import { SerColor, type Frame } from "./ser";
import type { FrameSource, ImageDecoder } from "./source";
import { msg } from "../i18n";

type Layout =
  | { kind: "gray8"; stride: number; flip: boolean; palette?: Uint8Array }
  | { kind: "pal8"; stride: number; flip: boolean; palette: Uint8Array }
  | { kind: "gray16"; stride: number; flip: boolean }
  | { kind: "bgr"; stride: number; flip: boolean; bpp: 3 | 4 }
  | { kind: "jpeg" };

export interface AviInfo {
  width: number;
  height: number;
  fps: number | null;
  fourcc: string;
  bitCount: number;
  /** Bild-Daten: Lage und Grösse je Frame */
  frames: { offset: number; size: number }[];
  /** Lage des BITMAPINFOHEADER (strf) in der Datei */
  strfPos: number;
}

const fourcc = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

async function view(b: Blob, off: number, len: number): Promise<DataView> {
  return new DataView(await b.slice(off, Math.min(b.size, off + len)).arrayBuffer());
}

export class AviSource implements FrameSource {
  readonly kind = "video" as const;
  readonly clock = "utc" as const;
  readonly meta: FrameSource["meta"] = {};
  readonly colorId: number;
  readonly bitDepth: number;
  readonly width: number;
  readonly height: number;

  private constructor(
    private readonly file: Blob,
    private readonly baseName: string,
    readonly info: AviInfo,
    private readonly layout: Layout,
    private readonly decode?: ImageDecoder,
  ) {
    this.width = info.width;
    this.height = info.height;
    this.colorId = layout.kind === "gray8" || layout.kind === "gray16" ? SerColor.MONO : SerColor.RGB;
    this.bitDepth = layout.kind === "gray16" ? 16 : 8;
    this.meta.instrument = `AVI ${info.fourcc.trim() || "RGB"}`;
  }

  get frameCount() {
    return this.info.frames.length;
  }
  get fps() {
    return this.info.fps;
  }

  static async open(file: Blob, name: string, decode?: ImageDecoder): Promise<AviSource> {
    const info = await parseAvi(file);
    const layout = await layoutFor(file, info);
    if (layout.kind === "jpeg" && !decode) throw new Error(msg("aviUnsupported", info.fourcc));
    return new AviSource(file, name.replace(/\.[^.]+$/, ""), info, layout, decode);
  }

  frameName(i: number) {
    return `${this.baseName}_${String(i + 1).padStart(String(this.frameCount).length, "0")}`;
  }

  async readTimestamps(): Promise<BigInt64Array | null> {
    return null; // AVI kennt keine Aufnahmezeit je Bild
  }

  async readFrame(index: number): Promise<Frame> {
    const f = this.info.frames[index];
    const raw = new Uint8Array(await this.file.slice(f.offset, f.offset + f.size).arrayBuffer());
    const { width: w, height: h } = this;
    const L = this.layout;
    if (L.kind === "jpeg") {
      const img = await this.decode!(new Blob([raw], { type: "image/jpeg" }));
      const data = new Uint8Array(w * h * 3);
      for (let i = 0; i < Math.min(w * h, img.width * img.height); i++) {
        data[i * 3] = img.rgba![i * 4];
        data[i * 3 + 1] = img.rgba![i * 4 + 1];
        data[i * 3 + 2] = img.rgba![i * 4 + 2];
      }
      return { width: w, height: h, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
    }
    const row = (y: number) => (L.flip ? h - 1 - y : y) * L.stride;
    if (L.kind === "gray8") {
      const data = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) data.set(raw.subarray(row(y), row(y) + w), y * w);
      if (L.palette) for (let i = 0; i < data.length; i++) data[i] = L.palette[data[i] * 4]; // graue Palette, evtl. nicht linear
      return { width: w, height: h, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data };
    }
    if (L.kind === "gray16") {
      const data = new Uint16Array(w * h);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = dv.getUint16(row(y) + 2 * x, true);
      return { width: w, height: h, planes: 1, bitDepth: 16, colorId: SerColor.MONO, data };
    }
    const data = new Uint8Array(w * h * 3);
    if (L.kind === "pal8") {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = raw[row(y) + x] * 4, d = (y * w + x) * 3;
          data[d] = L.palette[p + 2]; data[d + 1] = L.palette[p + 1]; data[d + 2] = L.palette[p];
        }
    } else {
      const bpp = L.bpp;
      for (let y = 0; y < h; y++) {
        const r = row(y);
        for (let x = 0; x < w; x++) {
          const s = r + x * bpp, d = (y * w + x) * 3;
          data[d] = raw[s + 2]; data[d + 1] = raw[s + 1]; data[d + 2] = raw[s];
        }
      }
    }
    return { width: w, height: h, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
  }
}

interface StreamHeader { fccType: string; handler: string; scale: number; rate: number }

/** Liest Kopf und Lage aller Video-Bilder. Unterstützt mehrere RIFF-Abschnitte (OpenDML, „AVIX“). */
export async function parseAvi(file: Blob): Promise<AviInfo> {
  const head = await view(file, 0, 12);
  if (head.byteLength < 12 || fourcc(head, 0) !== "RIFF" || fourcc(head, 8) !== "AVI ") throw new Error(msg("aviInvalid"));
  let width = 0, height = 0, usPerFrame = 0, bitCount = 0, compression = "", videoStream = -1;
  let fps: number | null = null;
  const frames: { offset: number; size: number }[] = [];
  let streamNo = 0;
  let strfPos = -1;

  // Alle Chunks eines Bereichs durchlaufen
  async function walk(start: number, end: number, inMovi: boolean): Promise<void> {
    let off = start;
    while (off + 8 <= end) {
      const v = await view(file, off, 12);
      if (v.byteLength < 8) return;
      const id = fourcc(v, 0);
      const size = v.getUint32(4, true);
      const next = off + 8 + size + (size & 1);
      if (id === "LIST" || id === "RIFF") {
        const type = v.byteLength >= 12 ? fourcc(v, 8) : "";
        if (type === "strl") {
          await walkStrl(off + 12, Math.min(end, off + 8 + size));
          streamNo++;
        } else if (type === "movi" || type === "rec ") await walk(off + 12, Math.min(file.size, off + 8 + size), true);
        else if (type === "hdrl" || type === "AVI " || type === "AVIX") await walk(off + 12, Math.min(file.size, off + 8 + size), false);
      } else if (id === "avih" && !inMovi) {
        const h = await view(file, off + 8, 40);
        usPerFrame = h.getUint32(0, true);
        width = h.getUint32(32, true);
        height = h.getUint32(36, true);
      } else if (inMovi && videoStream >= 0 && size > 0) {
        const nn = String(videoStream).padStart(2, "0");
        if (id === `${nn}db` || id === `${nn}dc`) frames.push({ offset: off + 8, size });
      }
      if (next <= off) return; // kaputte Grösse
      off = next;
    }
  }

  async function walkStrl(start: number, end: number) {
    let off = start;
    let strh: StreamHeader | null = null;
    while (off + 8 <= end) {
      const v = await view(file, off, 8);
      const id = fourcc(v, 0), size = v.getUint32(4, true);
      if (id === "strh") {
        const h = await view(file, off + 8, 36);
        strh = { fccType: fourcc(h, 0), handler: fourcc(h, 4), scale: h.getUint32(20, true), rate: h.getUint32(24, true) };
      } else if (id === "strf" && strh?.fccType === "vids" && videoStream < 0) {
        const b = await view(file, off + 8, 40);
        width = Math.abs(b.getInt32(4, true)) || width;
        height = b.getInt32(8, true);
        bitCount = b.getUint16(14, true);
        const c = b.getUint32(16, true);
        compression = c === 0 ? "" : c === 3 ? "BITF" : fourcc(b, 16);
        strfPos = off + 8;
        videoStream = streamNo;
        if (strh.scale > 0 && strh.rate > 0) fps = strh.rate / strh.scale;
      }
      off += 8 + size + (size & 1);
    }
  }

  // Die Datei kann aus mehreren RIFF-Abschnitten bestehen (RIFF AVI , RIFF AVIX, …)
  let off = 0;
  while (off + 12 <= file.size) {
    const v = await view(file, off, 12);
    if (fourcc(v, 0) !== "RIFF") break;
    const size = v.getUint32(4, true);
    await walk(off + 12, Math.min(file.size, off + 8 + size), false);
    const next = off + 8 + size + (size & 1);
    if (next <= off) break;
    off = next;
  }
  if (videoStream < 0 || !width) throw new Error(msg("aviInvalid"));
  if (!fps && usPerFrame) fps = 1e6 / usPerFrame;
  return { width, height, fps, fourcc: compression, bitCount, frames, strfPos };
}

async function layoutFor(file: Blob, info: AviInfo): Promise<Layout> {
  const strfPos = info.strfPos;
  const b = await view(file, strfPos, 40);
  const biSize = b.getUint32(0, true);
  const rawHeight = b.getInt32(8, true);
  const clrUsed = b.getUint32(32, true);
  const w = info.width;
  const bottomUp = rawHeight > 0;
  info.height = Math.abs(rawHeight);
  const fc = info.fourcc.toUpperCase().replace(/\0/g, " ");
  const dibStride = (bpp: number) => Math.ceil((w * bpp) / 32) * 4;
  if (fc === "Y800" || fc === "Y8  " || fc === "GREY" || fc === "Y8") return { kind: "gray8", stride: w, flip: false };
  if (fc === "Y16 " || fc === "Y16") return { kind: "gray16", stride: w * 2, flip: false };
  if (fc === "MJPG" || fc === "JPEG") return { kind: "jpeg" };
  if (fc === "" || fc === "DIB " || fc === "RGB " || fc === "RAW ") {
    if (info.bitCount === 8) {
      const n = clrUsed || 256;
      const pal = new Uint8Array(await file.slice(strfPos + biSize, strfPos + biSize + n * 4).arrayBuffer());
      const palette = new Uint8Array(256 * 4);
      palette.set(pal.subarray(0, Math.min(pal.length, 1024)));
      let gray = true, identity = true;
      for (let i = 0; i < n && 4 * i + 2 < pal.length; i++) {
        if (pal[4 * i] !== pal[4 * i + 1] || pal[4 * i] !== pal[4 * i + 2]) gray = false;
        if (pal[4 * i] !== i) identity = false;
      }
      if (gray) return { kind: "gray8", stride: dibStride(8), flip: bottomUp, palette: identity ? undefined : palette };
      return { kind: "pal8", stride: dibStride(8), flip: bottomUp, palette };
    }
    if (info.bitCount === 24 || info.bitCount === 32) return { kind: "bgr", stride: dibStride(info.bitCount), flip: bottomUp, bpp: (info.bitCount / 8) as 3 | 4 };
  }
  throw new Error(msg("aviUnsupported", `${info.fourcc.trim() || "RGB"} ${info.bitCount} bit`));
}
