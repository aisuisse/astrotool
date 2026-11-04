// Zeitraffer erzeugen (läuft im Worker): MP4/WebM über WebCodecs (mediabunny), GIF über gifenc.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, type VideoCodec } from "mediabunny";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { Frame } from "./engine/ser";
import { msg } from "./i18n";
import { setMp4CreationTime } from "./engine/mp4time";
import { buildSequence, constantRateCounts, isMp4, outputSize, ticksToClock, videoFrameRate, type TimelapseOptions } from "./engine/timelapse";

/** Ein konkreter Encoder-Plan. Die Codec-Strings legen Profil und Level fest, die Handys sicher abspielen. */
interface VideoPlan {
  codec: VideoCodec;
  codecString?: string;
  label: string;
  /** Zielbitrate als Bits pro Pixel und Bild (Qualität "sehr gut", VBR) */
  bitsPerPixel: number;
  hardware: "no-preference" | "prefer-hardware";
}
// HEVC Main, Level 4.0 (30 fps) / 4.1 (60 fps), Kennung "hvc1" (nötig für Apple-Geräte und Google Fotos)
const HEVC = (high: boolean): VideoPlan => ({ codec: "hevc", codecString: high ? "hvc1.1.6.L123.B0" : "hvc1.1.6.L120.B0", label: "H.265/HEVC", bitsPerPixel: 0.08, hardware: "prefer-hardware" });
// H.264 High, Level 4.0 (30 fps) / 4.2 (60 fps)
const H264 = (high: boolean): VideoPlan => ({ codec: "avc", codecString: high ? "avc1.64002a" : "avc1.640028", label: "H.264", bitsPerPixel: 0.14, hardware: "no-preference" });
const VP9: VideoPlan = { codec: "vp9", label: "VP9", bitsPerPixel: 0.1, hardware: "no-preference" };
const VP8: VideoPlan = { codec: "vp8", label: "VP8", bitsPerPixel: 0.16, hardware: "no-preference" };

async function supports(p: VideoPlan, width: number, height: number, framerate: number): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  const codec = p.codecString ?? ({ vp9: "vp09.00.40.08", vp8: "vp8" } as Record<string, string>)[p.codec] ?? p.codec;
  try {
    const r = await VideoEncoder.isConfigSupported({
      codec, width, height, framerate,
      bitrate: Math.round(width * height * framerate * p.bitsPerPixel),
      hardwareAcceleration: p.hardware,
    });
    return !!r.supported;
  } catch {
    return false;
  }
}

/** Frame → RGBA 8 bit ohne Helligkeitsänderung (16-bit wird auf 8 bit reduziert). */
export function frameToRGBA8(f: Frame): Uint8ClampedArray<ArrayBuffer> {
  const n = f.width * f.height;
  const rgba = new Uint8ClampedArray(n * 4);
  const shift = Math.max(0, f.bitDepth - 8);
  const bgr = f.colorId === 101;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (f.planes === 3) {
      const j = i * 3;
      rgba[o] = f.data[bgr ? j + 2 : j] >> shift;
      rgba[o + 1] = f.data[j + 1] >> shift;
      rgba[o + 2] = f.data[bgr ? j : j + 2] >> shift;
    } else rgba[o] = rgba[o + 1] = rgba[o + 2] = f.data[i] >> shift;
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** HEVC über das lokale FFmpeg (nur in der Windows-App). Wird vom Worker über das Hauptfenster aufgerufen. */
export interface NativeHevc {
  begin(width: number, height: number, fps: number, title?: string, date?: string): Promise<{ encoder: string }>;
  frame(rgba: Uint8ClampedArray, repeat: number): Promise<void>;
  finish(): Promise<ArrayBuffer>;
}

export interface TimelapseResult {
  blob: Blob;
  fileName: string;
  codec: string;
  frames: number;
  seconds: number;
  /** HEVC war gewünscht, der Browser konnte es nicht – es wurde H.264 verwendet. */
  fallback?: boolean;
}

/** Sammelt die fertig zugeschnittenen Bilder (verlustfrei als PNG) und baut daraus den Zeitraffer. */
export class TimelapseRecorder {
  private frames: { blob: Blob; stamp?: bigint }[] = [];
  private width = 0;
  private height = 0;

  async add(f: Frame, stamp?: bigint): Promise<void> {
    this.width = f.width;
    this.height = f.height;
    const c = new OffscreenCanvas(f.width, f.height);
    c.getContext("2d")!.putImageData(new ImageData(frameToRGBA8(f), f.width, f.height), 0, 0);
    this.frames.push({ blob: await c.convertToBlob({ type: "image/png" }), stamp });
  }

  get count(): number {
    return this.frames.length;
  }

  /** Frühester Zeitstempel der gesammelten Bilder (für das Aufnahmedatum im Video) */
  firstStamp(): bigint | undefined {
    const s = this.frames.map((f) => f.stamp).filter((x): x is bigint => x !== undefined && x > 0n);
    return s.length ? s.reduce((a, b) => (b < a ? b : a)) : undefined;
  }

  async render(o: TimelapseOptions, baseName: string, onProgress: (done: number, total: number) => void, recorded?: Date, native?: NativeHevc): Promise<TimelapseResult> {
    if (!this.frames.length) throw new Error(msg("noTimelapseFrames"));
    // Ein Zeitraffer läuft in Aufnahmereihenfolge – auch wenn die Einzelbilder nach Qualität sortiert gespeichert wurden.
    if (this.frames.every((f) => f.stamp !== undefined && f.stamp > 0n)) {
      this.frames.sort((a, b) => (a.stamp! < b.stamp! ? -1 : a.stamp! > b.stamp! ? 1 : 0));
    }
    const seq = buildSequence(this.frames.length, o);
    // gleiche aufeinanderfolgende Bilder zusammenfassen → ein Bild mit längerer Dauer
    const runs: { idx: number; count: number }[] = [];
    for (const i of seq) {
      const last = runs[runs.length - 1];
      if (last && last.idx === i) last.count++;
      else runs.push({ idx: i, count: 1 });
    }
    const [W, H] = outputSize(this.width, this.height, o);
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext("2d", { willReadFrequently: o.format === "gif" || !!native })!;
    g.imageSmoothingQuality = "high";

    const draw = async (idx: number) => {
      const bmp = await createImageBitmap(this.frames[idx].blob);
      g.fillStyle = "#000";
      g.fillRect(0, 0, W, H);
      g.drawImage(bmp, 0, 0, W, H);
      bmp.close();
      const size = Math.max(12, Math.round(H * 0.045));
      g.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
      g.textBaseline = "alphabetic";
      g.lineJoin = "round";
      g.lineWidth = Math.max(2, size / 6);
      g.strokeStyle = "rgba(0,0,0,0.85)";
      g.fillStyle = "#fff";
      const pad = Math.round(size * 0.6);
      const text = (s: string, x: number, y: number) => {
        g.strokeText(s, x, y);
        g.fillText(s, x, y);
      };
      if (o.title) {
        // Langer Titel in schmalem Video: Schrift verkleinern, bis er in die Breite passt (nicht abschneiden)
        const fit = Math.min(1, (W - 2 * pad) / Math.max(1, g.measureText(o.title).width));
        if (fit < 1) {
          const small = Math.max(9, Math.floor(size * fit));
          g.font = `600 ${small}px system-ui, "Segoe UI", sans-serif`;
          g.lineWidth = Math.max(2, small / 6);
        }
        text(o.title, pad, pad + size);
        g.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
        g.lineWidth = Math.max(2, size / 6);
      }
      const clock = o.showTime ? ticksToClock(this.frames[idx].stamp) : "";
      if (clock) text(clock, pad, H - pad);
    };

    const total = runs.length;
    const seconds = seq.length / o.fps;
    if (o.format === "gif") {
      // Eine gemeinsame Farbpalette aus Stichproben verhindert Flackern zwischen den Bildern
      const samples = [0, Math.floor(runs.length / 3), Math.floor((2 * runs.length) / 3), runs.length - 1];
      const sampleData = new Uint8ClampedArray(samples.length * W * H * 4);
      for (let k = 0; k < samples.length; k++) {
        await draw(runs[samples[k]].idx);
        sampleData.set(g.getImageData(0, 0, W, H).data, k * W * H * 4);
      }
      const palette = quantize(sampleData, 256);
      const gif = GIFEncoder();
      for (let k = 0; k < runs.length; k++) {
        await draw(runs[k].idx);
        const index = applyPalette(g.getImageData(0, 0, W, H).data, palette);
        gif.writeFrame(index, W, H, { palette: k === 0 ? palette : undefined, delay: (runs[k].count * 1000) / o.fps, repeat: 0 });
        onProgress(k + 1, total);
      }
      gif.finish();
      const bytes = gif.bytes();
      return { blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/gif" }), fileName: `${baseName}_timelapse.gif`, codec: "GIF", frames: seq.length, seconds };
    }

    // MP4 zum Teilen (WhatsApp, Google Fotos): konstante Bildrate, "fast start", Profile, die Handys abspielen.
    const outFps = videoFrameRate(o.fps);
    const highRate = outFps > 30;
    const plans: VideoPlan[] = [];
    if (o.format === "mp4-hevc") plans.push(HEVC(highRate));
    if (isMp4(o.format)) plans.push(H264(highRate));
    plans.push(VP9, VP8);
    if (!isMp4(o.format)) plans.push(H264(highRate));
    // Windows-App: WebView2 kann kein HEVC kodieren → lokales FFmpeg verwenden
    let nativeFailed = false;
    if (o.format === "mp4-hevc" && native && !(await supports(HEVC(highRate), W, H, outFps))) {
      try {
        const { encoder } = await native.begin(W, H, outFps, o.title || undefined, recorded?.toISOString());
        const counts = constantRateCounts(runs.map((r) => r.count), o.fps, outFps);
        for (let k = 0; k < runs.length; k++) {
          await draw(runs[k].idx);
          if (counts[k] > 0) await native.frame(g.getImageData(0, 0, W, H).data, counts[k]);
          onProgress(k + 1, total);
        }
        const buf = await native.finish();
        return {
          blob: new Blob([buf], { type: "video/mp4" }),
          fileName: `${baseName}_timelapse.mp4`,
          codec: `H.265/HEVC (FFmpeg ${encoder})`,
          frames: seq.length,
          seconds,
        };
      } catch {
        nativeFailed = true; // kein FFmpeg oder Fehler → wie bisher mit H.264 weiter
      }
    }
    let plan: VideoPlan | null = null;
    for (const p of plans) {
      if (await supports(p, W, H, outFps)) {
        plan = p;
        break;
      }
    }
    if (!plan) throw new Error(msg("noVideoCodec"));
    const container = plan.codec === "avc" || plan.codec === "hevc" ? "mp4" : "webm";
    const output = new Output({
      format: container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(canvas, {
      codec: plan.codec,
      bitrate: Math.round(W * H * outFps * plan.bitsPerPixel),
      keyFrameInterval: 2,
      fullCodecString: plan.codecString,
      hardwareAcceleration: plan.hardware,
    });
    output.addVideoTrack(source, { frameRate: outFps });
    // Aufnahmedatum und Titel: Google Fotos & Co. sortieren das Video dann beim Aufnahmetag ein.
    output.setMetadataTags({ ...(recorded ? { date: recorded } : {}), ...(o.title ? { title: o.title } : {}) });
    await output.start();
    const counts = constantRateCounts(runs.map((r) => r.count), o.fps, outFps);
    let n = 0;
    for (let k = 0; k < runs.length; k++) {
      await draw(runs[k].idx);
      // Gleiches Bild mehrfach: kostet bei VBR fast nichts, ergibt aber eine konstante Bildrate.
      for (let j = 0; j < counts[k]; j++, n++) await source.add(n / outFps, 1 / outFps);
      onProgress(k + 1, total);
    }
    await output.finalize();
    const buf = (output.target as BufferTarget).buffer!;
    // Aufnahmezeitpunkt auch als creation_time der MP4-Datei (Google Fotos sortiert danach)
    if (container === "mp4" && recorded) setMp4CreationTime(new Uint8Array(buf), recorded);
    return {
      blob: new Blob([buf], { type: container === "mp4" ? "video/mp4" : "video/webm" }),
      fileName: `${baseName}_timelapse.${container}`,
      codec: plan.label,
      frames: seq.length,
      seconds,
      fallback: (o.format === "mp4-hevc" && plan.codec !== "hevc") || nativeFailed,
    };
  }
}
