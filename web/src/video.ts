// MP4, MOV, MKV, WebM lesen (Handy, Systemkamera, Aufnahmeprogramme) – über mediabunny und den
// Video-Dekoder des Browsers bzw. von WebView2 (WebCodecs). Läuft im Worker, braucht kein FFmpeg.
// Bilder werden der Reihe nach dekodiert; ein Sprung (Qualitätsreihenfolge) beginnt beim letzten Schlüsselbild.
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny";
import { SerColor, type Frame } from "./engine/ser";
import { msToTicks, type FrameSource } from "./engine/source";
import { msg } from "./i18n";

export class MediaVideoSource implements FrameSource {
  readonly kind = "video" as const;
  readonly clock = "utc" as const;
  readonly colorId = SerColor.RGB;
  readonly bitDepth = 8;
  readonly meta: FrameSource["meta"] = {};
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private nextIndex = -1;
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  private constructor(
    private readonly input: Input,
    private readonly sink: VideoSampleSink,
    /** Darstellungszeit je Bild in Sekunden, aufsteigend */
    private readonly times: number[],
    readonly width: number,
    readonly height: number,
    private readonly baseName: string,
    private readonly created: Date | undefined,
    readonly fps: number | null,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  static async open(file: Blob, name: string): Promise<MediaVideoSource> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(msg("videoNoTrack"));
    const codec = (await track.getCodec()) ?? "?";
    if (!(await track.canDecode())) throw new Error(msg("videoNoDecoder", codec));
    // Zeitstempel aller Bilder aus den Paketen (ohne zu dekodieren)
    const times: number[] = [];
    for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) times.push(p.timestamp);
    times.sort((a, b) => a - b);
    const w = await track.getDisplayWidth(), h = await track.getDisplayHeight();
    let created: Date | undefined;
    try { created = (await input.getMetadataTags()).date; } catch { /* ohne Datum */ }
    const fps = times.length > 1 ? (times.length - 1) / (times[times.length - 1] - times[0]) : null;
    const src = new MediaVideoSource(input, new VideoSampleSink(track), times, w, h, name.replace(/\.[^.]+$/, ""), created, fps);
    src.meta.instrument = `Video ${codec.toUpperCase()}`;
    return src;
  }

  get frameCount() {
    return this.times.length;
  }

  frameName(i: number) {
    return `${this.baseName}_${String(i + 1).padStart(String(this.frameCount).length, "0")}`;
  }

  async readTimestamps(): Promise<BigInt64Array | null> {
    // Nur mit Aufnahmedatum aus der Datei – sonst wären es Zeiten ab 0
    if (!this.created || isNaN(this.created.getTime())) return null;
    const t0 = this.created.getTime(), first = this.times[0];
    return BigInt64Array.from(this.times.map((t) => msToTicks(t0 + (t - first) * 1000)));
  }

  async readFrame(index: number): Promise<Frame> {
    if (!this.iter || index !== this.nextIndex) {
      await this.iter?.return();
      // etwas vor der Darstellungszeit beginnen, damit Rundungen das Bild nicht überspringen
      this.iter = this.sink.samples(Math.max(0, this.times[index] - 1e-4));
      this.nextIndex = index;
    }
    let sample: VideoSample | undefined;
    // Bilder vor dem gewünschten überspringen (falls der Dekoder früher beginnt)
    for (;;) {
      const r = await this.iter.next();
      if (r.done) break;
      if (r.value.timestamp + 1e-4 < this.times[index]) { r.value.close(); continue; }
      sample = r.value;
      break;
    }
    if (!sample) throw new Error(msg("unreadable"));
    this.nextIndex = index + 1;
    const { width: w, height: h } = this;
    this.ctx.clearRect(0, 0, w, h);
    sample.draw(this.ctx, 0, 0, w, h);
    sample.close();
    const rgba = this.ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      data[i * 3] = rgba[j];
      data[i * 3 + 1] = rgba[j + 1];
      data[i * 3 + 2] = rgba[j + 2];
    }
    return { width: w, height: h, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
  }

  dispose() {
    void this.iter?.return();
    this.input.dispose();
  }
}
