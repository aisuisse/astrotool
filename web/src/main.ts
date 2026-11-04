import { defaultOptions, type ProcessOptions } from "./engine/pipeline";
import { MIN_ANCHOR } from "./engine/surface";
import { applyPof, parsePof } from "./engine/pof";
import { defaultTimelapse, type TimelapseOptions } from "./engine/timelapse";
import { defaultMontage, type MontageOptions } from "./engine/montage";
import { isLang, t as translate, tr as translateMsg, type I18nKey, type Lang } from "./i18n";
import { initTools, isDesktopApp } from "./tools";
import { initPlayer } from "./player";
import type { CalKind, FileInfo, FromWorker, OutputFormat, ToWorker } from "./worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: ToWorker) => worker.postMessage(m);

// ---------- Sprache ----------
let lang: Lang = "en";
try {
  const saved = localStorage.getItem("astrotool-lang");
  if (isLang(saved)) lang = saved;
} catch { /* ohne Speicher: Englisch */ }
const L = (key: I18nKey, ...args: (string | number)[]) => translate(lang, key, ...args);
const M = (text: string | undefined) => translateMsg(lang, text);

/** Übersetzt alle festen Texte der Seite (data-i18n*). */
function applyStatic() {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = L(el.dataset.i18n as I18nKey)));
  document.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => (el.innerHTML = L(el.dataset.i18nHtml as I18nKey)));
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = L(el.dataset.i18nTitle as I18nKey)));
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => (el.placeholder = L(el.dataset.i18nPlaceholder as I18nKey)));
  document.querySelector('meta[name="description"]')?.setAttribute("content", L("app.description"));
  $("lang").setAttribute("lang", lang === "en" ? "de" : "en");
}

function setLang(l: Lang) {
  lang = l;
  try { localStorage.setItem("astrotool-lang", l); } catch { /* egal */ }
  applyStatic();
  // dynamische Inhalte neu zeichnen
  if (!info) $("drop").querySelector("strong")!.textContent = L("drop.title");
  updateRunLabel();
  if (info) renderInfo(info);
  if (lastPreview) renderVerdict(lastPreview);
  if (lastDone) renderDone(lastDone);
  if (lastLog) log(lastLog);
  if (lastError) showError(lastError);
  tools.refresh();
  player.refresh();
  renderCal();
  syncAnchor();
}
$("lang").addEventListener("click", () => setLang(lang === "en" ? "de" : "en"));

// ---------- Kalibrierung (Dark / Flat) ----------
type CalState = { stats: Extract<FromWorker, { type: "calibrated" }>["stats"]; error?: string; loading?: boolean };
const calState: Record<CalKind, CalState> = { dark: { stats: null }, flat: { stats: null }, flatDark: { stats: null } };
/** Master passt nicht zur geöffneten Aufnahme (Grösse oder Farbe) – dann nicht anwenden */
function calMismatch(k: CalKind): boolean {
  const st = calState[k].stats;
  return !!(info && st && (st.width !== info.width || st.height !== info.height || st.planes !== (info.colorId >= 100 ? 3 : 1)));
}
function renderCal() {
  for (const row of document.querySelectorAll<HTMLElement>(".calRow")) {
    const k = row.dataset.cal as CalKind, st = calState[k];
    const infoEl = row.querySelector<HTMLElement>(".calInfo")!;
    const mismatch = calMismatch(k);
    infoEl.classList.toggle("error", !!st.error || mismatch);
    infoEl.textContent = st.loading ? L("cal.loading")
      : st.error ? M(st.error)
      : st.stats ? L("cal.info", st.stats.frames, st.stats.width, st.stats.height, st.stats.mean.toFixed(1), st.stats.bitDepth) + (mismatch ? " – " + L("cal.mismatch", info!.width, info!.height) : "")
      : L("cal.none");
    row.querySelector<HTMLElement>("[data-cal-clear]")!.hidden = !st.stats;
    const use = row.querySelector<HTMLInputElement>("[data-cal-use]");
    if (use) {
      use.disabled = !st.stats || mismatch;
      if (mismatch) use.checked = false;
    }
  }
}
function sendCalUse() {
  const use = (k: CalKind) => !!document.querySelector<HTMLInputElement>(`[data-cal-use="${k}"]`)?.checked && !!calState[k].stats && !calMismatch(k)
    && (k !== "flat" || !calMismatch("flatDark"));
  send({ type: "calibration-use", dark: use("dark"), flat: use("flat") });
  requestPreview();
  player.redraw();
}
for (const row of document.querySelectorAll<HTMLElement>(".calRow")) {
  const k = row.dataset.cal as CalKind;
  const input = row.querySelector<HTMLInputElement>("input[type=file]")!;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    calState[k] = { stats: null, loading: true };
    renderCal();
    send({ type: "calibration", kind: k, files, rawMode: $<HTMLSelectElement>("rawMode").value as "raw" | "preview" });
  });
  row.querySelector("[data-cal-clear]")!.addEventListener("click", () => {
    calState[k] = { stats: null };
    const use = row.querySelector<HTMLInputElement>("[data-cal-use]");
    if (use) use.checked = false;
    renderCal();
    send({ type: "calibration", kind: k, files: [] });
    sendCalUse();
  });
  row.querySelector<HTMLInputElement>("[data-cal-use]")?.addEventListener("change", sendCalUse);
}

// ---------- Vorlagen ----------
const presets: Record<string, Partial<ProcessOptions>> = {
  planet: { checkObject: true, minObjectSize: 20, centre: true, cropEnabled: true, cropWidth: 448, cropHeight: 448, qualityEnabled: true, rejectEdgeTouching: false },
  disc: { checkObject: true, minObjectSize: 100, centre: true, cropEnabled: false, qualityEnabled: true, rejectEdgeTouching: false },
  eclipse: { checkObject: true, minObjectSize: 50, centre: true, centreMode: "disc", hdr: true, cropEnabled: true, cropWidth: 1080, cropHeight: 1080, qualityEnabled: false, rejectEdgeTouching: false },
  quality: { checkObject: false, centre: false, cropEnabled: false, qualityEnabled: true },
  // Ausschnitt: 90 % des Bildes (siehe unten) – der Rand wandert mit dem Bildinhalt
  surface: { checkObject: true, centre: true, centreMode: "surface", cropEnabled: true, qualityEnabled: true, rejectEdgeTouching: false },
};
const presetFormat: Record<string, OutputFormat> = { eclipse: "png" };
const presetTimelapse: Record<string, Partial<TimelapseOptions>> = { eclipse: { enabled: true, fps: 8, holdLastSeconds: 2, showTime: true } };

let options: ProcessOptions = structuredClone(defaultOptions);
let timelapse: TimelapseOptions = structuredClone(defaultTimelapse);
let montage: MontageOptions = structuredClone(defaultMontage);
let mtUrl: string | null = null;
let info: FileInfo | null = null;
let current = 0;
let busy = false;
let resultUrl: string | null = null;
let tlUrl: string | null = null;
// zuletzt angezeigte Inhalte – für den Sprachwechsel
let lastPreview: Extract<FromWorker, { type: "preview" }> | null = null;
let lastDone: Extract<FromWorker, { type: "done" }> | null = null;
let lastLog: string | null = null;
let lastError: string | null = null;

// ---------- Optionen ↔ Formular ----------
const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-opt]"));

function readField(el: HTMLInputElement | HTMLSelectElement): unknown {
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
  if (el instanceof HTMLInputElement && el.type === "number") return el.value === "" ? null : Number(el.value);
  return el.value;
}

function syncForm() {
  for (const el of fields) {
    const k = el.dataset.opt!;
    let v: unknown;
    if (k === "method") v = options.quality.method;
    else if (k === "thresholdManual") v = options.threshold === null ? "" : Math.round(options.threshold * 255);
    else v = (options as unknown as Record<string, unknown>)[k];
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
    else el.value = v === null || v === undefined ? "" : String(v);
  }
  // Abhängige Felder ausgrauen
  const card = (opt: string) => document.querySelector(`[data-opt="${opt}"]`)!.closest(".card")!;
  card("checkObject").classList.toggle("disabled", !options.checkObject);
  card("qualityEnabled").classList.toggle("disabled", !options.qualityEnabled);
  for (const k of ["cropWidth", "cropHeight"]) (document.querySelector(`[data-opt="${k}"]`) as HTMLInputElement).disabled = !options.cropEnabled;
  for (const k of ["hdr", "totalitySunCentre"]) (document.querySelector(`[data-opt="${k}"]`) as HTMLInputElement).disabled = options.centreMode !== "disc" || !options.centre;
  syncAnchor();
}

function syncAnchor() {
  const on = options.centreMode === "surface";
  const a = options.surfaceAnchor;
  $("anchorRow").hidden = !on;
  $("anchorText").textContent = a ? L("opt.anchorSet", a.width, a.height, a.x, a.y) : L("opt.anchorHint");
  $<HTMLButtonElement>("anchorClear").hidden = !a;
  $("inCanvas").classList.toggle("drawAnchor", on);
}

for (const el of fields) {
  el.addEventListener("change", () => {
    const k = el.dataset.opt!;
    const v = readField(el);
    if (k === "method") options.quality.method = v as ProcessOptions["quality"]["method"];
    else if (k === "thresholdManual") options.threshold = v === null ? null : Math.min(254, Math.max(1, v as number)) / 255;
    else (options as unknown as Record<string, unknown>)[k] = v ?? 0;
    if ((k === "cropWidth" || k === "cropHeight") && info && info.colorId >= 8 && info.colorId <= 19) {
      (options as unknown as Record<string, number>)[k] &= ~1; // Bayer: gerade Grössen
    }
    document.querySelectorAll("[data-preset]").forEach((b) => b.classList.remove("on"));
    syncForm();
    requestPreview();
  });
}

document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) =>
  btn.addEventListener("click", () => {
    options = { ...structuredClone(defaultOptions), ...presets[btn.dataset.preset!], startFrame: options.startFrame, maxFrames: options.maxFrames };
    if (btn.dataset.preset === "surface" && info) {
      options.cropWidth = Math.floor(info.width * 0.9) & ~1;
      options.cropHeight = Math.floor(info.height * 0.9) & ~1;
    }
    timelapse = { ...timelapse, enabled: false, ...presetTimelapse[btn.dataset.preset!] };
    syncTimelapse();
syncMontage();
    montage = { ...montage, enabled: btn.dataset.preset === "eclipse" };
    syncMontage();
    const fmt = presetFormat[btn.dataset.preset!];
    if (fmt) formatSel.value = fmt;
    else if (info) formatSel.value = info.kind === "images" ? "png" : "ser";
    updateRunLabel();
    document.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b === btn));
    syncForm();
    requestPreview();
  }),
);

// ---------- Datei öffnen ----------
let lastFiles: File[] = [];
// RAW: Rohdaten oder Kamerabild – Serie neu einlesen
$<HTMLSelectElement>("rawMode").addEventListener("change", () => {
  if (lastFiles.length && info?.raw) openFiles(lastFiles);
});
function openFiles(list: FileList | File[] | null | undefined) {
  const files = Array.from(list ?? []);
  if (!files.length) return;
  const sers = files.filter((f) => /\.(ser|avi|mp4|m4v|mov|mkv|webm)$/i.test(f.name));
  if (sers.length > 1 || (sers.length && files.length > 1)) {
    showError(L("err.mixed"));
    return;
  }
  showError(null);
  $("result").hidden = true;
  $("drop").querySelector("strong")!.textContent = L("drop.reading");
  lastFiles = files;
  send({ type: "open", files, bigEndian: false, rawMode: $<HTMLSelectElement>("rawMode").value as "raw" | "preview" });
}

$<HTMLInputElement>("file").addEventListener("change", (e) => {
  openFiles((e.target as HTMLInputElement).files);
});

const drop = $("drop");
for (const target of [drop, document.body]) {
  target.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  target.addEventListener("dragleave", () => drop.classList.remove("over"));
  target.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    openFiles(e.dataTransfer?.files);
  });
}

$<HTMLInputElement>("pof").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  try {
    const { options: o, ignored } = applyPof(options, parsePof(await f.text()));
    options = o;
    syncForm();
    requestPreview();
    showError(null);
    log(`@pof|${f.name}|${ignored.length}`);
  } catch (err) {
    showError((err as Error).message);
  }
});

// ---------- Vorschau ----------
const frameInput = $<HTMLInputElement>("frame");
let previewTimer = 0;
function requestPreview() {
  if (!info) return;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => send({ type: "preview", index: current, options }), 30);
}
function setFrame(i: number) {
  if (!info) return;
  current = Math.max(0, Math.min(info.frameCount - 1, i));
  frameInput.value = String(current);
  $("frameLabel").textContent = `${current + 1} / ${info.frameCount}`;
  requestPreview();
}
frameInput.addEventListener("input", () => setFrame(Number(frameInput.value)));
$("prev").addEventListener("click", () => setFrame(current - 1));
$("next").addEventListener("click", () => setFrame(current + 1));
document.addEventListener("keydown", (e) => {
  if (!info || player.isViewing() || (e.target instanceof HTMLElement && e.target.matches("input, select"))) return;
  if (e.key === "ArrowLeft") setFrame(current - 1);
  if (e.key === "ArrowRight") setFrame(current + 1);
});

// ---------- Eingabe-Ansicht mit Markierungen ----------
let rubber: { x0: number; y0: number; x1: number; y1: number } | null = null;

function drawInput(m: Extract<FromWorker, { type: "preview" }>) {
  const c = draw($("inCanvas"), m.input);
  const lw = Math.max(1, m.input.width / 400);
  c.lineWidth = lw;
  if (m.det.found) {
    c.strokeStyle = cssVar("--obj");
    c.strokeRect(m.det.x0 - 0.5, m.det.y0 - 0.5, m.det.x1 - m.det.x0 + 1, m.det.y1 - m.det.y0 + 1);
    c.beginPath();
    c.moveTo(m.det.cx - 6 * lw, m.det.cy);
    c.lineTo(m.det.cx + 6 * lw, m.det.cy);
    c.moveTo(m.det.cx, m.det.cy - 6 * lw);
    c.lineTo(m.det.cx, m.det.cy + 6 * lw);
    c.stroke();
  }
  if (m.det.disc) {
    c.strokeStyle = cssVar("--disc");
    c.lineWidth = 2 * lw;
    c.beginPath();
    c.arc(m.det.disc.cx, m.det.disc.cy, m.det.disc.r, 0, 2 * Math.PI);
    c.stroke();
    c.lineWidth = lw;
  }
  c.strokeStyle = cssVar("--crop");
  c.setLineDash([6 * lw, 4 * lw]);
  c.strokeRect(m.crop.x0, m.crop.y0, m.crop.width, m.crop.height);
  c.setLineDash([]);
  // Ankerbox (im Referenzbild festgelegt) dort, wohin sich die Stelle in diesem Bild verschoben hat
  const a = options.centreMode === "surface" ? options.surfaceAnchor : null;
  if (a) {
    c.strokeStyle = cssVar("--anchor");
    c.lineWidth = 2 * lw;
    c.strokeRect(a.x + (m.det.surface?.dx ?? 0), a.y + (m.det.surface?.dy ?? 0), a.width, a.height);
  }
  if (rubber) {
    c.strokeStyle = cssVar("--anchor");
    c.lineWidth = 2 * lw;
    c.setLineDash([3 * lw, 3 * lw]);
    c.strokeRect(Math.min(rubber.x0, rubber.x1), Math.min(rubber.y0, rubber.y1), Math.abs(rubber.x1 - rubber.x0), Math.abs(rubber.y1 - rubber.y0));
    c.setLineDash([]);
  }
  $("anchorLegend").hidden = !a;
}

/** Ankerbox: Rechteck in der Eingabe-Ansicht ziehen (nur bei Mittelpunkt „Oberflächenstruktur“) */
function canvasPoint(e: PointerEvent): [number, number] {
  const cv = $<HTMLCanvasElement>("inCanvas"), r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) * cv.width) / r.width, ((e.clientY - r.top) * cv.height) / r.height];
}
{
  const cv = $<HTMLCanvasElement>("inCanvas");
  cv.addEventListener("pointerdown", (e) => {
    if (options.centreMode !== "surface" || !lastPreview || e.button !== 0) return;
    const [x, y] = canvasPoint(e);
    rubber = { x0: x, y0: y, x1: x, y1: y };
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!rubber || !lastPreview) return;
    [rubber.x1, rubber.y1] = canvasPoint(e);
    drawInput(lastPreview);
  });
  const end = (e: PointerEvent) => {
    if (!rubber || !lastPreview) return;
    [rubber.x1, rubber.y1] = canvasPoint(e);
    const r = rubber;
    rubber = null;
    const w = Math.round(Math.abs(r.x1 - r.x0)), h = Math.round(Math.abs(r.y1 - r.y0));
    if (w >= MIN_ANCHOR && h >= MIN_ANCHOR) {
      // gezeichnet im angezeigten Bild → zurück ins Referenzbild (dessen Lage gilt für die Ausrichtung)
      const s = lastPreview.det.surface;
      options.surfaceAnchor = { x: Math.round(Math.min(r.x0, r.x1) - (s?.dx ?? 0)), y: Math.round(Math.min(r.y0, r.y1) - (s?.dy ?? 0)), width: w, height: h };
      syncForm();
      requestPreview();
    } else drawInput(lastPreview);
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", () => {
    rubber = null;
    if (lastPreview) drawInput(lastPreview);
  });
}
$("anchorClear").addEventListener("click", () => {
  options.surfaceAnchor = null;
  syncForm();
  requestPreview();
});

function draw(canvas: HTMLCanvasElement, img: { width: number; height: number; rgba: Uint8ClampedArray }) {
  canvas.width = img.width;
  canvas.height = img.height;
  const c = canvas.getContext("2d")!;
  c.putImageData(new ImageData(img.rgba as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function colourLabel(id: number): string {
  if (id === 0) return L("colour.mono");
  if (id === 100) return L("colour.rgb");
  if (id === 101) return L("colour.bgr");
  const bayer = ({ 8: "RGGB", 9: "GRBG", 10: "GBRG", 11: "BGGR" } as Record<number, string>)[id];
  return bayer ? L("colour.bayer", bayer) : L("colour.unknown", id);
}

function renderInfo(i: FileInfo) {
  const locale = lang === "de" ? "de-CH" : "en-GB";
  const rows: [string, string][] = [
    [L("info.size"), `${i.width} × ${i.height}`],
    [i.kind === "images" ? L("info.images") : L("info.frames"), i.frameCount.toLocaleString(locale)],
    [L("info.colour"), colourLabel(i.colorId)],
    [L("info.bitDepth"), `${i.bitDepth} bit`],
  ];
  if (i.fps) rows.push([L("info.frameRate"), `${i.fps.toFixed(1)} fps`]);
  const ts = (s: string) => s.replace("T", " ").slice(0, 19);
  if (i.kind === "images" && i.firstTimestamp && i.lastTimestamp) {
    rows.push([L("info.captureCamera"), `${ts(i.firstTimestamp)} – ${ts(i.lastTimestamp).slice(11)}`]);
  } else if (i.firstTimestamp) rows.push([L("info.captureUtc"), ts(i.firstTimestamp)]);
  if (i.raw) rows.push([L("info.raw"), i.rawFormat === "JPEG" ? L("info.rawJpeg") + (i.rawHint ? ` – ${L("info.rawDngHint", i.rawHint)}${i.rawHint === "RAF" ? L("info.rawRafHint") : ""}` : "") : `${i.rawFormat} · ${L("info.rawSensor")}`]);
  if (i.instrument) rows.push([L("info.camera"), i.instrument]);
  if (i.telescope) rows.push([L("info.telescope"), i.telescope]);
  if (i.observer) rows.push([L("info.observer"), i.observer]);
  $("info").innerHTML = rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderVerdict(m: Extract<FromWorker, { type: "preview" }>) {
  const v = $("verdict");
  v.className = `pill ${m.accepted ? "ok" : "bad"}`;
  const d = m.det.disc;
  const discNote = d ? L(d.kind === "moon" ? "verdict.moon" : "verdict.disc", (2 * d.r).toFixed(0), (d.visibleLimb * 100).toFixed(0)) : "";
  v.textContent = m.accepted
    ? [options.qualityEnabled ? L("verdict.quality", m.score.toPrecision(3)) : L("verdict.used"), discNote].filter(Boolean).join(" · ")
    : L("verdict.rejected", M(m.reason));
}

// ---------- Verarbeitung ----------
$("run").addEventListener("click", async () => {
  if (!info || busy) return;
  busy = true;
  showError(null);
  $("result").hidden = true;
  $<HTMLButtonElement>("run").disabled = true;
  $("cancel").hidden = false;
  ($("bar").parentElement as HTMLElement).hidden = false;
  const format = formatSel.value as OutputFormat;
  // Direkt auf die Platte: Einzelbilder in einen Ordner, SER in eine Datei – geschrieben während der Verarbeitung,
  // ohne Grössengrenze durch den Arbeitsspeicher
  let folder: FileSystemDirectoryHandle | undefined;
  let target: FileSystemFileHandle | undefined;
  const w = window as unknown as {
    showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker(o: object): Promise<FileSystemFileHandle>;
  };
  if (toFolder.checked && !toFolder.disabled) {
    try {
      if (isImageFormat(format)) folder = await w.showDirectoryPicker({ mode: "readwrite" });
      else if (format === "ser")
        target = await w.showSaveFilePicker({
          suggestedName: `${info.name}_astro.ser`,
          types: [{ description: "SER", accept: { "application/octet-stream": [".ser"] } }],
        });
    } catch {
      finish();
      return;
    }
  }
  send({ type: "process", options, format, folder, target, timelapse, montage, nativeHevc: isDesktopApp() });
});
$("cancel").addEventListener("click", () => send({ type: "cancel" }));

function finish() {
  busy = false;
  $<HTMLButtonElement>("run").disabled = !info;
  $("cancel").hidden = true;
  ($("bar").parentElement as HTMLElement).hidden = true;
}

/** Fehler anzeigen; Codes aus Engine/Worker ("@code|…") werden übersetzt. */
function showError(text: string | null) {
  lastError = text;
  const el = $("error");
  el.hidden = !text;
  el.textContent = text ? (text === "@cancelled" ? L("err.cancelled") : M(text)) : "";
}

/** Hinweis im Ergebnisbereich. "@pof|name|n" wird übersetzt. */
function log(text: string) {
  lastLog = text;
  lastDone = null;
  const el = $("result");
  el.hidden = false;
  const [code, a, b] = text.split("|");
  el.innerHTML = `<small>${escapeHtml(code === "@pof" ? L("pof.loaded", a, b) : text)}</small>`;
}

function drawScores(canvas: HTMLCanvasElement, scores: number[]) {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const c = canvas.getContext("2d")!;
  if (!scores.length) return;
  const max = Math.max(...scores), min = Math.min(...scores);
  c.strokeStyle = cssVar("--accent");
  c.lineWidth = 1.5 * devicePixelRatio;
  c.beginPath();
  scores.forEach((s, i) => {
    const x = (i / Math.max(1, scores.length - 1)) * w;
    const y = h - 4 - ((s - min) / (max - min || 1)) * (h - 8);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
}

const formatSel = $<HTMLSelectElement>("format");
const isImageFormat = (f: OutputFormat) => f !== "ser" && f !== "none";
const toFolder = $<HTMLInputElement>("toFolder");
if (!("showDirectoryPicker" in window && "showSaveFilePicker" in window)) $("folderRow").hidden = true;
function updateRunLabel() {
  const f = formatSel.value as OutputFormat;
  $("run").textContent = f === "ser" || f === "none" ? L(f === "ser" ? "run.ser" : "run.none") : L("run.image", L(`fmt.${f}`));
  toFolder.disabled = f === "none";
  const lbl = $("toFolderLabel"), key = f === "ser" ? "opt.toFile" : "opt.toFolder";
  lbl.dataset.i18n = key; // bleibt beim Sprachwechsel richtig
  lbl.textContent = L(key);
}
formatSel.addEventListener("change", updateRunLabel);

// ---------- Zeitraffer ----------
const tlFields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-tl]"));
function syncTimelapse() {
  for (const el of tlFields) {
    const v = (timelapse as unknown as Record<string, unknown>)[el.dataset.tl!];
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
    else el.value = String(v ?? "");
  }
  $("tlCard").classList.toggle("disabled", !timelapse.enabled);
}
for (const el of tlFields) {
  el.addEventListener("change", () => {
    const k = el.dataset.tl!;
    let v: unknown = readField(el);
    if (k === "fps") v = Math.min(60, Math.max(1, Number(v) || 10));
    if (k === "holdLastSeconds" || k === "width") v = Math.max(0, Number(v) || 0);
    (timelapse as unknown as Record<string, unknown>)[k] = v;
    syncTimelapse();
  });
}

// ---------- Phasenmontage ----------
const mtFields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-mt]"));
function syncMontage() {
  for (const el of mtFields) {
    const v = (montage as unknown as Record<string, unknown>)[el.dataset.mt!];
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
    else el.value = String(v ?? "");
  }
  $("mtCard").classList.toggle("disabled", !montage.enabled);
}
for (const el of mtFields) {
  el.addEventListener("change", () => {
    const k = el.dataset.mt!;
    let v: unknown = readField(el);
    if (k === "count") v = Math.min(40, Math.max(2, Number(v) || 11));
    if (k === "width") v = Math.min(8000, Math.max(800, Number(v) || 3840));
    (montage as unknown as Record<string, unknown>)[k] = v;
    syncMontage();
    updateRunLabel();
  });
}

function mtHtml(m: Extract<FromWorker, { type: "done" }>): string {
  if (m.montageError) return `<p class="error">${escapeHtml(L("result.montageError", M(m.montageError)))}</p>`;
  if (!m.montage || !mtUrl) return "";
  const mt = m.montage;
  return `<img class="montage" src="${mtUrl}" alt="" />
    <a class="btn primary" href="${mtUrl}" download="${escapeHtml(mt.fileName)}">${escapeHtml(L("result.save", mt.fileName, (mt.blob.size / 1048576).toFixed(1)))}</a>
    <small>${escapeHtml(L("result.montage", mt.frames, mt.width, mt.height))}</small>`;
}

function tlHtml(m: Extract<FromWorker, { type: "done" }>): string {
  if (m.timelapseError) return `<p class="error">${escapeHtml(L("result.timelapseError", M(m.timelapseError)))}</p>`;
  if (!m.timelapse || !tlUrl) return "";
  const tl = m.timelapse;
  const preview = tl.blob.type.startsWith("video/")
    ? `<video src="${tlUrl}" controls loop muted autoplay playsinline></video>`
    : `<img src="${tlUrl}" alt="" />`;
  return `${preview}
    <a class="btn primary" href="${tlUrl}" download="${escapeHtml(tl.fileName)}">${escapeHtml(L("result.save", tl.fileName, (tl.blob.size / 1048576).toFixed(1)))}</a>
    <small>${escapeHtml(L("result.timelapse", tl.codec, tl.frames, tl.seconds.toFixed(1)))}</small>
    ${tl.fallback ? `<small class="warn">${escapeHtml(L("result.hevcFallback"))}</small>` : ""}
    ${tl.blob.type === "video/mp4" ? `<small>${escapeHtml(L("result.shareHint"))}</small>` : ""}`;
}

function renderDone(m: Extract<FromWorker, { type: "done" }>) {
  const el = $("result");
  el.hidden = false;
  const rejected = m.rejected.length
    ? `<details><summary>${escapeHtml(L("result.rejected", m.rejected.length))}</summary><small>${m.rejected.map((r) => `${escapeHtml(r.name)}: ${escapeHtml(M(r.reason))}`).join("<br>")}</small></details>`
    : `<small>${escapeHtml(L("result.rejected", 0))}</small>`;
  const summary = L("result.summary", m.written, m.outWidth, m.outHeight, m.seconds.toFixed(1)) +
    (m.discStats ? " · " + L("result.meanDisc", (2 * m.discStats.meanR).toFixed(1)) : "") +
    (m.totality ? " · " + L("result.totality", m.totality.frames, m.totality.hdrGroups) : "");
  const hasScores = m.scores.some((s) => s > 0);
  el.innerHTML = `
    ${m.blob && resultUrl ? `<a class="btn primary" href="${resultUrl}" download="${escapeHtml(m.fileName)}">${escapeHtml(L("result.save", m.fileName, (m.blob.size / 1048576).toFixed(1)))}</a>` : m.savedToFolder ? `<strong>${escapeHtml(L("result.savedToFolder"))}</strong>` : m.savedToFile ? `<strong>${escapeHtml(L("result.savedToFile", m.savedToFile))}</strong>` : ""}
    ${tlHtml(m)}
    ${mtHtml(m)}
    <small>${escapeHtml(summary)}</small>
    ${rejected}
    ${hasScores ? `<small>${escapeHtml(L("result.qualityChart"))}</small><canvas id="chart"></canvas>` : ""}`;
  if (hasScores) drawScores($("chart"), m.scores);
}

/** Leitet Aufrufe des Workers an die Windows-App (Tauri) weiter und schickt die Antwort zurück. */
async function relayNative(m: Extract<FromWorker, { type: "native" }>) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    let result: unknown;
    if (m.op === "hevc_frame") {
      await invoke("hevc_frame", new Uint8Array(m.data!.buffer), { headers: { repeat: String(m.repeat ?? 1) } });
    } else if (m.op === "hevc_finish") {
      result = await invoke<ArrayBuffer>("hevc_finish");
    } else {
      result = await invoke(m.op, m.args);
    }
    worker.postMessage({ type: "native-reply", id: m.id, ok: true, result } satisfies ToWorker, result instanceof ArrayBuffer ? [result] : []);
  } catch (e) {
    send({ type: "native-reply", id: m.id, ok: false, error: String(e) });
  }
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "native":
      void relayNative(m);
      break;
    case "rendered":
    case "exported":
      player.handle(m);
      break;
    case "opened": {
      info = m.info;
      // Ankerbox gehört zur vorigen Aufnahme
      options.surfaceAnchor = null;
      syncAnchor();
      // geladene Master an die neue Aufnahme anpassen (passt die Grösse nicht: nicht anwenden)
      renderCal();
      sendCalUse();
      lastPreview = null;
      lastDone = null;
      formatSel.value = info.kind === "images" ? "png" : "ser";
      updateRunLabel();
      // Debayer-Optionen nur bei Rohdaten (Mono/Bayer) – JPG/PNG sind schon farbig
      document.querySelectorAll<HTMLElement>(".colourRow").forEach((el) => (el.hidden = info!.colorId >= 100));
      document.querySelectorAll<HTMLElement>(".rawRow").forEach((el) => (el.hidden = !info!.raw));
      $("drop").hidden = true;
      $("viewer").hidden = false;
      frameInput.max = String(info.frameCount - 1);
      $<HTMLButtonElement>("run").disabled = false;
      renderInfo(info);
      document.title = `${info.name} – Astrotool`;
      setFrame(0);
      player.opened(info);
      break;
    }
    case "preview": {
      lastPreview = m;
      drawInput(m);
      draw($("outCanvas"), m.output);
      $("inLabel").textContent = `${m.name}${m.time ? " · " + m.time.slice(11, 19) : ""}`;
      renderVerdict(m);
      break;
    }
    case "calibrated": {
      calState[m.kind] = { stats: m.stats, error: m.error };
      // frisch geladen: gleich anwenden
      const use = document.querySelector<HTMLInputElement>(`[data-cal-use="${m.kind}"]`);
      if (use && m.stats) use.checked = true;
      renderCal();
      sendCalUse();
      ($("bar").parentElement as HTMLElement).hidden = busy ? false : true;
      break;
    }
    case "progress": {
      if (player.isExporting()) {
        player.handle(m);
        break;
      }
      const pct = m.total ? (m.done / m.total) * 100 : 0;
      $("bar").style.width = `${pct}%`;
      $("progressLabel").textContent = `${L(`progress.${m.phase}` as I18nKey)} ${m.done} / ${m.total}`;
      break;
    }
    case "done": {
      finish();
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      if (tlUrl) URL.revokeObjectURL(tlUrl);
      resultUrl = m.blob ? URL.createObjectURL(m.blob) : null;
      tlUrl = m.timelapse ? URL.createObjectURL(m.timelapse.blob) : null;
      if (mtUrl) URL.revokeObjectURL(mtUrl);
      mtUrl = m.montage ? URL.createObjectURL(m.montage.blob) : null;
      lastDone = m;
      lastLog = null;
      renderDone(m);
      break;
    }
    case "error":
      if (player.isViewing()) {
        player.handle(m);
        break;
      }
      finish();
      if (!info) $("drop").querySelector("strong")!.textContent = L("drop.title");
      showError(m.message);
      break;
  }
};

// ---------- Nachtmodus ----------
const night = $("night");
function setNight(on: boolean) {
  document.documentElement.dataset.night = on ? "1" : "0";
  night.setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("astrotool-night", on ? "1" : "0"); } catch { /* ohne Speicher weiter */ }
  requestPreview();
}
night.addEventListener("click", () => setNight(document.documentElement.dataset.night !== "1"));
try { if (localStorage.getItem("astrotool-night") === "1") setNight(true); } catch { /* egal */ }

// ---------- Über Astrotool ----------
declare const __APP_VERSION__: string;
const aboutDialog = $<HTMLDialogElement>("aboutDialog");
$("aboutVersion").textContent = __APP_VERSION__;
$("aboutBtn").addEventListener("click", () => aboutDialog.showModal());
$("aboutClose").addEventListener("click", () => aboutDialog.close());
aboutDialog.addEventListener("click", (e) => { if (e.target === aboutDialog) aboutDialog.close(); });

// ---------- Betrachter (SER Player) ----------
const player = initPlayer({
  send,
  L,
  M: (text) => M(text),
  getInfo: () => info,
  onUseRange: (from, to) => {
    options.startFrame = from;
    options.maxFrames = to - from + 1;
    syncForm();
  },
  onModeChange: (mode) => {
    if (mode === "process") requestPreview();
  },
});

// ---------- Tools & Setup ----------
const tools = initTools(() => lang);

applyStatic();
renderCal();
updateRunLabel();
syncForm();
syncTimelapse();
