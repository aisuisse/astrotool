// Verarbeitungsablauf: erkennen → prüfen → bewerten → sortieren → zuschneiden → ausgeben.
// Zwei Durchläufe, damit auch sehr lange Videos nicht komplett im Speicher liegen müssen.
import { cropFrame, cropLum, cropOrigin, detectObject, toLum, type Detection, type Lum } from "./image";
import { fitSunDisc, percentile, sample, type DiscFit } from "./limb";
import { bracketGroups, fitMoonDisc, fitMoonInPartial, mergeHdr, type BracketFrame } from "./totality";
import { quality, type QualityOptions, defaultQuality } from "./quality";
import { SerColor, SerReader, SerWriter, type Frame } from "./ser";
import { debayer, patternFromColorId, type BayerPattern } from "./debayer";
import { serSource, type FrameSource } from "./source";
import { SurfaceTracker, type SurfaceBox, type SurfaceMotion } from "./surface";
import { bayerAfterTransform, hasTransform, rotatedCrop, transformFrame, transformedSize, type TransformOptions } from "./transform";
import type { WinJuposOptions } from "./winjupos";
import { isBayer } from "./ser";
import { msg } from "../i18n";

/** Optionen; in Klammern der entsprechende Schalter von pipp_core.exe. Bearbeitung (Graustufen, Spiegeln, Drehen,
 * Grösse) siehe TransformOptions. */
export interface ProcessOptions extends TransformOptions, WinJuposOptions {
  startFrame: number; // (-sf=)
  maxFrames: number; // 0 = alle (-f=)
  checkObject: boolean; // (-chk)
  minObjectSize: number; // (-ms=)
  /** Schwelle 0..1, null = automatisch (-mp=) */
  threshold: number | null;
  rejectEdgeTouching: boolean;
  /**
   * Überbelichtete Bilder verwerfen: mehr als overexposedLimit % der Objektfläche (bei „Oberfläche“: des Bildes)
   * an der Sättigungsgrenze. Bilder der Totalität sind ausgenommen (dort ist die innere Korona gewollt gesättigt).
   */
  rejectOverexposed: boolean; // (-oe=)
  overexposedLimit: number;
  centre: boolean; // (-ctr)
  /**
   * "object": Schwerpunkt der hellen Fläche (wie PIPP).
   * "disc": Kreis an den Sonnen-/Mondrand – richtig auch bei Finsternis-Sicheln und Mondphasen (neu).
   * "surface": Oberfläche ohne ganzen Rand (Mond-/Sonnen-Nahaufnahmen) – jedes Bild wird über die Struktur am
   * ersten Bild des Bereichs ausgerichtet (Bildstabilisierung, wie „Surface Feature“ bei PIPP).
   */
  centreMode: "object" | "disc" | "surface";
  /**
   * Ankerbox für "surface" (freiwillig): nur dieser Bereich des Referenzbildes zählt für die Ausrichtung
   * (eine markante Stelle, z. B. ein Krater). null = ganzes Bild. Wie „Anchor“ bei PIPP.
   */
  surfaceAnchor: SurfaceBox | null;
  /** "surface": Referenz bei langen Serien nachführen (Struktur ändert sich langsam) */
  surfaceFollow: boolean;
  /** "surface": Bilddrehung messen und ausgleichen (Feldrotation). Farbkameras werden dann farbig gespeichert. */
  surfaceRotation: boolean;
  cropEnabled: boolean;
  cropWidth: number; // (-cx=)
  cropHeight: number; // (-cy=)
  offsetX: number; // (-ox=)
  offsetY: number; // (-oy=)
  qualityEnabled: boolean; // (-q)
  quality: QualityOptions; // (-qmin= -qmax= -qinc= -qold -qhisto -qtotal)
  /** "count": beste N Frames, "percent": beste N % (-q= / -qpcnt=) */
  keepMode: "all" | "count" | "percent";
  keepValue: number;
  reorder: boolean; // false entspricht -nr
  /**
   * Farbe aus Rohdaten einer Farbkamera (-db / -db=): "auto" = Muster aus dem SER-Kopf,
   * "off" = Rohdaten bleiben grau, sonst festes Muster (für Dateien ohne Angabe im Kopf).
   * PNG-Bilder und Zeitraffer werden damit farbig.
   */
  debayer: "auto" | "off" | BayerPattern;
  /** Auch das SER-Video farbig speichern. Aus = Bayer-Rohdaten bleiben erhalten (besser für AutoStakkert! & Co.). */
  debayerSer: boolean;
  /**
   * Totalität: Belichtungsreihen (verschiedene Belichtungszeiten laut EXIF, kurz nacheinander) am Mondrand
   * ausrichten und zu einem HDR-Bild zusammenfassen. Nur bei Mittelpunkt "disc" und Bildserien mit EXIF.
   */
  hdr: boolean;
  /**
   * Totalität: auf die Sonnenmitte zentrieren statt auf den Mond. Die Sonne ist verdeckt; ihre Lage folgt aus dem
   * Abstand Sonne–Mond in den partiellen Phasen davor und danach. So springt das Bild am 2./3. Kontakt nicht.
   */
  totalitySunCentre: boolean;
}

export const defaultOptions: ProcessOptions = {
  startFrame: 0,
  maxFrames: 0,
  checkObject: true,
  minObjectSize: 20,
  threshold: null,
  rejectEdgeTouching: false,
  rejectOverexposed: false,
  overexposedLimit: 1,
  centre: true,
  centreMode: "object",
  surfaceAnchor: null,
  surfaceFollow: true,
  surfaceRotation: false,
  cropEnabled: true,
  cropWidth: 448,
  cropHeight: 448,
  offsetX: 0,
  offsetY: 0,
  qualityEnabled: true,
  quality: defaultQuality,
  keepMode: "all",
  keepValue: 100,
  reorder: true,
  debayer: "auto",
  debayerSer: false,
  hdr: false,
  totalitySunCentre: true,
  mono: false,
  flipH: false,
  flipV: false,
  rotate: 0,
  resizePercent: 100,
  resizeMode: "percent",
  resizeWidth: 0,
  resizeHeight: 0,
  gain: 1,
  stretch: false,
  stretchTarget: 100,
  stretchBlack: false,
  stretchPerChannel: false,
  gamma: 1,
  winjupos: false,
  wjObserver: "",
  wjInfo: "",
  wjTime: "mid",
  wjShiftMinutes: 0,
};

/** Bayer-Muster, das für eine Quelle gilt – oder null (Mono, schon farbig, oder abgeschaltet). */
export function bayerPatternFor(o: Pick<ProcessOptions, "debayer">, src: { colorId: number; planes?: number }): BayerPattern | null {
  if (o.debayer === "off") return null;
  if (src.colorId === SerColor.RGB || src.colorId === SerColor.BGR || (src.planes ?? 1) !== 1) return null;
  return o.debayer === "auto" ? patternFromColorId(src.colorId) : o.debayer;
}

/** Zugeschnittenes Roh-Frame farbig machen (falls ein Bayer-Muster gilt). */
export function colourise(f: Frame, o: Pick<ProcessOptions, "debayer">): Frame {
  const p = bayerPatternFor(o, f);
  return p ? debayer(f, p) : f;
}

/** Bearbeitung des fertigen Ausschnitts (Graustufen, Spiegeln, Drehen, Grösse). Bayer-Rohdaten bleiben roh, wenn
 * das geht (nur Spiegeln/Drehen, Muster aus der Datei) – sonst werden sie vorher farbig gemacht. */
export function finishFrame(f: Frame, o: ProcessOptions): Frame {
  if (!hasTransform(o)) return f;
  return transformFrame(f, o, bayerPatternFor(o, f), o.debayer === "auto");
}

/**
 * Ausgabe-Frame farbig machen (PNG, Zeitraffer, Montage). Nach einer Bearbeitung ist ein Rohbild nur noch roh,
 * wenn sein Muster in der Farbkennung steht – ein festes Muster aus den Optionen gilt dann nicht mehr.
 */
export function colouriseOutput(f: Frame, o: ProcessOptions): Frame {
  if (!hasTransform(o)) return colourise(f, o);
  const p = o.debayer === "off" || f.planes !== 1 ? null : patternFromColorId(f.colorId);
  return p ? debayer(f, p) : f;
}

/** Farbkennung des SER-Ausgabevideos. width/height: Grösse des Ausschnitts vor der Bearbeitung. */
export function outputColorId(o: ProcessOptions, src: { colorId: number; planes?: number }, width = 2, height = 2): number {
  const pattern = bayerPatternFor(o, src);
  // Drehung ausgleichen: Bilder werden vorher farbig gemacht
  if (pattern && rotates(o)) return o.mono ? SerColor.MONO : SerColor.RGB;
  if (!hasTransform(o)) return o.debayerSer && pattern ? SerColor.RGB : src.colorId;
  if (pattern) {
    const kept = o.debayer === "auto" ? bayerAfterTransform(o, src.colorId, width, height) : null;
    if (kept !== null) return o.debayerSer ? SerColor.RGB : kept;
    return o.mono ? SerColor.MONO : SerColor.RGB;
  }
  if (isBayer(src.colorId)) return bayerAfterTransform(o, src.colorId, width, height) ?? SerColor.MONO; // Debayer aus
  return o.mono ? SerColor.MONO : src.colorId;
}

/** Oberfläche mit Ausgleich der Bilddrehung */
function rotates(o: Pick<ProcessOptions, "centreMode" | "surfaceRotation">): boolean {
  return o.centreMode === "surface" && o.surfaceRotation;
}

/** Grösse der gespeicherten Bilder (nach Zuschnitt und Bearbeitung). */
export function outputSize(src: { width: number; height: number }, o: ProcessOptions): [number, number] {
  const [w, h] = o.cropEnabled ? [o.cropWidth, o.cropHeight] : [src.width, src.height];
  return transformedSize(o, w, h);
}

/** Erkennung, erweitert um den angepassten Kreis (nur bei centreMode "disc"). */
export interface FrameDetection extends Detection {
  /** kind: "sun" = Sonnenrand (partielle Phase), "moon" = Mondrand in der Korona (Totalität) */
  disc?: {
    cx: number; cy: number; r: number; visibleLimb: number; rms: number; kind: "sun" | "moon";
    /** partielle Phase: Lage des Mondes vor der Sonne (innere Kante der Sichel) */
    moon?: { cx: number; cy: number; r: number };
    /** Totalität: geschätzte Sonnenmitte (aus dem Abstand Sonne–Mond der partiellen Phasen) */
    sun?: { cx: number; cy: number };
  };
  /** Oberfläche: Verschiebung (und Drehung) gegenüber dem Referenzbild und Sicherheit (0…1) */
  surface?: SurfaceMotion;
}

/** Mindest-Übereinstimmung mit dem Referenzbild (fremde Bilder: um 0.1, gleiche Stelle: 0.5–1) */
export const SURFACE_MIN_PEAK = 0.2;

/** Erkennung für die Oberflächen-Stabilisierung: Mitte = Bildmitte + Verschiebung gegenüber der Referenz */
function surfaceDetection(lum: Lum, s: SurfaceMotion): FrameDetection {
  let max = 0, over = 0, n = 0;
  for (let i = 0; i < lum.data.length; i += 7, n++) {
    if (lum.data[i] > max) max = lum.data[i];
    if (lum.data[i] >= 0.99) over++;
  }
  const w = lum.width, h = lum.height;
  const overexposed = over / Math.max(1, n);
  return { ...emptyDetection(), found: true, cx: w / 2 + s.dx, cy: h / 2 + s.dy, x1: w - 1, y1: h - 1, size: Math.min(w, h), maxValue: max, overexposed, overexposedObject: overexposed, surface: s };
}

export interface FrameResult {
  index: number;
  det: FrameDetection;
  accepted: boolean;
  reason?: string;
  score: number;
  /** Bei der Ausgabe: dieses Bild steht für die ganze HDR-Belichtungsreihe (Frame-Indizes) */
  hdrGroup?: number[];
}

export interface ProcessReport {
  frames: FrameResult[];
  written: number[];
  /** Zu HDR zusammengefasste Belichtungsreihen (Frame-Indizes) */
  hdrGroups: number[][];
  outWidth: number;
  outHeight: number;
}

export type Progress = (phase: "analyse" | "write", done: number, total: number) => void;
/** Empfängt die fertigen Frames in Ausgabe-Reihenfolge. */
export type FrameSink = (frame: Frame, res: FrameResult, position: number, timestamp: bigint | undefined) => void | Promise<void>;

function frameRange(src: FrameSource, o: ProcessOptions): number[] {
  const n = src.frameCount;
  const start = Math.min(Math.max(0, o.startFrame), n);
  const end = o.maxFrames > 0 ? Math.min(n, start + o.maxFrames) : n;
  return Array.from({ length: end - start }, (_, i) => start + i);
}

function outSize(src: FrameSource, o: ProcessOptions): [number, number] {
  return o.cropEnabled ? [o.cropWidth, o.cropHeight] : [src.width, src.height];
}

export function detect(lum: Lum, o: ProcessOptions): FrameDetection {
  const det: FrameDetection = detectObject(lum, { threshold: o.threshold ?? undefined });
  if (o.centreMode === "disc" && det.found) {
    const [fit, kind] = limbFit(lum, o);
    if (fit.found) {
      det.disc = { cx: fit.cx, cy: fit.cy, r: fit.r, visibleLimb: fit.visibleLimb, rms: fit.rms, kind };
      det.size = Math.round(2 * fit.r);
      if (kind === "sun" && o.totalitySunCentre) {
        const m = fitMoonInPartial(lum, fit, fit.threshold);
        if (m) det.disc.moon = { cx: m.cx, cy: m.cy, r: m.r };
      }
    }
  }
  return det;
}

/**
 * Sonnenrand oder – in der Totalität – Mondrand. Ein Mond ringsum in Korona gilt als Totalität,
 * ausser die ganze Sonnenscheibe umschliesst ihn sichtbar (ringförmige Finsternis → Sonnenrand).
 */
function limbFit(lum: Lum, o: ProcessOptions): [DiscFit, "sun" | "moon"] {
  const moon = fitMoonDisc(lum);
  const sun = fitSunDisc(lum, { threshold: o.threshold ?? undefined });
  if (!moon.found) return [sun, "sun"];
  const annular =
    sun.found && sun.visibleLimb >= 0.8 && sun.r > moon.r * 1.01 &&
    Math.hypot(sun.cx - moon.cx, sun.cy - moon.cy) < sun.r - moon.r + 2 &&
    darkOutside(lum, sun, (sun.r + moon.r) / 2);
  return annular ? [sun, "sun"] : [moon, "moon"];
}

/**
 * Ringförmige Finsternis: ausserhalb des Sonnenrands ist es (mit Filter) dunkel.
 * In der Totalität fällt die innere Korona zwar steil ab, leuchtet draussen aber weiter.
 */
function darkOutside(lum: Lum, sun: DiscFit, ringR: number): boolean {
  const bg = percentile(lum.data, 0.05);
  const ring: number[] = [], out: number[] = [];
  for (let k = 0; k < 72; k++) {
    const a = (2 * Math.PI * k) / 72, c = Math.cos(a), s = Math.sin(a);
    const vr = sample(lum, sun.cx + c * ringR, sun.cy + s * ringR);
    const vo = sample(lum, sun.cx + c * sun.r * 1.15, sun.cy + s * sun.r * 1.15);
    if (vr >= 0 && vo >= 0) { ring.push(vr - bg); out.push(vo - bg); }
  }
  if (ring.length < 20) return false;
  const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  return med(out) < 0.15 * Math.max(1e-6, med(ring));
}

function emptyDetection(): FrameDetection {
  return { found: false, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, size: 0, threshold: 0, maxValue: 0, touchesEdge: false, overexposed: 0 };
}

/** Mittelpunkt, auf den zentriert wird. */
function centreOf(src: FrameSource, o: ProcessOptions, det: FrameDetection): [number, number] {
  if (!o.centre || !det.found) return [src.width / 2, src.height / 2];
  if (o.centreMode === "disc" && det.disc) {
    if (det.disc.kind === "moon" && det.disc.sun && o.totalitySunCentre) return [det.disc.sun.cx, det.disc.sun.cy];
    return [det.disc.cx, det.disc.cy];
  }
  return [det.cx, det.cy];
}

/** Linke obere Ecke des Ausschnitts für ein Frame. */
function originFor(src: FrameSource, o: ProcessOptions, det: FrameDetection): [number, number] {
  if (!o.cropEnabled && !o.centre) return [0, 0];
  const [cw, ch] = outSize(src, o);
  const [cx, cy] = centreOf(src, o, det);
  return cropOrigin(cx - o.offsetX, cy - o.offsetY, cw, ch, src.colorId, bayerPatternFor(o, src) !== null);
}

/**
 * Ausgabe-Ausschnitt eines Bildes. Mit Ausgleich der Bilddrehung: etwas grösser ausschneiden, farbig machen und
 * um die Bildmitte zurückdrehen (bilinear, mit Unterpixel-Lage); sonst wie gewohnt ausschneiden.
 */
function outputCrop(src: FrameSource, frame: Frame, o: ProcessOptions, det: FrameDetection, cw: number, ch: number): Frame {
  if (!rotates(o)) {
    const [x0, y0] = originFor(src, o, det);
    return cropFrame(frame, x0, y0, cw, ch);
  }
  const angle = det.surface?.angle ?? 0;
  const [cx0, cy0] = centreOf(src, o, det);
  const cx = cx0 - o.offsetX, cy = cy0 - o.offsetY;
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const mx = Math.ceil((c * cw + s * ch - cw) / 2) + 2, my = Math.ceil((s * cw + c * ch - ch) / 2) + 2;
  const bw = cw + 2 * mx, bh = ch + 2 * my;
  const [x0, y0] = cropOrigin(cx, cy, bw, bh, frame.colorId, bayerPatternFor(o, frame) !== null);
  const big = colourise(cropFrame(frame, x0, y0, bw, bh), o);
  return rotatedCrop(big, cx - x0, cy - y0, angle, cw, ch);
}

export function judge(index: number, det: FrameDetection, o: ProcessOptions): FrameResult {
  const r: FrameResult = { index, det, accepted: true, score: 0 };
  if (o.checkObject && o.centreMode === "surface") {
    if (det.surface && det.surface.peak < SURFACE_MIN_PEAK)
      Object.assign(r, { accepted: false, reason: msg("noSurface", Math.round(det.surface.peak * 100)) });
  } else if (o.checkObject) {
    if (!det.found) Object.assign(r, { accepted: false, reason: msg("noObject") });
    else if (det.size < o.minObjectSize) Object.assign(r, { accepted: false, reason: msg("tooSmall", det.size) });
    else if (o.rejectEdgeTouching && det.touchesEdge) Object.assign(r, { accepted: false, reason: msg("touchesEdge") });
    else if (o.centreMode === "disc" && o.centre && !det.disc)
      // fast schwarzes Bild (Sonne hinter Wolken, Filter zu dicht): verständlicher Grund statt „Rand nicht gefunden“
      Object.assign(r, { accepted: false, reason: msg(det.maxValue < 0.08 ? "tooDark" : "noLimb") });
    // Rand zwar gefunden, aber im fast schwarzen Bild nur unsicher (Streuung > 2 px): Radius und Mitte sind dann
    // oft falsch (echte Serie: r 124 statt 236) – lieber verwerfen als die Sonne springen lassen
    else if (o.centreMode === "disc" && o.centre && det.disc && det.maxValue < 0.08 && det.disc.rms > 2)
      Object.assign(r, { accepted: false, reason: msg("tooDark") });
  }
  // Überbelichtung: Anteil gesättigter Pixel an der Objektfläche. Totalität ausgenommen (Korona gewollt gesättigt).
  if (r.accepted && o.checkObject && o.rejectOverexposed && det.disc?.kind !== "moon") {
    const pct = 100 * (det.overexposedObject ?? det.overexposed);
    if (pct > o.overexposedLimit) Object.assign(r, { accepted: false, reason: msg("overexposed", pct < 10 ? pct.toFixed(1) : Math.round(pct)) });
  }
  return r;
}

/**
 * Die Sonne ist von Bild zu Bild gleich gross (höchstens langsam veränderlich, z. B. tief am Horizont).
 * Weicht der Radius stark von den Nachbarbildern ab, ist der Rand durch Dunst, Wolken oder Unschärfe
 * verfälscht – dann stimmt auch die Mitte nicht. Solche Frames werden verworfen.
 */
export function rejectRadiusOutliers(results: FrameResult[], window = 4, tolerance = 0.1): void {
  // Sonnen- und Mondrand gemeinsam: Der Mond ist nur 0–6 % grösser als die Sonne. So fallen auch falsche
  // „Sonnenränder“ in der Totalität auf (Korona, Diamantring, Wolken), wenn rundherum der Mond gefunden wurde.
  let withDisc = results.filter((r) => r.accepted && r.det.disc);
  if (withDisc.length < 5) return;
  // Stufe 1: grobe Fehler gegen den Median der ganzen Serie (z. B. Diamantring hinter Wolken mit dreifachem
  // Radius) – sonst verschieben sie den Vergleichswert der Nachbarn und richtige Bilder fallen heraus.
  const all = withDisc.map((r) => r.det.disc!.r).sort((a, b) => a - b);
  const gmed = all[all.length >> 1];
  for (const res of withDisc) {
    const r = res.det.disc!.r;
    if (Math.abs(r - gmed) > 0.3 * gmed) {
      res.accepted = false;
      res.reason = msg("radiusOutlier", Math.round(2 * r), Math.round(2 * gmed));
    }
  }
  withDisc = withDisc.filter((r) => r.accepted);
  if (withDisc.length < 5) return;
  // Stufe 2: feinere Prüfung gegen die Nachbarbilder (Radius ändert sich langsam, z. B. tief am Horizont)
  const radii = withDisc.map((r) => r.det.disc!.r);
  withDisc.forEach((res, i) => {
    const neighbours = radii.slice(Math.max(0, i - window), i + window + 1).sort((a, b) => a - b);
    const med = neighbours[neighbours.length >> 1];
    const r = radii[i];
    if (Math.abs(r - med) > tolerance * med) {
      res.accepted = false;
      res.reason = msg("radiusOutlier", Math.round(2 * r), Math.round(2 * med));
    }
  });
}

/**
 * Sonnenmitte für die Bilder der Totalität. In den partiellen Phasen sind Sonne und Mond im selben Bild messbar;
 * ihr Abstand ändert sich gleichmässig mit der Zeit (der Mond zieht mit etwa 0.5″/s vor der Sonne vorbei), und
 * zwar unabhängig davon, wie die Kamera nachgeführt ist. Eine Gerade durch die nächsten Messungen vor und nach
 * der Totalität ergibt den Abstand zu jedem Zeitpunkt; Sonnenmitte = Mondmitte + Abstand.
 * Ohne genug partielle Bilder (oder bei unplausiblem Ergebnis) bleibt es beim Mond.
 */
export function estimateSunInTotality(results: FrameResult[], stamps: BigInt64Array | null, maxMinutes = 40): void {
  const tOf = (r: FrameResult) => (stamps ? Number(stamps[r.index] - stamps[0]) / 1e7 : r.index);
  const tot = results.filter((r) => r.accepted && r.det.disc?.kind === "moon");
  if (!tot.length) return;
  const t0 = Math.min(...tot.map(tOf)), t1 = Math.max(...tot.map(tOf));
  const span = stamps ? maxMinutes * 60 : Infinity;
  const partial = results
    .filter((r) => r.accepted && r.det.disc?.kind === "sun" && r.det.disc.moon)
    .map((r) => ({ t: tOf(r), dx: r.det.disc!.cx - r.det.disc!.moon!.cx, dy: r.det.disc!.cy - r.det.disc!.moon!.cy }));
  const before = partial.filter((p) => p.t < t0 && t0 - p.t <= span).sort((a, b) => b.t - a.t).slice(0, 4);
  const after = partial.filter((p) => p.t > t1 && p.t - t1 <= span).sort((a, b) => a.t - b.t).slice(0, 4);
  const use = [...before, ...after];
  // beidseitig mindestens je eins, oder einseitig mindestens drei (dann wird über die Totalität verlängert)
  if (!((before.length && after.length) || use.length >= 3)) return;
  const fit = (key: "dx" | "dy") => {
    const n = use.length, mt = use.reduce((a, p) => a + p.t, 0) / n, mv = use.reduce((a, p) => a + p[key], 0) / n;
    let sxx = 0, sxy = 0;
    for (const p of use) { sxx += (p.t - mt) ** 2; sxy += (p.t - mt) * (p[key] - mv); }
    const b = sxx > 0 ? sxy / sxx : 0;
    return (t: number) => mv + b * (t - mt);
  };
  const fx = fit("dx"), fy = fit("dy");
  // Plausibel: in der Totalität liegen die Mitten höchstens um die Radiusdifferenz (wenige Prozent) auseinander
  for (const r of tot) {
    const d = r.det.disc!;
    const dx = fx(tOf(r)), dy = fy(tOf(r));
    if (Math.hypot(dx, dy) > 0.08 * d.r) return;
  }
  for (const r of tot) {
    const d = r.det.disc!;
    d.sun = { cx: d.cx + fx(tOf(r)), cy: d.cy + fy(tOf(r)) };
  }
}

/**
 * Kurz vor und nach der Totalität (dünne Sichel, Perlschnur, Diamantring) ist vom Sonnenrand nur ein kurzes,
 * überstrahltes Stück übrig; die Anpassung trifft dann oft den Rand der Blendung oder der inneren Korona. Echte
 * Serien: Ø 512 statt 392 px kurz vor dem 3. Kontakt (überbelichtete innere Korona um den Mond), Sichel mit 4 %
 * zu kleinem Radius, Diamantring mit 2.5 % zu grossem. Solche Ränder müssen zur gut sichtbaren Sonne derselben
 * Serie passen: Vergleich mit den zeitlich nächsten Bildern, in denen mindestens 40 % des Rands sichtbar sind
 * (der Radius ändert sich tief am Horizont durch die Lichtbrechung langsam, deshalb die nächsten – und von beiden
 * Seiten der Totalität, sonst hinkt der Vergleichswert bei sinkender Sonne nach: Diamantring 3 % zu gross).
 * Ohne solche Bilder dient der Mond als Mass (er ist in der Totalität 0–7 % grösser als die Sonne, erscheint
 * mit Blendung am Rand aber bis 10 % kleiner).
 */
export function rejectSunNearTotality(results: FrameResult[], stamps: BigInt64Array | null, windowMinutes = 3, tolerance = 0.02): void {
  const tOf = (r: FrameResult) => (stamps ? Number(stamps[r.index] - stamps[0]) / 1e7 : r.index);
  const win = stamps ? windowMinutes * 60 : 5;
  const moons = results.filter((r) => r.accepted && r.det.disc?.kind === "moon");
  if (moons.length < 2) return;
  // nur Mondränder, die untereinander passen (falsche „Monde“ in Blendung zählen nicht)
  const mr = moons.map((r) => r.det.disc!.r).sort((a, b) => a - b);
  const moonMed = mr[mr.length >> 1];
  const moonT = moons.filter((r) => Math.abs(r.det.disc!.r - moonMed) <= 0.1 * moonMed).map(tOf);
  if (moonT.length < 2) return;
  const near = (t: number) => moonT.some((m) => Math.abs(m - t) <= win);
  const suns = results.filter((r) => r.accepted && r.det.disc?.kind === "sun");
  const good = suns.filter((r) => r.det.disc!.visibleLimb >= 0.4 && !near(tOf(r)));
  for (const res of suns) {
    const t = tOf(res);
    if (!near(t)) continue;
    const r = res.det.disc!.r;
    const ref = good
      .map((g) => ({ d: Math.abs(tOf(g) - t), r: g.det.disc!.r }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 7)
      .map((g) => g.r)
      .sort((a, b) => a - b);
    const sunR = ref.length >= 3 ? ref[ref.length >> 1] : null;
    const bad = sunR !== null ? Math.abs(r - sunR) > tolerance * sunR : r > 1.25 * moonMed || r < 0.8 * moonMed;
    if (bad) {
      res.accepted = false;
      res.reason = msg("nearTotality", Math.round(2 * r), Math.round(2 * (sunR ?? moonMed)));
    }
  }
}

/**
 * Die Totalität ist ein zusammenhängender Zeitraum (höchstens 7.5 min). Ein „Sonnenrand“ zwischen zwei Bildern
 * mit Mondrand kann nicht stimmen – meist ein sehr dunkles Bild (Perlschnur) oder Blendung –, also verwerfen.
 */
export function rejectSunInsideTotality(results: FrameResult[], stamps: BigInt64Array | null, maxSpanMinutes = 8): void {
  const moon = results.filter((r) => r.accepted && r.det.disc?.kind === "moon").map((r) => r.index);
  if (moon.length < 2) return;
  for (const r of results) {
    if (!r.accepted || r.det.disc?.kind !== "sun") continue;
    const before = moon.filter((i) => i < r.index).pop();
    const after = moon.find((i) => i > r.index);
    if (before === undefined || after === undefined) continue;
    if (stamps && Number(stamps[after] - stamps[before]) / 6e8 > maxSpanMinutes) continue;
    r.accepted = false;
    r.reason = msg("totalityNoMoon");
  }
}

/**
 * Helligkeitsbild für Erkennung und Schärfemass. Lineare Kamera-RAW-Daten werden dafür wie von einer Kamera
 * aufgehellt (Quadratwurzel): Die schwache Korona und dünne Ringe (Perlschnur) sind sonst kaum über dem Rauschen.
 * Die Ausgabe bleibt unverändert linear.
 */
function lumFor(src: { linear?: boolean }, frame: Frame, o: ProcessOptions): Lum {
  const lum = toLum(frame, bayerPatternFor(o, frame) !== null);
  if (src.linear) for (let i = 0; i < lum.data.length; i++) lum.data[i] = Math.sqrt(lum.data[i]);
  return lum;
}

/** Analysiert ein einzelnes Frame (für Vorschau / Testlauf). */
export async function analyseFrame(src: FrameSource | SerReader, index: number, o: ProcessOptions) {
  const s = src instanceof SerReader ? serSource(src, "frame") : src;
  const frame = await s.readFrame(index);
  const lum = lumFor(s, frame, o);
  let det: FrameDetection;
  if (o.centreMode === "surface") {
    // Vorschau: gegen das erste Bild des Bereichs ausrichten (wie bei der Verarbeitung)
    const refIndex = frameRange(s, o)[0] ?? 0;
    const ref = refIndex === index ? lum : lumFor(s, await s.readFrame(refIndex), o);
    det = surfaceDetection(lum, new SurfaceTracker(ref, o.surfaceAnchor, { followRef: false, rotation: o.surfaceRotation }).align(lum));
  } else det = detect(lum, o);
  const [x0, y0] = originFor(s, o, det);
  const [cw, ch] = outSize(s, o);
  const res = judge(index, det, o);
  res.score = o.qualityEnabled && res.accepted ? quality(cropLum(lum, x0, y0, cw, ch), o.quality) : 0;
  return { frame: colourise(frame, o), det, result: res, crop: { x0, y0, width: cw, height: ch }, output: colouriseOutput(finishFrame(outputCrop(s, frame, o, det, cw, ch), o), o) };
}

export async function processSource(
  src: FrameSource,
  o: ProcessOptions,
  sink: FrameSink,
  onProgress: Progress = () => {},
  shouldCancel: () => boolean = () => false,
): Promise<ProcessReport> {
  const indices = frameRange(src, o);
  const [cw, ch] = outSize(src, o);
  const results: FrameResult[] = [];
  // Oberfläche: erstes lesbares Bild ist die Referenz
  let aligner: SurfaceTracker | null = null;

  // Durchlauf 1: erkennen und bewerten
  for (let k = 0; k < indices.length; k++) {
    if (shouldCancel()) throw new Error(msg("cancelled"));
    let frame: Frame;
    try {
      frame = await src.readFrame(indices[k]);
    } catch {
      // Ein defektes oder fremdes Bild soll nicht die ganze Serie abbrechen.
      results.push({ index: indices[k], det: emptyDetection(), accepted: false, reason: msg("unreadable"), score: 0 });
      onProgress("analyse", k + 1, indices.length);
      continue;
    }
    const lum = lumFor(src, frame, o);
    let det: FrameDetection;
    if (o.centreMode === "surface") {
      aligner ??= new SurfaceTracker(lum, o.surfaceAnchor, { followRef: o.surfaceFollow, rotation: o.surfaceRotation });
      det = surfaceDetection(lum, aligner.align(lum));
    } else det = detect(lum, o);
    const res = judge(indices[k], det, o);
    if (res.accepted && o.qualityEnabled) {
      const [x0, y0] = originFor(src, o, det);
      res.score = quality(cropLum(lum, x0, y0, cw, ch), o.quality);
    }
    results.push(res);
    onProgress("analyse", k + 1, indices.length);
  }
  const stamps = await src.readTimestamps();
  if (o.centreMode === "disc" && o.checkObject) {
    // zuerst die Bilder rund um die Totalität: falsche Ränder dort liegen oft dicht beisammen, bestätigen sich in
    // der Nachbarprüfung gegenseitig und verdrängen sonst die richtigen Mondrand-Bilder
    rejectSunNearTotality(results, stamps);
    rejectRadiusOutliers(results);
    rejectSunInsideTotality(results, stamps);
    if (o.totalitySunCentre) estimateSunInTotality(results, stamps);
  }

  // Auswahl und Reihenfolge
  let chosen = results.filter((x) => x.accepted);
  if (o.qualityEnabled) {
    const byScore = [...chosen].sort((a, b) => b.score - a.score);
    let keep = byScore.length;
    if (o.keepMode === "count") keep = Math.min(keep, Math.max(1, Math.floor(o.keepValue)));
    if (o.keepMode === "percent") keep = Math.max(1, Math.round((byScore.length * o.keepValue) / 100));
    const kept = new Set(byScore.slice(0, keep).map((x) => x.index));
    chosen = o.reorder ? byScore.slice(0, keep) : chosen.filter((x) => kept.has(x.index));
  }

  // Belichtungsreihen der Totalität (nur in Aufnahme-Reihenfolge sinnvoll)
  const hdrGroups =
    o.hdr && o.centreMode === "disc" && o.centre && src.exposure && !(o.qualityEnabled && o.reorder)
      ? bracketGroups(
          chosen.map((r) => ({
            index: r.index,
            timeMs: stamps ? Number((stamps[r.index] - 621_355_968_000_000_000n) / 10_000n) : null,
            exposure: src.exposure!(r.index),
            totality: r.det.disc?.kind === "moon",
          })),
        )
      : [];
  const groupOf = new Map<number, number[]>();
  for (const g of hdrGroups) for (const i of g) groupOf.set(i, g);
  const resOf = new Map(chosen.map((r) => [r.index, r]));

  // Durchlauf 2: zuschneiden und ausgeben
  const written: number[] = [];
  for (let k = 0; k < chosen.length; k++) {
    if (shouldCancel()) throw new Error(msg("cancelled"));
    const res = chosen[k];
    const group = groupOf.get(res.index);
    const ts = stamps ? stamps[res.index] : undefined;
    if (group) {
      if (group[0] === res.index) {
        const parts: BracketFrame[] = [];
        for (const i of group) {
          const r = resOf.get(i)!;
          const [x0, y0] = originFor(src, o, r.det);
          const [cx, cy] = centreOf(src, o, r.det);
          const f = colourise(cropFrame(await src.readFrame(i), x0, y0, cw, ch), o);
          parts.push({ frame: f, exposure: src.exposure!(i)!, dx: cx - o.offsetX - cw / 2 - x0, dy: cy - o.offsetY - ch / 2 - y0 });
        }
        // Ausrichtung relativ zum ersten Bild der Reihe: dessen Lage bleibt (wie bei den Einzelbildern)
        const rx = parts[0].dx, ry = parts[0].dy;
        for (const pt of parts) { pt.dx -= rx; pt.dy -= ry; }
        // Mond im Ausgabebild (erstes Bild der Reihe) – für den Abzug des Himmelslichts
        const d0 = resOf.get(group[0])!.det.disc;
        const [gx0, gy0] = originFor(src, o, resOf.get(group[0])!.det);
        const moon = d0 ? { cx: d0.cx - gx0, cy: d0.cy - gy0, r: d0.r } : undefined;
        await sink(finishFrame(mergeHdr(parts, { srgb: src.kind === "images" && !src.linear, moon }), o), { ...res, hdrGroup: group }, written.length, ts);
        written.push(res.index);
      }
    } else {
      const frame = await src.readFrame(res.index);
      await sink(finishFrame(outputCrop(src, frame, o, res.det, cw, ch), o), res, written.length, ts);
      written.push(res.index);
    }
    onProgress("write", k + 1, chosen.length);
  }

  const [ow, oh] = outputSize(src, o);
  return { frames: results, written, hdrGroups, outWidth: ow, outHeight: oh };
}

/** Bequeme Variante für SER → SER (wird von Tests genutzt). */
export async function processSer(
  r: SerReader,
  o: ProcessOptions,
  onProgress: Progress = () => {},
  shouldCancel: () => boolean = () => false,
): Promise<{ blob: Blob; report: ProcessReport }> {
  const [cw, ch] = o.cropEnabled ? [o.cropWidth, o.cropHeight] : [r.header.width, r.header.height];
  const colorId = outputColorId(o, r.header, cw, ch);
  const [ow, oh] = outputSize(r.header, o);
  const writer = new SerWriter({ ...r.header, colorId, width: ow, height: oh });
  const sink: FrameSink = (f, _r, _k, ts) => writer.add(f.colorId === colorId ? f : colouriseOutput(f, o), ts);
  const report = await processSource(serSource(r, "frame"), o, sink, onProgress, shouldCancel);
  return { blob: writer.toBlob(), report };
}
