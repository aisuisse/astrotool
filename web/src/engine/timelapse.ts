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
  /**
   * "frames": jedes Bild gleich lange (fps). "real": zeittreu – die Aufnahmezeit läuft gleichmässig, auch wenn
   * unregelmässig fotografiert wurde; fehlende Zeit wird mit Zwischenbildern gefüllt (Finsternis: Mond an der
   * richtigen Stelle), die Totalität läuft langsamer. Braucht Aufnahmezeiten.
   */
  timing: "frames" | "real";
  /** "real": Länge des Films in Sekunden (ohne Halten am Anfang und Ende) */
  seconds: number;
  /**
   * "real": Bei wenigen Fotos kürzer – so viele Sekunden je Foto, mindestens 8 s, höchstens `seconds`
   * (vier Fotos ergeben sonst 24 s Überblendung).
   */
  secondsPerPhoto?: number;
  /** Auf die Breite vergrössern, wenn die Bilder kleiner sind (für Handys: Full HD statt kleinem Ausschnitt) */
  upscale: boolean;
  /**
   * Eingeblendete Uhrzeit verschieben (ms): Handys speichern die Zeitzone mit, die Zeitstempel sind dann UT –
   * angezeigt wird die Ortszeit der Aufnahme. Setzt der Worker.
   */
  clockShiftMs?: number;
  /**
   * Format des Films: "source" wie die Bilder, "portrait" 9:16 (Status, Reels, Shorts), "landscape" 16:9
   * (YouTube, Fernseher). Das Bild wird eingepasst, der Rest bleibt schwarz; Titel und Uhrzeit stehen dann
   * über und unter dem Bild.
   */
  shape?: "source" | "portrait" | "landscape";
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
  timing: "frames",
  seconds: 24,
  upscale: false,
};

/** Länge des zeittreuen Films in Sekunden (ohne Halten) für eine Zahl von Fotos */
export function movieSeconds(photos: number, o: Pick<TimelapseOptions, "seconds" | "secondsPerPhoto">): number {
  return o.secondsPerPhoto ? Math.min(o.seconds, Math.max(8, photos * o.secondsPerPhoto)) : o.seconds;
}

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
export function outputSize(w: number, h: number, o: Pick<TimelapseOptions, "width" | "format"> & { upscale?: boolean }): [number, number] {
  let tw = o.width > 0 && (o.width < w || o.upscale) ? o.width : w;
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

/**
 * Grösse des Films und Lage des Bildes darin. Ohne Rahmenformat füllt das Bild den Film; mit "portrait" (9:16)
 * oder "landscape" (16:9) wird es mittig eingepasst.
 */
export function filmLayout(w: number, h: number, o: Pick<TimelapseOptions, "width" | "format" | "shape"> & { upscale?: boolean }): { W: number; H: number; x: number; y: number; w: number; h: number } {
  const [iw, ih] = outputSize(w, h, o);
  const shape = o.shape ?? "source";
  if (shape === "source") return { W: iw, H: ih, x: 0, y: 0, w: iw, h: ih };
  const ratio = shape === "portrait" ? 9 / 16 : 16 / 9;
  // Film so gross, dass das Bild gerade hineinpasst
  let W = Math.max(iw, Math.round(ih * ratio)), H = Math.round(W / ratio);
  let s = 1;
  if (isMp4(o.format) && Math.max(W, H) > MP4_MAX_LONG_SIDE) s = MP4_MAX_LONG_SIDE / Math.max(W, H);
  W = Math.round(W * s);
  H = Math.round(H * s);
  if (o.format !== "gif") {
    W -= W % 2;
    H -= H % 2;
  }
  const dw = Math.min(W, Math.round(iw * s)), dh = Math.min(H, Math.round(ih * s));
  return { W, H, x: Math.floor((W - dw) / 2), y: Math.floor((H - dh) / 2), w: dw, h: dh };
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
export function ticksToClock(t: bigint | undefined, shiftMs = 0): string {
  if (t === undefined || t <= 0n) return "";
  const d = new Date(Number((t - 621_355_968_000_000_000n) / 10_000n) + shiftMs);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 19);
}

/** Zeitzonen-Versatz aus EXIF ("+02:00", "-05:30") in Millisekunden – 0, wenn keiner angegeben ist */
export function offsetMs(offset: string | undefined): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset?.trim() ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}
