// Zeitraffer-Planung (ohne DOM): Bildfolge, Dauer, Ausgabegrösse, Zeit-Beschriftung.
// Entspricht den PIPP-Animationsoptionen (-anim_fwd, -anim_rev, -anim_fwd_lf_rep=, -fps_rate=),
// ergänzt um eingeblendete Aufnahmezeit, Titel und teilbare Videoformate.

/**
 * "mp4-hevc": H.265/HEVC in MP4 – beste Qualität bei kleiner Datei (Google Fotos, WhatsApp, iPhone).
 * "mp4-h264": H.264 in MP4 – grösste Verträglichkeit, auch mit alten Geräten.
 * "webm": VP9 – für Webseiten.
 * "gif": animiertes GIF.
 */
export type TimelapseFormat = "mp4-hevc" | "mp4-h264" | "webm" | "gif";

export interface TimelapseOptions {
  enabled: boolean;
  format: TimelapseFormat;
  /** Bilder pro Sekunde (wie lange jedes Aufnahmebild zu sehen ist) */
  fps: number;
  /** Letztes Bild so lange stehen lassen (Sekunden) */
  holdLastSeconds: number;
  /** Nach dem Ende rückwärts zurück zum Anfang (Hin und zurück) */
  pingPong: boolean;
  /** Breite des Zeitraffers in Pixel, 0 = wie Ausgabe (bei MP4 höchstens 1920) */
  width: number;
  /** Aufnahmezeit einblenden */
  showTime: boolean;
  /** Zusätzlicher Text, z. B. "Partial solar eclipse 12 Aug 2026" */
  title: string;
}

export const defaultTimelapse: TimelapseOptions = {
  enabled: false,
  format: "mp4-hevc",
  fps: 10,
  holdLastSeconds: 2,
  pingPong: false,
  width: 0,
  showTime: true,
  title: "",
};

/** MP4 für WhatsApp/Google Fotos: höchstens Full HD auf der langen Seite. */
export const MP4_MAX_LONG_SIDE = 1920;

export const isMp4 = (f: TimelapseFormat) => f === "mp4-hevc" || f === "mp4-h264";

/** Reihenfolge der Bilder im Zeitraffer (Indizes in die verarbeiteten Bilder). */
export function buildSequence(count: number, o: Pick<TimelapseOptions, "fps" | "holdLastSeconds" | "pingPong">): number[] {
  if (count <= 0) return [];
  const seq = Array.from({ length: count }, (_, i) => i);
  const hold = Math.max(0, Math.round(o.holdLastSeconds * o.fps));
  for (let i = 0; i < hold; i++) seq.push(count - 1);
  if (o.pingPong && count > 2) {
    for (let i = count - 2; i >= 1; i--) seq.push(i);
  }
  return seq;
}

/** Ausgabegrösse: Seitenverhältnis bleibt, Videoformate brauchen gerade Kantenlängen. */
export function outputSize(w: number, h: number, o: Pick<TimelapseOptions, "width" | "format">): [number, number] {
  let tw = o.width > 0 && o.width < w ? o.width : w;
  if (isMp4(o.format) && Math.max(tw, (h * tw) / w) > MP4_MAX_LONG_SIDE) {
    tw = w >= h ? MP4_MAX_LONG_SIDE : Math.floor((MP4_MAX_LONG_SIDE * w) / h);
  }
  let th = Math.round((h * tw) / w);
  if (o.format !== "gif") {
    tw -= tw % 2;
    th -= th % 2;
  }
  return [Math.max(2, tw), Math.max(2, th)];
}

/** Bildrate der MP4-Datei: konstant 30 (oder 60 bei sehr schnellen Zeitraffern) – das erwarten Handys und Plattformen. */
export const videoFrameRate = (fps: number) => (fps > 30 ? 60 : 30);

/**
 * Bei konstanter Bildrate: wie viele Videobilder bekommt jedes Aufnahmebild?
 * Rundet fortlaufend, damit sich keine Zeitabweichung aufsummiert.
 */
export function constantRateCounts(runLengths: number[], fps: number, outFps: number): number[] {
  const out: number[] = [];
  let t = 0;
  for (const n of runLengths) {
    const start = Math.round((t * outFps) / fps);
    t += n;
    out.push(Math.round((t * outFps) / fps) - start);
  }
  return out;
}

/**
 * Aufnahmezeitpunkt als echtes Datum (UTC) für die Video-Metadaten.
 * Bei Kamerazeit ohne Zeitzone ("local") wird die Zeitzone dieses Rechners angenommen –
 * Kamera und Rechner stehen in der Regel auf derselben Ortszeit (inkl. Sommerzeit).
 */
export function captureDate(t: bigint | undefined, clock: "utc" | "local"): Date | undefined {
  if (t === undefined || t <= 0n) return undefined;
  const ms = Number((t - 621_355_968_000_000_000n) / 10_000n);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return undefined;
  if (clock === "utc") return d;
  // Wanduhrzeit der Kamera als Ortszeit dieses Rechners deuten
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** 100-ns-Ticks seit 0001-01-01 → "HH:MM:SS". Bei Bildserien ist das die Kamerazeit, bei SER UTC. */
export function ticksToClock(t: bigint | undefined): string {
  if (t === undefined || t <= 0n) return "";
  const d = new Date(Number((t - 621_355_968_000_000_000n) / 10_000n));
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 19);
}
