// Verarbeitungsablauf: erkennen → prüfen → bewerten → sortieren → zuschneiden → ausgeben.
// Zwei Durchläufe, damit auch sehr lange Videos nicht komplett im Speicher liegen müssen.
import { cropFrame, cropLum, cropOrigin, detectObject, toLum, type Detection, type Lum } from "./image";
import { backgroundLevel, fitSunDisc, percentile, sample, type DiscFit } from "./limb";
import { bracketGroups, fitMoonDisc, fitMoonInPartial, mergeHdr, type BracketFrame } from "./totality";
import { quality, type QualityOptions, defaultQuality } from "./quality";
import { limbWidth } from "./eclipsemovie";
import { SerColor, SerReader, SerWriter, type Frame } from "./ser";
import { debayer, patternFromColorId, type BayerPattern } from "./debayer";
import { serSource, type FrameSource } from "./source";
import { SurfaceTracker, type SurfaceBox, type SurfaceMotion } from "./surface";
import { bayerAfterTransform, hasTransform, resize, rotatedCrop, soften, transformFrame, transformedSize, type TransformOptions } from "./transform";
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
  /**
   * Verwackelte oder unscharfe Bilder verwerfen (Mittelpunkt "disc"): Der Sonnenrand ist deutlich breiter als in
   * den zeitlich nächsten Bildern derselben Serie. Verglichen wird innerhalb der Serie, damit Dunst oder eine
   * überbelichtete Sonne (Rand immer etwas breit) nicht alles verwerfen.
   */
  rejectBlurred: boolean;
  /**
   * Ausschnitt nach der Grösse der Sonne wählen (Mittelpunkt "disc"): mit Totalität Platz für die Korona
   * (5 Sonnenradien), sonst etwas Rand um die Scheibe (2.6 Radien). cropWidth/cropHeight werden dann ersetzt.
   */
  cropAuto: boolean;
  /**
   * Einfach-Modus: Sonne streng prüfen. Bilder ohne Sonne (Landschaft, Personen, Himmel) werden verworfen; bei
   * überstrahlter Sonne in einem grossen Lichtschein (Handy ohne Filter) wird am gesättigten Kern gemessen.
   */
  strictSun: boolean;
  /**
   * Sonne in allen Bildern gleich gross (Mittelpunkt "disc"): Wer mit dem Handy fotografiert, zoomt mal mehr, mal
   * weniger. Jedes Bild wird so vergrössert oder verkleinert, dass die Sonne so gross ist wie im Median der Serie.
   * Verworfen werden dann nur Bilder, deren Sonnengrösse zu keinem Nachbarbild passt (überstrahlt, Wolken).
   */
  matchSize: boolean;
  /**
   * Was die Scheibe ist (Mittelpunkt "disc"). "sun": Sonne, auch mit Mond davor und Totalität (Korona).
   * "moon": der Mond selbst – Mondfinsternis oder Mondphasen. Gesucht wird nur der Mondrand; den Erdschatten
   * begrenzt kein scharfer Rand, und eine Totalität mit Korona gibt es nicht.
   */
  subject: "sun" | "moon";
  /**
   * Schnelle Analyse für Fotoserien (Mittelpunkt "disc", ohne Schärfe-Auswahl): Das Objekt wird zuerst in einer
   * verkleinerten Ansicht gesucht, danach wird nur der Ausschnitt um das Objekt in voller Auflösung gelesen und
   * vermessen. Spart bei grossen Fotos den grössten Teil der Zeit und des Speichers. Braucht eine Quelle mit
   * Teilansichten (hasParts); sonst wie gewohnt.
   */
  fastAnalyse: boolean;
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
  rejectBlurred: false,
  cropAuto: false,
  strictSun: false,
  matchSize: false,
  subject: "sun",
  fastAnalyse: false,
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
    /** partielle Phase: Breite des Sonnenrands in Pixel (Mass für Schärfe, siehe limbWidth) */
    limbWidth?: number;
    /** strictSun: sieht nach Sonne aus (nicht zu gross, kaum Helles daneben) */
    plausible?: boolean;
    /** partielle Phase: Lage des Mondes vor der Sonne (innere Kante der Sichel) */
    moon?: { cx: number; cy: number; r: number };
    /**
     * partielle Phase, Mondrand nur unscharf messbar (überstrahlte Sichel, Dunst): Lage mit grösserer Streuung –
     * genug für Zwischenbilder im Film, nicht für die Sonnenmitte in der Totalität
     */
    moonLoose?: { cx: number; cy: number; r: number };
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
  /** Bei der Ausgabe: linke obere Ecke des Ausschnitts im Originalbild (für Lage von Sonne und Mond im Ausschnitt) */
  origin?: [number, number];
  /** matchSize: Vergrösserung dieses Bildes, damit die Sonne so gross ist wie im Median der Serie */
  zoom?: number;
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

/**
 * Schnelle Analyse: Das Helligkeitsbild ist nur ein Ausschnitt (linke obere Ecke bei x, y im Bild der Grösse
 * width × height); das ganze Bild liegt verkleinert vor (scale Bildpunkte je Punkt).
 */
export interface WholeView {
  lum: Lum; scale: number; x: number; y: number; width: number; height: number;
  /** Schwelle der Objektsuche am ganzen Bild – gilt auch im Ausschnitt */
  objectThreshold: number;
}

export function detect(lum: Lum, o: ProcessOptions, whole?: WholeView): FrameDetection {
  const det: FrameDetection = detectObject(lum, { threshold: o.threshold ?? whole?.objectThreshold });
  if (o.centreMode === "disc" && det.found) {
    const lunar = o.subject === "moon";
    // Ausschnitt: Hintergrund und Helligkeit der Scheibe vom ganzen Bild – dieselben Schwellen wie ohne Ausschnitt
    const levels = whole ? { background: backgroundLevel(whole.lum), peak: percentile(whole.lum.data, 0.999) } : undefined;
    // … und dasselbe Raster der Grobsuche (der Ausschnitt beginnt auf einem Vielfachen davon, siehe detectFast)
    const fSun = whole ? coarseFactor(whole, 1200) : undefined, fMoon = whole ? coarseFactor(whole, 900) : undefined;
    let [fit, kind] = lunar ? ([fitSunDisc(lum, { threshold: o.threshold ?? undefined, levels, factor: fSun }), "sun"] as [DiscFit, "sun" | "moon"]) : limbFit(lum, o, levels, fSun, fMoon);
    // Einfach-Modus: Lichtschein ohne brauchbaren Kreis, aber mit gesättigtem Kern (Handy ohne Filter) – ob die erste
    // Suche am Schein gelingt, ist Glückssache; gemessen wird ohnehin am Kern (siehe unten). Dann gleich dort.
    if (!lunar && o.strictSun && !fit.found && det.maxValue >= 0.98) {
      const core = fitSunDisc(lum, { threshold: 0.9, factor: fSun });
      if (core.found && core.visibleLimb >= 0.3 && core.rms <= Math.max(2, 0.03 * core.r)) [fit, kind] = [core, "sun"];
    }
    // Einfach-Modus: überstrahlte Sonne im grossen Lichtschein (Handy ohne Filter, herangezoomt) – die Schwelle bei
    // halber Höhe liegt dann im Lichtschein, der „Rand“ wäre der Rand des Scheins. Gemessen wird am gesättigten Kern.
    if (!lunar && o.strictSun && fit.found && kind === "sun" && det.maxValue >= 0.98 && saturatedShare(lum, fit) < 0.3) {
      const core = fitSunDisc(lum, { threshold: 0.9, factor: fSun });
      if (core.found && core.r < 0.7 * fit.r) fit = core;
    }
    if (fit.found) {
      det.disc = { cx: fit.cx, cy: fit.cy, r: fit.r, visibleLimb: fit.visibleLimb, rms: fit.rms, kind };
      det.size = Math.round(2 * fit.r);
      if (kind === "sun" && o.totalitySunCentre && !lunar) {
        const m = fitMoonInPartial(lum, fit, fit.threshold, { factor: fMoon });
        if (m) det.disc.moon = { cx: m.cx, cy: m.cy, r: m.r };
      }
      if (kind === "sun" && !det.disc.moon && !lunar) {
        const m = fitMoonInPartial(lum, fit, fit.threshold, { maxRms: Math.max(4, 0.025 * fit.r), factor: fMoon });
        if (m) det.disc.moonLoose = { cx: m.cx, cy: m.cy, r: m.r };
      }
      if (kind === "sun") det.disc.limbWidth = limbWidth(lum, fit, det.disc.moon) ?? undefined;
      // Ist das überhaupt die Sonne? Deutlich kleiner als das Bild, und fast alles Helle gehört zu ihr
      // (Landschaft, Himmel, Personen: helle Flächen überall)
      if (o.strictSun && kind === "sun") {
        // bei der schnellen Analyse am verkleinerten ganzen Bild (der Ausschnitt zeigt nur die Umgebung der Scheibe)
        const b = whole
          ? brightOutside(whole.lum, { cx: (fit.cx + whole.x) / whole.scale, cy: (fit.cy + whole.y) / whole.scale, r: fit.r / whole.scale, threshold: fit.threshold })
          : brightOutside(lum, fit);
        const minSide = whole ? Math.min(whole.width, whole.height) : Math.min(lum.width, lum.height);
        // Ausnahme für die dünne Sichel kurz vor der Totalität: wenig Helles in der Sichel, daneben etwas Dunst
        det.disc.plausible = fit.r <= 0.45 * minSide && (b.share <= 0.3 || (fit.visibleLimb <= 0.45 && b.perDisc <= 0.1));
        // Sonne: Ein sehr grosser Kreis (Radius über ein Fünftel der kurzen Bildseite) muss eng am Rand liegen.
        // Fotos ohne brauchbare Sonne – durch eine Finsternisbrille, Zimmer, Landschaft – ergeben grosse Kreise durch
        // irgendwelche Kanten mit 1.6–1.7 % Streuung; echte stark herangezoomte Sicheln liegen bei 0.3–0.5 %.
        if (!lunar && fit.r > 0.2 * minSide && fit.rms > Math.max(3, 0.01 * fit.r)) det.disc.plausible = false;
        // Mond: Nachtaufnahmen (Menschen, Lichter, Wolken) ergeben oft einen grossen „Kreis“ durch irgendwelche
        // Kanten – wenig Rand und grosse Streuung. Ein echter Mondrand liegt eng am Kreis oder ist weit herum
        // sichtbar (auch weich und verrauscht in der Totalität: Streuung bis 2 % des Radius, echte Handy-Serie).
        if (lunar)
          det.disc.plausible &&=
            (fit.rms <= Math.max(1.5, 0.006 * fit.r) && fit.visibleLimb >= 0.15) || (fit.rms <= Math.max(3, 0.02 * fit.r) && fit.visibleLimb >= 0.3);
      }
    }
  }
  return det;
}

/** Verkleinerungsfaktor der Grobsuche am ganzen Bild (wie in fitSunDisc bzw. fitMoonDisc) */
const coarseFactor = (size: { width: number; height: number }, workSize: number) => Math.max(1, Math.ceil(Math.max(size.width, size.height) / workSize));

/** Längere Seite der verkleinerten Ansicht für die Grobsuche */
const PREVIEW_SIDE = 800;

/**
 * Schnelle Analyse eines Fotos: alles Helle in der verkleinerten Ansicht suchen, dann nur diesen Bereich (mit
 * reichlich Rand für Lichtschein, Korona und den Himmel als Hintergrund) in voller Auflösung vermessen.
 * Liegt Helles über das ganze Bild verteilt (Landschaft), ist der Bereich das ganze Bild – dann ohne Zeitgewinn.
 */
async function detectFast(src: FrameSource, index: number, o: ProcessOptions): Promise<FrameDetection> {
  const { frame: small, scale } = await src.readPreview!(index, PREVIEW_SIDE);
  const lumS = lumFor(src, small, o);
  const coarse = detectObject(lumS, { threshold: o.threshold ?? undefined });
  if (!coarse.found) return coarse;
  const bw = (coarse.x1 - coarse.x0 + 1) * scale, bh = (coarse.y1 - coarse.y0 + 1) * scale;
  const m = Math.max(0.6 * Math.max(bw, bh), 4 * scale, 48);
  // Ecke auf dem Raster der Grobsuche am ganzen Bild – die verkleinerten Bildpunkte sind dann dieselben
  const grid = coarseFactor(src, 1200) * coarseFactor(src, 900);
  const snap = (v: number) => v - (v % grid);
  const x0 = snap(Math.max(0, Math.floor(coarse.x0 * scale - m))), y0 = snap(Math.max(0, Math.floor(coarse.y0 * scale - m)));
  const x1 = Math.min(src.width, Math.ceil((coarse.x1 + 1) * scale + m)), y1 = Math.min(src.height, Math.ceil((coarse.y1 + 1) * scale + m));
  const lum = lumFor(src, await src.readRegion!(index, x0, y0, x1 - x0, y1 - y0), o);
  const det = detect(lum, o, { lum: lumS, scale, x: x0, y: y0, width: src.width, height: src.height, objectThreshold: coarse.threshold });
  // zurück in die Koordinaten des ganzen Bildes
  det.cx += x0; det.cy += y0;
  det.x0 += x0; det.x1 += x0; det.y0 += y0; det.y1 += y0;
  det.touchesEdge = det.found && (det.x0 <= 0 || det.y0 <= 0 || det.x1 >= src.width - 1 || det.y1 >= src.height - 1);
  det.overexposed *= (lum.width * lum.height) / (src.width * src.height);
  for (const c of [det.disc, det.disc?.moon, det.disc?.moonLoose])
    if (c) { c.cx += x0; c.cy += y0; }
  return det;
}

/** Anteil gesättigter Bildpunkte (≥ 0.98) in der Scheibe */
function saturatedShare(l: Lum, d: { cx: number; cy: number; r: number }): number {
  const step = Math.max(1, Math.round(d.r / 60));
  let n = 0, s = 0;
  for (let y = Math.max(0, Math.floor(d.cy - d.r)); y <= Math.min(l.height - 1, d.cy + d.r); y += step)
    for (let x = Math.max(0, Math.floor(d.cx - d.r)); x <= Math.min(l.width - 1, d.cx + d.r); x += step) {
      if (Math.hypot(x - d.cx, y - d.cy) > d.r) continue;
      n++;
      if (l.data[y * l.width + x] >= 0.98) s++;
    }
  return n ? s / n : 0;
}

/**
 * Helle Bildpunkte (über der Schwelle der Randsuche) ausserhalb der Scheibe (1.15 Radien): Anteil an allen hellen
 * Bildpunkten und Verhältnis zur Fläche der Scheibe
 */
export function brightOutside(l: Lum, d: { cx: number; cy: number; r: number; threshold: number }): { share: number; perDisc: number } {
  const step = Math.max(1, Math.round(Math.min(l.width, l.height) / 600));
  let inB = 0, outB = 0;
  for (let y = 0; y < l.height; y += step)
    for (let x = 0; x < l.width; x += step) {
      if (l.data[y * l.width + x] <= d.threshold) continue;
      if (Math.hypot(x - d.cx, y - d.cy) < 1.15 * d.r) inB++;
      else outB++;
    }
  return { share: outB / Math.max(1, inB + outB), perDisc: (outB * step * step) / (Math.PI * d.r * d.r) };
}

/**
 * Sonnenrand oder – in der Totalität – Mondrand. Ein Mond ringsum in Korona gilt als Totalität,
 * ausser die ganze Sonnenscheibe umschliesst ihn sichtbar (ringförmige Finsternis → Sonnenrand).
 */
function limbFit(lum: Lum, o: ProcessOptions, levels?: { background: number; peak: number }, fSun?: number, fMoon?: number): [DiscFit, "sun" | "moon"] {
  const moon = fitMoonDisc(lum, { factor: fMoon });
  const sun = fitSunDisc(lum, { threshold: o.threshold ?? undefined, levels, factor: fSun });
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
    else if (o.strictSun && det.disc?.plausible === false) Object.assign(r, { accepted: false, reason: msg(o.subject === "moon" ? "noMoon" : "noSun") });
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
      res.reason = radiusReason(res, r, gmed);
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
      res.reason = radiusReason(res, r, med);
    }
  });
}

/**
 * Mit Zoom-Ausgleich: Die Sonnengrösse darf sich sprunghaft ändern (anderer Zoom), muss aber zu mindestens zwei
 * der nächsten Bilder passen (± tolerance) – eine Zoomstufe hat meist mehrere Fotos. Ausreisser – überstrahlt, Wolken,
 * ein falscher Rand – passen zu keinem oder höchstens einem (echte Serie: zwei überstrahlte Bilder mit 4 % Unterschied).
 */
export function rejectIsolatedRadii(results: FrameResult[], window = 12, tolerance = 0.06, support = 2, subject: "sun" | "moon" = "sun"): void {
  const withDisc = results.filter((r) => r.accepted && r.det.disc);
  if (withDisc.length < 5) return;
  const radii = withDisc.map((r) => r.det.disc!.r);
  const bad = withDisc.map((res, i) => {
    // Mond: Ein einzelnes Foto mit anderem Zoom bleibt, wenn der Rand glaubhaft gemessen ist (siehe plausible in
    // detect) und der Mond nicht überstrahlt ist – Handy-Serien haben oft nur ein oder zwei Fotos je Zoomstufe.
    if (subject === "moon" && wellMeasured(res)) return false;
    let n = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(withDisc.length - 1, i + window); j++)
      if (j !== i && Math.abs(radii[j] - radii[i]) <= tolerance * radii[i]) n++;
    return n < support;
  });
  const sorted = [...radii].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  withDisc.forEach((res, i) => {
    if (!bad[i]) return;
    res.accepted = false;
    res.reason = radiusReason(res, radii[i], med, subject);
  });
}

/** Mondrand glaubhaft (eng am Kreis oder weit herum sichtbar) und Mond nicht überstrahlt */
function wellMeasured(res: FrameResult): boolean {
  const d = res.det.disc;
  if (!d || (res.det.overexposedObject ?? 0) >= 0.5) return false;
  return d.plausible ?? ((d.rms <= Math.max(1.5, 0.006 * d.r) && d.visibleLimb >= 0.15) || (d.rms <= Math.max(3, 0.02 * d.r) && d.visibleLimb >= 0.3));
}

/** Zu grosse Scheibe und mindestens die Hälfte davon gesättigt: überstrahlt (zu lange belichtet, Filter verstellt) */
function radiusReason(res: FrameResult, r: number, med: number, subject: "sun" | "moon" = "sun"): string {
  const bloom = r > med && res.det.disc?.kind === "sun" && (res.det.overexposedObject ?? 0) >= 0.5;
  const code = bloom ? "bloom" : "radiusOutlier";
  return msg(subject === "moon" ? (`${code}Moon` as const) : code, Math.round(2 * r), Math.round(2 * med));
}

/**
 * Verwackelte oder unscharfe Bilder: Der Sonnenrand (20–80 %-Anstieg) ist deutlich breiter als im Median der
 * zeitlich nächsten Bilder. Verglichen wird nur innerhalb der Serie – bei überbelichteter Sonne oder Dunst ist der
 * Rand in allen Bildern breit (echte Serie ohne Sonnenfilter: 8 px), dann zählt nur, was davon abweicht.
 */
export function rejectBlurred(results: FrameResult[], stamps: BigInt64Array | null, factor = 1.6, minExcess = 1.5, neighbours = 8, subject: "sun" | "moon" = "sun"): void {
  const tOf = (r: FrameResult) => (stamps ? Number(stamps[r.index] - stamps[0]) / 1e7 : r.index);
  const withW = results.filter((r) => r.accepted && r.det.disc?.kind === "sun" && r.det.disc.limbWidth !== undefined);
  if (withW.length < 5) return;
  // auf gleiche Sonnengrösse bezogen (anderer Zoom: Rand im Bild entsprechend breiter oder schmaler)
  const rs = withW.map((r) => r.det.disc!.r).sort((a, b) => a - b), rMed = rs[rs.length >> 1];
  const widths = withW.map((r) => ({ t: tOf(r), w: (r.det.disc!.limbWidth! * rMed) / r.det.disc!.r }));
  withW.forEach((res, i) => {
    const { t, w } = widths[i];
    const ref = widths
      .filter((_, j) => j !== i)
      .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))
      .slice(0, neighbours)
      .map((x) => x.w)
      .sort((a, b) => a - b);
    const med = ref[ref.length >> 1];
    if (w > factor * med && w > med + minExcess) {
      res.accepted = false;
      res.reason = msg(subject === "moon" ? "blurredMoon" : "blurred", w.toFixed(1), med.toFixed(1));
    }
  });
}

/** Seitenlänge des Ausschnitts nach der Sonnengrösse (gerade, höchstens so gross wie das Bild) */
export function autoCropSize(results: FrameResult[], width: number, height: number): number | null {
  const discs = results.filter((r) => r.accepted && r.det.disc).map((r) => r.det.disc!);
  if (!discs.length) return null;
  const sun = discs.filter((d) => d.kind === "sun").map((d) => d.r).sort((a, b) => a - b);
  const r = (sun.length ? sun : discs.map((d) => d.r).sort((a, b) => a - b))[(sun.length || discs.length) >> 1];
  const totality = discs.some((d) => d.kind === "moon");
  const side = Math.round(r * (totality ? 5 : 2.6));
  return Math.max(64, Math.min(side, width, height)) & ~1;
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
  let [cw, ch] = outSize(src, o);
  const results: FrameResult[] = [];
  // Oberfläche: erstes lesbares Bild ist die Referenz
  let aligner: SurfaceTracker | null = null;

  // Fotoserie mit Teilansichten: nicht jedes Foto ganz auslesen (siehe fastAnalyse)
  const fast = o.fastAnalyse && o.centreMode === "disc" && !!src.hasParts && !o.qualityEnabled && !rotates(o);

  // Durchlauf 1: erkennen und bewerten
  for (let k = 0; k < indices.length; k++) {
    if (shouldCancel()) throw new Error(msg("cancelled"));
    if (fast) {
      try {
        results.push(judge(indices[k], await detectFast(src, indices[k], o), o));
      } catch {
        results.push({ index: indices[k], det: emptyDetection(), accepted: false, reason: msg("unreadable"), score: 0 });
      }
      onProgress("analyse", k + 1, indices.length);
      continue;
    }
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
    if (o.matchSize) rejectIsolatedRadii(results, 12, 0.06, 2, o.subject);
    else rejectRadiusOutliers(results);
    // Mond: In der Totalität ist der Rand weich und verrauscht (lange belichtet, Handy) – nur grobe Fälle verwerfen
    if (o.rejectBlurred) rejectBlurred(results, stamps, o.subject === "moon" ? 2.5 : 1.6, o.subject === "moon" ? 3 : 1.5, 8, o.subject);
    rejectSunInsideTotality(results, stamps);
    if (o.totalitySunCentre) estimateSunInTotality(results, stamps);
    if (o.matchSize) {
      const radii = results.filter((r) => r.accepted && r.det.disc).map((r) => r.det.disc!.r).sort((a, b) => a - b);
      const ref = radii[radii.length >> 1];
      for (const r of results)
        if (r.accepted && r.det.disc && ref) {
          const z = Math.min(5, Math.max(0.2, ref / r.det.disc.r));
          if (Math.abs(z - 1) > 0.02) r.zoom = z;
        }
    }
    if (o.cropAuto) {
      const side = autoCropSize(results, src.width, src.height);
      if (side) {
        o = { ...o, cropEnabled: true, cropWidth: side, cropHeight: side };
        [cw, ch] = [side, side];
      }
    }
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
          const f = colourise(fast ? await src.readRegion!(i, x0, y0, cw, ch) : cropFrame(await src.readFrame(i), x0, y0, cw, ch), o);
          parts.push({ frame: f, exposure: src.exposure!(i)!, dx: cx - o.offsetX - cw / 2 - x0, dy: cy - o.offsetY - ch / 2 - y0 });
        }
        // Ausrichtung relativ zum ersten Bild der Reihe: dessen Lage bleibt (wie bei den Einzelbildern)
        const rx = parts[0].dx, ry = parts[0].dy;
        for (const pt of parts) { pt.dx -= rx; pt.dy -= ry; }
        // Mond im Ausgabebild (erstes Bild der Reihe) – für den Abzug des Himmelslichts
        const d0 = resOf.get(group[0])!.det.disc;
        const [gx0, gy0] = originFor(src, o, resOf.get(group[0])!.det);
        const moon = d0 ? { cx: d0.cx - gx0, cy: d0.cy - gy0, r: d0.r } : undefined;
        await sink(finishFrame(mergeHdr(parts, { srgb: src.kind === "images" && !src.linear, moon }), o), { ...res, hdrGroup: group, origin: [gx0, gy0] }, written.length, ts);
        written.push(res.index);
      }
    } else {
      // schnelle Analyse: nur den Ausschnitt lesen
      const frame = fast ? null : await src.readFrame(res.index);
      if (res.zoom && !rotates(o)) {
        // anderer Zoom: grösseren bzw. kleineren Ausschnitt nehmen und auf die Ausgabegrösse bringen
        const bw = Math.max(2, Math.round(cw / res.zoom)), bh = Math.max(2, Math.round(ch / res.zoom));
        const [cx, cy] = centreOf(src, o, res.det);
        const [x0, y0] = cropOrigin(cx - o.offsetX / res.zoom, cy - o.offsetY / res.zoom, bw, bh, frame ? frame.colorId : src.colorId, !!frame && bayerPatternFor(o, frame) !== null);
        res.origin = [x0, y0];
        res.zoom = cw / bw;
        let out = resize(colourise(frame ? cropFrame(frame, x0, y0, bw, bh) : await src.readRegion!(res.index, x0, y0, bw, bh), o), cw, ch);
        // stark vergrössert (Handy, wenig herangezoomt): leicht weichzeichnen, sonst sieht man die JPEG-Kästchen
        if (res.zoom > 2.5) out = soften(out, 0.45 * res.zoom);
        if (o.strictSun) fillOutside(out, x0, y0, res.zoom, src.width, src.height);
        await sink(finishFrame(out, o), res, written.length, ts);
      } else {
        res.origin = rotates(o) ? undefined : originFor(src, o, res.det);
        const out = frame ? outputCrop(src, frame, o, res.det, cw, ch) : await src.readRegion!(res.index, res.origin![0], res.origin![1], cw, ch);
        if (o.strictSun && res.origin) fillOutside(out, res.origin[0], res.origin[1], 1, src.width, src.height);
        await sink(finishFrame(out, o), res, written.length, ts);
      }
      written.push(res.index);
    }
    onProgress("write", k + 1, chosen.length);
  }

  const [ow, oh] = outputSize(src, o);
  return { frames: results, written, hdrGroups, outWidth: ow, outHeight: oh };
}

/**
 * Einfach-Modus: Liegt die Sonne am Bildrand, reicht der Ausschnitt über das Foto hinaus. Statt schwarz wird dieser
 * Teil in der häufigsten Farbe des Ausschnitts gefüllt (Himmel). x0/y0: Ausschnitt im Foto, zoom: Ausgabe je Fotopixel.
 */
export function fillOutside(f: Frame, x0: number, y0: number, zoom: number, srcW: number, srcH: number): void {
  const p = f.planes, W = f.width, H = f.height;
  const inside = (x: number, y: number) => { const sx = x0 + (x + 0.5) / zoom, sy = y0 + (y + 0.5) / zoom; return sx >= 0 && sy >= 0 && sx < srcW && sy < srcH; };
  if (inside(0, 0) && inside(W - 1, 0) && inside(0, H - 1) && inside(W - 1, H - 1)) return;
  const bg = Array.from({ length: p }, (_, c) => {
    const s: number[] = [];
    for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) if (inside(x, y)) s.push(f.data[(y * W + x) * p + c]);
    return s.sort((a, b) => a - b)[s.length >> 1] ?? 0;
  });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (!inside(x, y)) for (let c = 0; c < p; c++) f.data[(y * W + x) * p + c] = bg[c];
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
