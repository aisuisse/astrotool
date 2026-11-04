// SER-Videoformat (LuCam Recorder, Spezifikation v3).
// Header 178 Byte, danach Frames, optional Zeitstempel-Anhang (int64 pro Frame).

import { MemorySink, type ByteSink } from "./sink";
import { msg } from "../i18n";

export const SER_HEADER_SIZE = 178;

export enum SerColor {
  MONO = 0,
  BAYER_RGGB = 8,
  BAYER_GRBG = 9,
  BAYER_GBRG = 10,
  BAYER_BGGR = 11,
  RGB = 100,
  BGR = 101,
}

export interface SerHeader {
  luId: number;
  colorId: number;
  /** Rohwert des Headers. Viele Programme schreiben 0, obwohl die Daten little-endian sind. */
  littleEndianFlag: number;
  width: number;
  height: number;
  bitDepth: number;
  frameCount: number;
  observer: string;
  instrument: string;
  telescope: string;
  dateTime: bigint;
  dateTimeUtc: bigint;
}

export interface SerLayout {
  planes: number;
  bytesPerSample: number;
  frameBytes: number;
}

export function serLayout(h: Pick<SerHeader, "colorId" | "bitDepth" | "width" | "height">): SerLayout {
  const planes = h.colorId === SerColor.RGB || h.colorId === SerColor.BGR ? 3 : 1;
  const bytesPerSample = h.bitDepth > 8 ? 2 : 1;
  return { planes, bytesPerSample, frameBytes: h.width * h.height * planes * bytesPerSample };
}

export function colorName(id: number): string {
  return (
    { 0: "Mono", 8: "Bayer RGGB", 9: "Bayer GRBG", 10: "Bayer GBRG", 11: "Bayer BGGR", 100: "RGB", 101: "BGR" } as Record<number, string>
  )[id] ?? `Unbekannt (${id})`;
}

export function isBayer(id: number): boolean {
  return id >= 8 && id <= 19;
}

const dec = new TextDecoder("latin1");
function readStr(v: DataView, off: number, len: number): string {
  return dec.decode(new Uint8Array(v.buffer, v.byteOffset + off, len)).replace(/\0.*$/s, "").trim();
}

export function parseSerHeader(buf: ArrayBuffer): SerHeader {
  if (buf.byteLength < SER_HEADER_SIZE) throw new Error(msg("serTooSmall"));
  const v = new DataView(buf);
  const id = readStr(v, 0, 14);
  if (!id.startsWith("LUCAM-RECORDER")) throw new Error(msg("notSer", id));
  const h: SerHeader = {
    luId: v.getInt32(14, true),
    colorId: v.getInt32(18, true),
    littleEndianFlag: v.getInt32(22, true),
    width: v.getInt32(26, true),
    height: v.getInt32(30, true),
    bitDepth: v.getInt32(34, true),
    frameCount: v.getInt32(38, true),
    observer: readStr(v, 42, 40),
    instrument: readStr(v, 82, 40),
    telescope: readStr(v, 122, 40),
    dateTime: v.getBigInt64(162, true),
    dateTimeUtc: v.getBigInt64(170, true),
  };
  if (h.width <= 0 || h.height <= 0 || h.bitDepth < 1 || h.bitDepth > 16) {
    throw new Error(msg("badSerHeader", h.width, h.height, h.bitDepth));
  }
  return h;
}

export function buildSerHeader(h: SerHeader): ArrayBuffer {
  const buf = new ArrayBuffer(SER_HEADER_SIZE);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const put = (off: number, len: number, s: string) => {
    for (let i = 0; i < Math.min(len, s.length); i++) u8[off + i] = s.charCodeAt(i) & 0xff;
  };
  put(0, 14, "LUCAM-RECORDER");
  v.setInt32(14, h.luId, true);
  v.setInt32(18, h.colorId, true);
  v.setInt32(22, h.littleEndianFlag, true);
  v.setInt32(26, h.width, true);
  v.setInt32(30, h.height, true);
  v.setInt32(34, h.bitDepth, true);
  v.setInt32(38, h.frameCount, true);
  put(42, 40, h.observer);
  put(82, 40, h.instrument);
  put(122, 40, h.telescope);
  v.setBigInt64(162, h.dateTime, true);
  v.setBigInt64(170, h.dateTimeUtc, true);
  return buf;
}

/** Ein Frame im Speicher: Rohwerte, interleaved bei RGB/BGR. */
export interface Frame {
  width: number;
  height: number;
  planes: number;
  bitDepth: number;
  colorId: number;
  data: Uint8Array | Uint16Array;
}

/** Liest SER-Dateien frameweise aus einem Blob/File, ohne die ganze Datei zu laden. */
export class SerReader {
  readonly layout: SerLayout;
  private timestamps: BigInt64Array | null = null;

  private constructor(
    private readonly blob: Blob,
    readonly header: SerHeader,
    readonly bigEndian: boolean,
  ) {
    this.layout = serLayout(header);
  }

  /** Hat die Datei nach den Frames einen Zeitstempel-Anhang? (nach evtl. Reparatur der Frame-Zahl) */
  get hasTrailer(): boolean {
    const n = this.header.frameCount;
    return n > 0 && this.blob.size >= SER_HEADER_SIZE + this.layout.frameBytes * n + 8 * n;
  }

  static async open(blob: Blob, opts: { bigEndian?: boolean } = {}): Promise<SerReader> {
    const header = parseSerHeader(await blob.slice(0, SER_HEADER_SIZE).arrayBuffer());
    const reader = new SerReader(blob, header, opts.bigEndian ?? false);
    const needed = SER_HEADER_SIZE + reader.layout.frameBytes * header.frameCount;
    if (header.frameCount <= 0) {
      // Defekter Header ("0 Frames", z. B. nach Absturz der Aufnahmesoftware): aus der Dateigrösse bestimmen.
      header.frameCount = Math.floor((blob.size - SER_HEADER_SIZE) / reader.layout.frameBytes);
    } else if (blob.size < needed) {
      // Abgebrochene Aufnahme: nur vollständige Frames verwenden.
      header.frameCount = Math.floor((blob.size - SER_HEADER_SIZE) / reader.layout.frameBytes);
    }
    return reader;
  }

  async readFrame(index: number): Promise<Frame> {
    const { header: h, layout: l } = this;
    if (index < 0 || index >= h.frameCount) throw new RangeError(`Frame ${index} existiert nicht`);
    const off = SER_HEADER_SIZE + index * l.frameBytes;
    const buf = await this.blob.slice(off, off + l.frameBytes).arrayBuffer();
    let data: Uint8Array | Uint16Array;
    if (l.bytesPerSample === 1) {
      data = new Uint8Array(buf);
    } else {
      data = new Uint16Array(buf);
      if (this.bigEndian) {
        for (let i = 0; i < data.length; i++) data[i] = ((data[i] & 0xff) << 8) | (data[i] >> 8);
      }
    }
    return { width: h.width, height: h.height, planes: l.planes, bitDepth: h.bitDepth, colorId: h.colorId, data };
  }

  /** Zeitstempel (100-ns-Ticks seit 0001-01-01) oder null, wenn die Datei keine hat. */
  async readTimestamps(): Promise<BigInt64Array | null> {
    if (!this.hasTrailer) return null;
    if (!this.timestamps) {
      const off = SER_HEADER_SIZE + this.layout.frameBytes * this.header.frameCount;
      const buf = await this.blob.slice(off, off + 8 * this.header.frameCount).arrayBuffer();
      this.timestamps = new BigInt64Array(buf);
    }
    return this.timestamps;
  }
}

/** Baut eine SER-Datei aus Frames zusammen. Blob-Teile werden vom Browser bei Bedarf ausgelagert. */
export class SerWriter {
  private stamps: bigint[] = [];
  private count = 0;

  /** sink: Ziel (Standard: im Speicher). Der Kopf wird zuerst geschrieben und am Schluss mit der Bildzahl ergänzt. */
  constructor(private readonly header: Omit<SerHeader, "frameCount">, readonly sink: ByteSink = new MemorySink()) {
    sink.write(new Uint8Array(buildSerHeader({ ...header, frameCount: 0 })));
  }

  add(frame: Frame, timestamp?: bigint): void {
    const h = this.header;
    if (frame.width !== h.width || frame.height !== h.height) throw new Error(msg("frameSize"));
    const d = frame.data;
    this.sink.write(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    this.stamps.push(timestamp ?? 0n);
    this.count++;
  }

  get frameCount(): number {
    return this.count;
  }

  private complete(): void {
    if (this.stamps.some((s) => s !== 0n)) this.sink.write(new Uint8Array(BigInt64Array.from(this.stamps).buffer));
    this.sink.writeAt(0, new Uint8Array(buildSerHeader({ ...this.header, frameCount: this.count })));
  }

  /** abschliessen: Zeitstempel anhängen, Bildzahl eintragen; Blob nur im Speicher */
  async finish(): Promise<Blob | null> {
    this.complete();
    return this.sink.close("application/octet-stream");
  }

  /** nur für das Ziel im Speicher */
  toBlob(): Blob {
    if (!(this.sink instanceof MemorySink)) throw new Error("toBlob needs a MemorySink");
    this.complete();
    return this.sink.toBlob();
  }
}
