/// <reference lib="webworker" />
// Rechenarbeit läuft hier, damit die Oberfläche flüssig bleibt.
import { analyseFrame, colouriseOutput, outputColorId, outputSize, processSource, type FrameResult, type ProcessOptions } from "./engine/pipeline";
import { hasTransform, transformedSize } from "./engine/transform";
import { movieMeta } from "./engine/eclipsemovie";
import { colorName, SerReader, SerWriter, type Frame } from "./engine/ser";
import { FitsCubeSource, ImageSequenceSource, JoinedSource, serSource, type FrameSource, type ImageDecoder } from "./engine/source";
import { AviSource } from "./engine/avi";
import { RAW_EXT, rawPreview } from "./engine/raw";
import { decodeFits, FITS_EXT, fitsBaseName, isFits } from "./engine/fits";
import { decodeRawData, rawUnsupported, whiteBalanceFrom } from "./engine/rawdata";
import { MediaVideoSource } from "./video";
import { ZipWriter } from "./engine/zip";
import { calibratedSource, decodeMaster, encodeMaster, masterStats, MasterBuilder, type Calibration, type Master } from "./engine/calibrate";
import { FileSink, MemorySink, type ByteSink, type WritableFile } from "./engine/sink";
import { encodeFits, encodePng16, encodeTiff16, type ImageMeta } from "./engine/imagewrite";
import { captureDate, offsetMs, type TimelapseOptions } from "./engine/timelapse";
import { seriesTime, shiftMs, timeFromName, winjuposName } from "./engine/winjupos";
import { TimelapseRecorder, type NativeHevc } from "./timelapse-encode";
import { MontageRecorder } from "./montage-render";
import type { MontageOptions } from "./engine/montage";
import { msg, tr } from "./i18n";
import { frameToRGBA } from "./render";
import { processedFrame, renderDisplay, type DisplayOptions } from "./engine/display";

export type OutputFormat = "ser" | "png" | "png16" | "tiff" | "fits" | "none";
/** Formate mit Einzelbildern (+ Protokoll) */
export const IMAGE_FORMATS: readonly OutputFormat[] = ["png", "png16", "tiff", "fits"];

declare const __APP_VERSION__: string;
const SOFTWARE = `Astrotool ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : ""}`.trim();

/** Einzelbild im gewählten Format: Dateiendung und Inhalt */
async function encodeImage(f: Frame, format: OutputFormat, meta: ImageMeta): Promise<{ ext: string; bytes: Uint8Array }> {
  meta = { ...meta, software: SOFTWARE };
  if (format === "png16") return { ext: "png", bytes: await encodePng16(f, meta) };
  if (format === "tiff") return { ext: "tif", bytes: encodeTiff16(f, meta) };
  if (format === "fits") return { ext: "fits", bytes: encodeFits(f, meta) };
  return { ext: "png", bytes: await encodePng(f) };
}

export type ToWorker =
  | { type: "open"; files: File[]; bigEndian: boolean; rawMode?: "raw" | "preview"; join?: boolean; mainCamera?: boolean }
  | { type: "preview"; index: number; options: ProcessOptions }
  | { type: "process"; options: ProcessOptions; format: OutputFormat; folder?: FileSystemDirectoryHandle; target?: FileSystemFileHandle; timelapse: TimelapseOptions; montage?: MontageOptions; nativeHevc?: boolean }
  | { type: "native-reply"; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: "render"; index: number; seq: number; display: DisplayOptions }
  | { type: "export"; from: number; to: number; mode: "ser-raw" | "ser-processed" | "png"; display: DisplayOptions; folder?: FileSystemDirectoryHandle; target?: FileSystemFileHandle }
  | { type: "cancel" }
  /** Kalibrierbilder laden (leere Liste: entfernen) */
  | { type: "calibration"; kind: CalKind; files: File[]; rawMode?: "raw" | "preview" }
  /** welche Master angewendet werden (Vorschau, Betrachter, Verarbeitung) */
  | { type: "calibration-use"; dark: boolean; flat: boolean; scaleDark?: boolean }
  | { type: "save-master"; kind: CalKind };

export type CalKind = "dark" | "flat" | "flatDark";

export interface FileInfo {
  kind: "ser" | "images" | "video";
  name: string;
  width: number;
  height: number;
  frameCount: number;
  bitDepth: number;
  color: string;
  colorId: number;
  observer: string;
  instrument: string;
  telescope: string;
  hasTimestamps: boolean;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  fps: number | null;
  /** Aufnahmezeit (ms, UT) des ersten und letzten Bildes für WinJUPOS-Namen – auch aus Dateinamen; null = unbekannt */
  wjStart: number | null;
  wjEnd: number | null;
  /** Bildserie aus Kamera-RAW; rawFormat z. B. "CR2", "DNG lossless" oder "JPEG" (eingebettet) */
  raw: boolean;
  rawFormat: string;
  /** "CR3" / "RAF": komprimierte Sensordaten nicht lesbar – Kamerabild verwendet, Hinweis auf DNG */
  rawHint: string | null;
  /** Bildserie mit mainCamera: nicht verwendete Bilder anderer Kameras */
  skipped?: { name: string; camera: string }[];
}

export interface PreviewDetection {
  found: boolean;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  threshold: number;
  disc?: { cx: number; cy: number; r: number; visibleLimb: number; rms: number; kind: "sun" | "moon" };
  /** Oberflächen-Ausrichtung: Verschiebung gegenüber dem Referenzbild */
  surface?: { dx: number; dy: number; peak: number; angle?: number };
}

export type FromWorker =
  | { type: "opened"; info: FileInfo }
  | { type: "calibrated"; kind: CalKind; stats: ReturnType<typeof masterStats> | null; error?: string }
  | { type: "master-file"; kind: CalKind; bytes: Uint8Array }
  | {
      type: "preview";
      index: number;
      name: string;
      time: string | null;
      input: { width: number; height: number; rgba: Uint8ClampedArray };
      output: { width: number; height: number; rgba: Uint8ClampedArray };
      det: PreviewDetection;
      crop: { x0: number; y0: number; width: number; height: number };
      accepted: boolean;
      reason?: string;
      score: number;
    }
  | { type: "progress"; phase: "analyse" | "write" | "video"; done: number; total: number }
  | {
      type: "done";
      blob: Blob | null;
      fileName: string;
      savedToFolder: boolean;
      /** direkt auf die Platte geschrieben: Dateiname */
      savedToFile: string | null;
      written: number;
      rejected: { name: string; reason: string }[];
      scores: number[];
      outWidth: number;
      outHeight: number;
      seconds: number;
      discStats: { meanR: number; maxRms: number } | null;
      /** Totalität: Bilder am Mondrand, zusammengefasste Belichtungsreihen */
      totality: { frames: number; hdrGroups: number } | null;
      timelapse: { blob: Blob; fileName: string; codec: string; frames: number; seconds: number; fallback?: boolean; synthesized?: number; blended?: number } | null;
      timelapseError: string | null;
      montage: { blob: Blob; fileName: string; width: number; height: number; frames: number } | null;
      montageError: string | null;
      /** WinJUPOS-Namen gewünscht, aber keine Aufnahmezeit bekannt */
      winjuposMissing?: boolean;
    }
  | { type: "error"; message: string }
  | {
      type: "rendered";
      index: number;
      seq: number;
      name: string;
      time: string | null;
      width: number;
      height: number;
      rgba: Uint8ClampedArray;
      histogram: [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
      balance: [number, number, number];
      colour: boolean;
      ms: number;
    }
  /** blob nur im Speicher-Fall; savedTo: Datei- bzw. Ordnername auf der Platte */
  | { type: "exported"; blob: Blob | null; fileName: string; frames: number; savedTo: string | null }
  | { type: "native"; id: number; op: "hevc_begin" | "hevc_frame" | "hevc_finish"; args?: Record<string, unknown>; data?: Uint8ClampedArray; repeat?: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let source: FrameSource | null = null;
// Kalibrierung: geladene Master, ob sie gelten, und die damit kalibrierte Quelle (zwischengespeichert)
const masters: Partial<Record<CalKind, Master>> = {};
let calUse = { dark: false, flat: false, scaleDark: true };
let calSource: FrameSource | null = null;
/** aktuelle Quelle, mit Dark/Flat falls eingeschaltet */
function activeSource(): FrameSource {
  if (!source) throw new Error(msg("noFile"));
  if (!calSource) {
    const cal: Calibration = { dark: calUse.dark ? masters.dark : undefined, flat: calUse.flat ? masters.flat : undefined, flatDark: masters.flatDark, scaleDark: calUse.scaleDark };
    calSource = calibratedSource(source, cal);
  }
  return calSource;
}

export const VIDEO_EXT = /\.(ser|avi|mp4|m4v|mov|mkv|webm)$/i;

/** Eine SER-Datei oder ein Video öffnen */
async function openVideo(f: File, bigEndian: boolean): Promise<{ src: FrameSource; name: string }> {
  if (/\.ser$/i.test(f.name)) {
    const name = f.name.replace(/\.ser$/i, "");
    return { src: serSource(await SerReader.open(f, { bigEndian }), name), name };
  }
  const name = f.name.replace(/\.[^.]+$/, "");
  return { src: /\.avi$/i.test(f.name) ? await AviSource.open(f, f.name, decodeImage) : await MediaVideoSource.open(f, f.name), name };
}

/**
 * Dateien öffnen wie beim Laden der Aufnahme: eine SER/ein Video, eine Bildserie – oder (join) mehrere SER/Videos
 * als eine Serie (PIPP -join).
 */
async function openFiles(files: File[], rawMode: "raw" | "preview", bigEndian = false, join = false, mainCamera = false) {
  const dec = makeDecoder(rawMode);
  if (join && files.length > 1 && files.every((f) => VIDEO_EXT.test(f.name))) {
    const parts: { src: FrameSource; name: string }[] = [];
    try {
      for (const f of files) parts.push(await openVideo(f, bigEndian));
      const src = new JoinedSource(parts.map((p) => p.src));
      return { src, name: `${parts[0].name}-${parts[parts.length - 1].name}`, dec, partNames: files.map((f) => f.name) };
    } catch (e) {
      for (const p of parts) (p.src as { dispose?: () => void }).dispose?.();
      throw e;
    }
  }
  const ser = files.length === 1 && /\.ser$/i.test(files[0].name);
  const video = files.length === 1 && /\.(avi|mp4|m4v|mov|mkv|webm)$/i.test(files[0].name);
  let src: FrameSource, name: string;
  let cube: FitsCubeSource | null = null;
  if (video || ser) {
    ({ src, name } = await openVideo(files[0], bigEndian));
  } else if (files.length === 1 && FITS_EXT.test(files[0].name) && (cube = await FitsCubeSource.open(files[0], files[0].name))) {
    // FITS mit mehreren Bildern (Würfel, Erweiterungen): wie ein SER-Video
    src = cube;
    name = fitsBaseName(files[0].name);
    dec.state.format = "FITS";
  } else {
    const images = files.filter((f) => /\.(jpe?g|png|tiff?|webp|bmp)$/i.test(f.name) || RAW_EXT.test(f.name) || FITS_EXT.test(f.name));
    if (!images.length) throw new Error(msg("unsupportedFiles"));
    src = await ImageSequenceSource.open(images.map((f) => ({ file: f, name: f.name, raw: RAW_EXT.test(f.name) })), dec.decode, { mainCamera });
    name = `${src.frameName(0)}-${src.frameName(src.frameCount - 1)}`;
  }
  return { src, name, dec, partNames: null as string[] | null };
}

/** Master aus höchstens 256 Bildern – oder ein gespeicherter Master (eine FITS-Datei) */
async function buildMaster(files: File[], rawMode: "raw" | "preview"): Promise<Master> {
  if (files.length === 1 && FITS_EXT.test(files[0].name)) {
    const saved = decodeMaster(new Uint8Array(await files[0].arrayBuffer()));
    if (saved) return saved;
  }
  const { src } = await openFiles(files, rawMode);
  try {
    const b = new MasterBuilder();
    const n = Math.min(src.frameCount, 256);
    for (let i = 0; i < n; i++) {
      if (cancel) throw new Error(msg("cancelled"));
      b.add(await src.readFrame(i), src.exposure?.(i) ?? undefined);
      post({ type: "progress", phase: "analyse", done: i + 1, total: n });
    }
    return b.finish();
  } finally {
    (src as { dispose?: () => void }).dispose?.();
  }
}
let baseName = "ausgabe";
/** Aufnahmezeit je Bild (ms, UT) für WinJUPOS-Namen; null = unbekannt */
let frameTimes: Float64Array | null = null;

/**
 * Zeiten je Bild: Zeitstempel der Datei (Kamerauhr ohne Zeitzone als Ortszeit dieses Rechners), sonst Startzeit aus
 * dem SER-Kopf oder aus dem Dateinamen plus Bildnummer / Bildrate. Bildserien ohne EXIF: Zeit aus jedem Dateinamen.
 */
function computeFrameTimes(src: FrameSource, stamps: BigInt64Array | null, fileName: string, fps: number | null): Float64Array | null {
  const n = src.frameCount;
  if (stamps && stamps.length >= n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = captureDate(stamps[i], src.clock);
      if (!d) return null;
      out[i] = d.getTime();
    }
    return out;
  }
  if (src.kind === "images") {
    const names = (src as ImageSequenceSource).entries.map((e) => timeFromName(e.name));
    return names.every((t) => t !== null) ? Float64Array.from(names as number[]) : null;
  }
  const head = src.meta.startUtc ? captureDate(src.meta.startUtc, "utc")?.getTime() ?? null : null;
  const start = head ?? timeFromName(fileName);
  if (start === null) return null;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + (fps && fps > 0 ? (i * 1000) / fps : 0);
  return out;
}

/** Zusammengefügte Aufnahmen: Zeiten je Teil (jede Datei hat ihre eigene Startzeit), aneinandergehängt */
async function joinedFrameTimes(src: FrameSource, names: string[] | null): Promise<Float64Array | null> {
  if (!(src instanceof JoinedSource) || !names) return null;
  const out = new Float64Array(src.frameCount);
  let at = 0;
  for (let k = 0; k < src.parts.length; k++) {
    const p = src.parts[k];
    const t = computeFrameTimes(p, await p.readTimestamps(), names[k], p.fps ?? null);
    if (!t) return null;
    out.set(t, at);
    at += p.frameCount;
  }
  return out;
}

/** Erstes und letztes verarbeitetes Bild (Startbild, höchstens N Bilder) */
function processedRange(o: ProcessOptions, n: number): [number, number] {
  const a = Math.min(n - 1, Math.max(0, o.startFrame | 0));
  const b = o.maxFrames > 0 ? Math.min(n - 1, a + o.maxFrames - 1) : n - 1;
  return [a, b];
}
/** Ausgabe, die gerade direkt auf die Platte geschrieben wird – bei Fehler oder Abbruch verwerfen */
let activeSink: ByteSink | null = null;

/** Ziel für SER/ZIP: gewählte Datei (Schreiben während der Verarbeitung) oder Speicher */
async function openSink(target?: FileSystemFileHandle): Promise<ByteSink> {
  activeSink = target ? new FileSink((await target.createWritable()) as unknown as WritableFile) : new MemorySink();
  return activeSink;
}
let cancel = false;
let previewSeq = 0;
let lastTimestamps: BigInt64Array | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

// Aufrufe an die Windows-App laufen über das Hauptfenster (nur dort gibt es die Tauri-Schnittstelle).
let nativeSeq = 0;
const nativePending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function nativeCall<T>(op: "hevc_begin" | "hevc_frame" | "hevc_finish", extra: { args?: Record<string, unknown>; data?: Uint8ClampedArray; repeat?: number } = {}): Promise<T> {
  const id = ++nativeSeq;
  return new Promise<T>((resolve, reject) => {
    nativePending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "native", id, op, ...extra }, extra.data ? [extra.data.buffer] : []);
  });
}
const nativeHevc: NativeHevc = {
  begin: (width, height, fps, title, date) => nativeCall("hevc_begin", { args: { width, height, fps, title: title ?? null, date: date ?? null } }),
  frame: (rgba, repeat) => nativeCall("hevc_frame", { data: rgba, repeat }),
  finish: () => nativeCall("hevc_finish"),
};

/** Zähler der Öffnen-Aufträge: Nur das zuletzt angeforderte Öffnen gilt (schnelles Umschalten, neue Dateien). */
let openSeq = 0;

async function rawJpeg(blob: Blob) {
  const p = await rawPreview(blob);
  if (!p) throw new Error(msg("rawNoPreview"));
  return decodeImage(blob.slice(p.offset, p.offset + p.length, "image/jpeg"));
}

/**
 * Dekoder für eine Bildserie. RAW: Sensordaten (Bayer, 16 bit) oder eingebettetes JPEG, Weissabgleich einmal je
 * Serie. Jede Serie hat ihren eigenen Zustand – ein noch laufendes Öffnen stört das nächste nicht.
 */
function makeDecoder(mode: "raw" | "preview") {
  // hint: komprimiertes CR3/RAF ohne lesbare Sensordaten → Hinweis „in DNG umwandeln“
  const state: { wb: [number, number, number] | null | undefined; format: string; hint: string | null } = { wb: undefined, format: "", hint: null };
  const decode: ImageDecoder = async (blob, raw) => {
    if (!raw && (await isFits(blob))) {
      // FITS: lineare Sensordaten wie bei RAW (grau, Bayer oder Farbe, 8/16 bit)
      const frame = await decodeFits(blob);
      state.format = "FITS";
      return { width: frame.width, height: frame.height, frame };
    }
    if (!raw) return decodeImage(blob);
    if (mode === "raw") {
      if (state.wb === undefined) {
        // erstes Bild der Serie: Weissabgleich der Kamera oder aus dem Vergleich mit dem Kamerabild
        const first = await decodeRawData(blob);
        if (first?.info.cameraWb) state.wb = first.info.cameraWb;
        else if (first) {
          try { state.wb = whiteBalanceFrom(first.frame, (await rawJpeg(blob)) as { width: number; height: number; rgba: Uint8ClampedArray }); } catch { state.wb = null; }
        } else state.wb = null;
        if (first) state.format = first.info.format;
        else state.hint = await rawUnsupported(blob).catch(() => null);
      }
      const r = await decodeRawData(blob, state.wb ?? undefined);
      if (r) return { width: r.frame.width, height: r.frame.height, frame: r.frame };
    }
    state.format = state.format || "JPEG";
    return rawJpeg(blob);
  };
  return { decode, state };
}

const decodeImage: ImageDecoder = async (blob) => {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const img = g.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, rgba: img.data };
};

/** .NET-Ticks (100 ns seit 0001-01-01) → ISO-Datum */
function ticksToIso(t: bigint | undefined): string | null {
  if (t === undefined || t <= 0n) return null;
  const d = new Date(Number((t - 621_355_968_000_000_000n) / 10_000n));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Frame → PNG (8 bit). 16-bit-Daten werden auf 8 bit reduziert. */
async function encodePng(f: Frame): Promise<Uint8Array> {
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
  const c = new OffscreenCanvas(f.width, f.height);
  c.getContext("2d")!.putImageData(new ImageData(rgba, f.width, f.height), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function logCsv(src: FrameSource, frames: FrameResult[], stamps: BigInt64Array | null, hdrGroups: number[][]): string {
  const rows = ["frame;time_utc;accepted;reason;centre_x;centre_y;disc_radius;visible_limb;quality;limb;exposure_s;hdr_group;sun_x;sun_y;rotation_deg"];
  const groupNo = new Map<number, number>();
  hdrGroups.forEach((g, k) => g.forEach((i) => groupNo.set(i, k + 1)));
  for (const r of frames) {
    const exp = src.kind === "images" ? (src as ImageSequenceSource).entries[r.index].exif.exposureTime : undefined;
    const c = r.det.disc ?? r.det;
    rows.push([
      src.frameName(r.index),
      stamps ? ticksToIso(stamps[r.index]) ?? "" : "",
      r.accepted ? 1 : 0,
      tr("en", r.reason),
      c.cx.toFixed(2),
      c.cy.toFixed(2),
      r.det.disc ? r.det.disc.r.toFixed(2) : "",
      r.det.disc ? r.det.disc.visibleLimb.toFixed(3) : "",
      r.score.toPrecision(6),
      r.det.disc?.kind ?? "",
      exp ? String(exp) : "",
      groupNo.get(r.index) ?? "",
      r.det.disc?.sun ? r.det.disc.sun.cx.toFixed(2) : "",
      r.det.disc?.sun ? r.det.disc.sun.cy.toFixed(2) : "",
      r.det.surface?.angle !== undefined ? ((r.det.surface.angle * 180) / Math.PI).toFixed(3) : "",
    ].join(";"));
  }
  return rows.join("\r\n") + "\r\n";
}

async function writeToFolder(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array | string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === "native-reply") {
      const p = nativePending.get(m.id);
      nativePending.delete(m.id);
      if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error ?? "native call failed"));
      return;
    }
    if (m.type === "cancel") {
      cancel = true;
      return;
    }
    if (m.type === "save-master") {
      const master = masters[m.kind];
      if (!master) throw new Error(msg("calEmpty"));
      const bytes = encodeMaster(master, m.kind, SOFTWARE);
      post({ type: "master-file", kind: m.kind, bytes }, [bytes.buffer]);
      return;
    }
    if (m.type === "calibration-use") {
      calUse = { dark: m.dark, flat: m.flat, scaleDark: m.scaleDark ?? true };
      calSource = null;
      return;
    }
    if (m.type === "calibration") {
      cancel = false;
      calSource = null;
      if (!m.files.length) {
        delete masters[m.kind];
        post({ type: "calibrated", kind: m.kind, stats: null });
        return;
      }
      try {
        const master = await buildMaster(m.files, m.rawMode ?? "raw");
        masters[m.kind] = master;
        post({ type: "calibrated", kind: m.kind, stats: masterStats(master) });
      } catch (e) {
        delete masters[m.kind];
        post({ type: "calibrated", kind: m.kind, stats: null, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (m.type === "open") {
      const seq = ++openSeq;
      const { src: next, name: nextName, dec, partNames } = await openFiles(m.files, m.rawMode ?? "raw", m.bigEndian, m.join, m.mainCamera);
      // inzwischen wurde etwas anderes geöffnet: dieses Ergebnis verwerfen
      if (seq !== openSeq) { (next as { dispose?: () => void }).dispose?.(); return; }
      (source as { dispose?: () => void } | null)?.dispose?.();
      source = next;
      calSource = null;
      baseName = nextName;
      const ts = (lastTimestamps = await source.readTimestamps());
      let fps: number | null = source.fps ?? null;
      if (source.kind === "ser" && ts && ts.length > 1 && ts[ts.length - 1] > ts[0]) {
        fps = ((ts.length - 1) * 1e7) / Number(ts[ts.length - 1] - ts[0]);
      }
      frameTimes = await joinedFrameTimes(source, partNames) ?? computeFrameTimes(source, ts, m.files.length === 1 ? m.files[0].name : nextName, fps);
      post({
        type: "opened",
        info: {
          kind: source.kind,
          name: baseName,
          width: source.width, height: source.height, frameCount: source.frameCount, bitDepth: source.bitDepth,
          color: colorName(source.colorId), colorId: source.colorId,
          observer: source.meta.observer ?? "", instrument: source.meta.instrument ?? "", telescope: source.meta.telescope ?? "",
          hasTimestamps: !!ts, firstTimestamp: ts ? ticksToIso(ts[0]) : null, lastTimestamp: ts ? ticksToIso(ts[ts.length - 1]) : null, fps,
          wjStart: frameTimes ? frameTimes[0] : null, wjEnd: frameTimes ? frameTimes[frameTimes.length - 1] : null,
          raw: !!dec.state.format && dec.state.format !== "FITS", rawFormat: dec.state.format, rawHint: dec.state.hint,
          skipped: source instanceof ImageSequenceSource ? source.skipped : undefined,
        },
      });
      return;
    }
    if (!source) throw new Error(msg("noFile"));
    if (m.type === "render") {
      // Betrachter: ein Bild mit Anzeige-Einstellungen
      const t0 = performance.now();
      const r = renderDisplay(await activeSource().readFrame(m.index), m.display);
      post(
        {
          type: "rendered", index: m.index, seq: m.seq, name: source.frameName(m.index),
          time: lastTimestamps ? ticksToIso(lastTimestamps[m.index]) : null,
          width: r.width, height: r.height, rgba: r.rgba, histogram: r.histogram, balance: r.balance, colour: r.colour,
          ms: performance.now() - t0,
        },
        [r.rgba.buffer, ...r.histogram.map((h) => h.buffer)],
      );
      return;
    }
    if (m.type === "export") {
      // Bereich zwischen den Markern speichern – roh (verlustfrei) oder wie angezeigt
      cancel = false;
      const src = source;
      const from = Math.max(0, Math.min(m.from, m.to)), to = Math.min(src.frameCount - 1, Math.max(m.from, m.to));
      const stamps = await src.readTimestamps();
      const total = to - from + 1;
      const base = `${baseName}_${from + 1}-${to + 1}`;
      // auf die Platte: PNG einzeln in einen Ordner, SER in eine Datei – während des Speicherns geschrieben
      if (m.mode === "png") {
        const zip = m.folder ? null : new ZipWriter(await openSink(m.target));
        for (let i = from; i <= to; i++) {
          if (cancel) throw new Error(msg("cancelled"));
          const name = `${src.frameName(i)}.png`, bytes = await encodePng(processedFrame(await src.readFrame(i), m.display));
          if (m.folder) await writeToFolder(m.folder, name, bytes);
          else {
            zip!.add(name, bytes);
            await zip!.sink.drain();
          }
          post({ type: "progress", phase: "write", done: i - from + 1, total });
        }
        const blob = zip ? await zip.finish() : null;
        activeSink = null;
        post({ type: "exported", blob, fileName: `${base}.zip`, frames: total, savedTo: m.folder?.name ?? m.target?.name ?? null });
        return;
      }
      let writer: SerWriter | null = null;
      for (let i = from; i <= to; i++) {
        if (cancel) throw new Error(msg("cancelled"));
        const raw = await src.readFrame(i);
        const f = m.mode === "ser-processed" ? processedFrame(raw, m.display) : raw;
        writer ??= new SerWriter({
          luId: 0, colorId: f.colorId, littleEndianFlag: 0, width: f.width, height: f.height, bitDepth: f.bitDepth,
          observer: src.meta.observer ?? "", instrument: src.meta.instrument ?? "", telescope: src.meta.telescope ?? "",
          dateTime: stamps?.[from] ?? 0n, dateTimeUtc: stamps?.[from] ?? 0n,
        }, await openSink(m.target));
        writer.add(f, stamps ? stamps[i] : undefined);
        await writer.sink.drain();
        post({ type: "progress", phase: "write", done: i - from + 1, total });
      }
      const blob = await writer!.finish();
      activeSink = null;
      post({ type: "exported", blob, fileName: `${base}.ser`, frames: total, savedTo: m.target?.name ?? null });
      return;
    }
    if (m.type === "preview") {
      const seq = ++previewSeq;
      const a = await analyseFrame(activeSource(), m.index, m.options);
      if (seq !== previewSeq) return; // veraltete Anfrage
      const input = frameToRGBA(a.frame);
      const output = frameToRGBA(a.output);
      post(
        {
          type: "preview",
          index: m.index,
          name: source.frameName(m.index),
          time: lastTimestamps ? ticksToIso(lastTimestamps[m.index]) : null,
          input: { width: a.frame.width, height: a.frame.height, rgba: input },
          output: { width: a.output.width, height: a.output.height, rgba: output },
          det: a.det,
          crop: a.crop,
          accepted: a.result.accepted,
          reason: a.result.reason,
          score: a.result.score,
        },
        [input.buffer, output.buffer],
      );
      return;
    }
    if (m.type === "process") {
      cancel = false;
      const src = activeSource();
      const t0 = performance.now();
      // Ausschnitt vor und nach der Bearbeitung (Drehen, Grösse)
      const [cw, ch] = m.options.cropEnabled ? [m.options.cropWidth, m.options.cropHeight] : [src.width, src.height];
      const [ow, oh] = outputSize(src, m.options);
      const scale = transformedSize(m.options, 100, 100)[0] / 100; // nur für den Scheibendurchmesser der Montage
      const stamps = await src.readTimestamps();
      let blob: Blob | null = null;
      let fileName: string;
      let report;
      // WinJUPOS: Name aus der Aufnahmezeit (UT); ohne Zeit bleiben die üblichen Namen
      const wj = m.options.winjupos && frameTimes && frameTimes.length === src.frameCount ? frameTimes : null;
      const wjShift = shiftMs(m.options);
      const [wjA, wjB] = processedRange(m.options, src.frameCount);
      const wjSeries = wj ? winjuposName(seriesTime(wj[wjA], wj[wjB], m.options.wjTime) + wjShift, m.options) : null;
      const progress = (phase: "analyse" | "write" | "video", done: number, total: number) => post({ type: "progress", phase, done, total });
      const recorder = m.timelapse.enabled ? new TimelapseRecorder() : null;
      // zeittreuer Film: Lage von Sonne und Mond je Bild (nur ohne Drehen/Spiegeln/Grösse – sonst nur Überblenden)
      const metaOf = (r: FrameResult) => (m.timelapse.timing === "real" && !hasTransform(m.options) ? movieMeta(r) : undefined);
      const montage = m.montage?.enabled ? new MontageRecorder() : null;
      if (m.format === "none" && !recorder && !montage) throw new Error(msg("noOutput"));
      const addMontage = (f: Frame, r: FrameResult, ts: bigint | undefined) =>
        montage?.add(f, ts, { totality: r.det.disc?.kind === "moon", hdr: !!r.hdrGroup, discDiameter: r.det.disc ? 2 * r.det.disc.r * scale : undefined });

      // Farbe: PNG und Zeitraffer immer farbig (falls Bayer), SER nur auf Wunsch
      const col = (f: Frame) => colouriseOutput(f, m.options);
      if (m.format === "ser") {
        const serColor = outputColorId(m.options, src, cw, ch);
        const writer = new SerWriter({
          luId: 0, colorId: serColor, littleEndianFlag: 0, width: ow, height: oh, bitDepth: src.bitDepth,
          observer: src.meta.observer ?? "", instrument: src.meta.instrument ?? "", telescope: src.meta.telescope ?? "",
          dateTime: stamps?.[0] ?? 0n, dateTimeUtc: stamps?.[0] ?? 0n,
        }, await openSink(m.target));
        report = await processSource(src, m.options, async (f, r, _k, ts) => {
          const c = recorder || montage || serColor !== f.colorId ? col(f) : f;
          writer.add(serColor !== f.colorId ? c : f, ts);
          await writer.sink.drain();
          await recorder?.add(c, ts, metaOf(r));
          await addMontage(c, r, ts);
        }, progress, () => cancel);
        blob = await writer.finish();
        activeSink = null;
        fileName = wjSeries ? `${wjSeries}.ser` : `${baseName}_astro.ser`;
      } else if (m.format === "none") {
        report = await processSource(src, m.options, async (f, r, _k, ts) => {
          const c = col(f);
          await recorder?.add(c, ts, metaOf(r));
          await addMontage(c, r, ts);
        }, progress, () => cancel);
        fileName = "";
      } else {
        const zip = m.folder ? null : new ZipWriter(await openSink(m.target));
        const digits = String(src.frameCount).length;
        report = await processSource(
          src,
          m.options,
          async (raw, r, k, ts) => {
            const f = col(raw);
            await recorder?.add(f, ts, metaOf(r));
            await addMontage(f, r, ts);
            const prefix = m.options.qualityEnabled && m.options.reorder ? `${String(k + 1).padStart(digits, "0")}_` : "";
            const iso = ticksToIso(ts);
            // HDR-Bild: Belichtungszeit der Reihe ist keine einzelne Zahl mehr
            const { ext, bytes } = await encodeImage(f, m.format, { date: iso ? new Date(iso) : undefined, exposure: r.hdrGroup ? undefined : src.exposure?.(r.index) });
            // WinJUPOS: Zeit muss vorne stehen – Nummer (Rang oder Bild) dahinter
            const num = m.options.qualityEnabled && m.options.reorder ? k + 1 : r.index + 1;
            const name = wj
              ? `${winjuposName(wj[r.index] + wjShift, m.options)}_${String(num).padStart(digits, "0")}${r.hdrGroup ? "_hdr" : ""}.${ext}`
              : r.hdrGroup
                ? `${prefix}${src.frameName(r.hdrGroup[0])}-${src.frameName(r.hdrGroup[r.hdrGroup.length - 1])}_hdr_astro.${ext}`
                : `${prefix}${src.frameName(r.index)}_astro.${ext}`;
            if (m.folder) await writeToFolder(m.folder, name, bytes);
            else {
              zip!.add(name, bytes);
              await zip!.sink.drain();
            }
          },
          progress,
          () => cancel,
        );
        const csv = logCsv(src, report.frames, stamps, report.hdrGroups);
        if (m.folder) await writeToFolder(m.folder, "astrotool_log.csv", csv);
        else zip!.add("astrotool_log.csv", new TextEncoder().encode(csv));
        blob = zip ? await zip.finish() : null;
        activeSink = null;
        fileName = wjSeries ? `${wjSeries}.zip` : `${baseName}_astro.zip`;
      }

      let timelapse = null, timelapseError: string | null = null;
      if (recorder && recorder.count) {
        try {
          const recorded = captureDate(recorder.firstStamp(), src.clock);
          timelapse = await recorder.render({ ...m.timelapse, clockShiftMs: clockShift(src) }, baseName, (d, t) => progress("video", d, t), recorded, m.nativeHevc ? nativeHevc : undefined);
        } catch (e) {
          timelapseError = e instanceof Error ? e.message : String(e);
        }
      }
      let montageResult = null, montageError: string | null = null;
      if (montage && montage.count) {
        try {
          montageResult = await montage.render({ ...m.montage!, title: m.montage!.title || m.timelapse.title }, baseName, clockShift(src));
        } catch (e) {
          montageError = e instanceof Error ? e.message : String(e);
        }
      }
      const scoreOf = new Map(report.frames.map((f) => [f.index, f.score]));
      const discs = report.frames.filter((f) => f.accepted && f.det.disc && f.det.disc.kind === "sun").map((f) => f.det.disc!);
      post({
        type: "done",
        blob,
        fileName,
        savedToFolder: !!m.folder && IMAGE_FORMATS.includes(m.format),
        savedToFile: m.target && m.format !== "none" && !m.folder ? m.target.name : null,
        written: report.written.length,
        rejected: report.frames.filter((f) => !f.accepted).map((f) => ({ name: src.frameName(f.index), reason: f.reason ?? "" })),
        scores: report.written.map((i) => scoreOf.get(i) ?? 0),
        outWidth: report.outWidth,
        outHeight: report.outHeight,
        seconds: (performance.now() - t0) / 1000,
        discStats: discs.length
          ? { meanR: discs.reduce((s, d) => s + d.r, 0) / discs.length, maxRms: Math.max(...discs.map((d) => d.rms)) }
          : null,
        totality: report.frames.some((f) => f.det.disc?.kind === "moon")
          ? { frames: report.frames.filter((f) => f.accepted && f.det.disc?.kind === "moon").length, hdrGroups: report.hdrGroups.length }
          : null,
        timelapse,
        timelapseError,
        montage: montageResult,
        montageError,
        winjuposMissing: !!m.options.winjupos && m.format !== "none" && !wj,
      });
    }
  } catch (e) {
    // halb geschriebene Datei verwerfen (Abbruch, Fehler, Platte voll)
    const sink = activeSink;
    activeSink = null;
    await sink?.abort().catch(() => {});
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

/** Bildserie mit Zeitzone in EXIF (Handys): Zeitstempel sind UT – eingeblendet wird die Ortszeit der Aufnahme */
function clockShift(src: FrameSource): number {
  return src instanceof ImageSequenceSource && src.clock === "utc" ? offsetMs(src.entries[0]?.exif.offsetTimeOriginal) : 0;
}
