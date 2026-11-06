// Betrachter "SER Player": Abspielen, Marker, Darstellung, Histogramm, Bereich speichern.
// Eigenständiger Nachbau der Funktionen von SER Player (Chris Garry) – kein Code daraus übernommen.
import { defaultDisplay, type DisplayOptions } from "./engine/display";
import type { I18nKey } from "./i18n";
import type { FileInfo, FromWorker, ToWorker } from "./worker";

type Rendered = Extract<FromWorker, { type: "rendered" }>;
type Exported = Extract<FromWorker, { type: "exported" }>;

export interface PlayerContext {
  send: (m: ToWorker) => void;
  L: (key: I18nKey, ...args: (string | number)[]) => string;
  /** Meldungen aus Engine/Worker übersetzen ("@code|…") */
  M: (text: string) => string;
  getInfo: () => FileInfo | null;
  onUseRange: (from: number, to: number) => void;
  onModeChange: (mode: "process" | "view") => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initPlayer(ctx: PlayerContext) {
  const { send, L } = ctx;
  let mode: "process" | "view" = "process";
  let current = 0;
  let playing = false;
  let pingDir = 1;
  let markA: number | null = null;
  let markB: number | null = null;
  let display: DisplayOptions = structuredClone(defaultDisplay);
  display.balance = null; // automatisch
  let seq = 0;
  let pending = false;
  let wanted: number | null = null;
  let nextTimer = 0;
  let lastShown = 0;
  let playFps = 0;
  let exporting = false;
  let exportUrl: string | null = null;
  let lastRendered: Rendered | null = null;
  let lastExport: Exported | null = null;

  const canvas = $<HTMLCanvasElement>("playCanvas");
  const slider = $<HTMLInputElement>("playFrame");
  const stage = $("playStage");

  const count = () => ctx.getInfo()?.frameCount ?? 0;
  const lo = () => Math.min(markA ?? 0, markB ?? count() - 1);
  const hi = () => Math.max(markA ?? 0, markB ?? count() - 1);

  // ---------- Darstellung ----------
  const sliders: [string, keyof DisplayOptions | "r" | "b", number][] = [["dGain", "gain", 100], ["dGamma", "gamma", 100], ["dSat", "saturation", 100], ["dR", "r", 100], ["dB", "b", 100]];
  function readDisplay() {
    const v = (id: string) => Number($<HTMLInputElement>(id).value) / 100;
    display = {
      debayer: $<HTMLSelectElement>("dDebayer").value as DisplayOptions["debayer"],
      gain: v("dGain"),
      gamma: v("dGamma"),
      saturation: v("dSat"),
      balance: $<HTMLInputElement>("dAutoBal").checked ? null : [v("dR"), 1, v("dB")],
    };
    for (const [id] of sliders) $(`${id}V`).textContent = `${v(id).toFixed(2)}×`;
    $<HTMLInputElement>("dR").disabled = $<HTMLInputElement>("dB").disabled = display.balance === null;
    if (!playing) request(current);
  }
  for (const id of ["dDebayer", "dGain", "dGamma", "dSat", "dR", "dB", "dAutoBal"]) $(id).addEventListener("input", readDisplay);
  $("dReset").addEventListener("click", () => {
    $<HTMLSelectElement>("dDebayer").value = "auto";
    for (const [id, , def] of sliders) $<HTMLInputElement>(id).value = String(def);
    $<HTMLInputElement>("dAutoBal").checked = true;
    readDisplay();
  });

  // ---------- Bilder anfordern und zeigen ----------
  function request(i: number) {
    if (!ctx.getInfo()) return;
    current = Math.max(0, Math.min(count() - 1, i));
    slider.value = String(current);
    if (pending) {
      wanted = current;
      return;
    }
    pending = true;
    send({ type: "render", index: current, seq: ++seq, display });
  }

  function draw(m: Rendered) {
    if (canvas.width !== m.width || canvas.height !== m.height) {
      canvas.width = m.width;
      canvas.height = m.height;
      applyZoom();
    }
    canvas.getContext("2d")!.putImageData(new ImageData(m.rgba as Uint8ClampedArray<ArrayBuffer>, m.width, m.height), 0, 0);
    drawHistogram(m);
    if (!display.balance && m.colour) {
      // berechnete Balance in den Reglern anzeigen
      $<HTMLInputElement>("dR").value = String(Math.round(m.balance[0] * 100));
      $<HTMLInputElement>("dB").value = String(Math.round(m.balance[2] * 100));
      $("dRV").textContent = `${m.balance[0].toFixed(2)}×`;
      $("dBV").textContent = `${m.balance[2].toFixed(2)}×`;
    }
    renderDetails(m);
  }

  function renderDetails(m: Rendered) {
    const info = ctx.getInfo();
    if (!info) return;
    const rows: [string, string][] = [
      [L("play.frame"), `${m.index + 1} / ${info.frameCount} · ${m.name}`],
      [L("play.time"), m.time ? m.time.replace("T", " ").slice(0, 23) : "–"],
      [L("play.measuredFps"), info.fps ? `${info.fps.toFixed(2)} fps` : "–"],
      [L("play.renderFps"), playing && playFps ? `${playFps.toFixed(1)} fps` : `${m.ms.toFixed(0)} ms`],
    ];
    $("playDetails").innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  }

  function drawHistogram(m: Rendered) {
    const c = $<HTMLCanvasElement>("histo");
    const w = (c.width = c.clientWidth * devicePixelRatio || 300);
    const h = (c.height = c.clientHeight * devicePixelRatio || 120);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    const series: [Uint32Array, string][] = m.colour
      ? [[m.histogram[0], "rgba(255,80,80,0.75)"], [m.histogram[1], "rgba(80,220,80,0.75)"], [m.histogram[2], "rgba(90,140,255,0.75)"]]
      : [[m.histogram[3], "rgba(220,220,220,0.85)"]];
    // Wurzel-Skala; die äussersten Klassen (schwarzer Hintergrund, Sättigung) nicht zur Skalierung nutzen
    let max = 1;
    for (const [hst] of series) for (let i = 1; i < 255; i++) max = Math.max(max, hst[i]);
    g.globalCompositeOperation = "lighter";
    for (const [hst, col] of series) {
      g.fillStyle = col;
      for (let i = 0; i < 256; i++) {
        const bh = Math.min(1, Math.sqrt(hst[i] / max)) * (h - 2);
        g.fillRect((i / 256) * w, h - bh, Math.ceil(w / 256), bh);
      }
    }
    g.globalCompositeOperation = "source-over";
  }

  // ---------- Abspielen ----------
  function step(): number | null {
    const a = lo(), b = hi();
    const loop = $<HTMLInputElement>("pLoop").checked;
    const dir = $<HTMLSelectElement>("pDir").value;
    if (dir === "fwd") return current + 1 <= b ? current + 1 : loop ? a : null;
    if (dir === "rev") return current - 1 >= a ? current - 1 : loop ? b : null;
    let n = current + pingDir;
    if (n > b || n < a) {
      pingDir = -pingDir;
      n = current + pingDir;
      if (pingDir === 1 && !loop) return null; // eine Runde hin und zurück
    }
    return Math.max(a, Math.min(b, n));
  }

  function setPlaying(on: boolean) {
    playing = on && count() > 1;
    $("pPlay").textContent = playing ? "⏸" : "▶";
    clearTimeout(nextTimer);
    if (playing) {
      if (current < lo() || current > hi()) current = lo();
      lastShown = performance.now();
      if (!pending) scheduleNext();
    }
  }

  function scheduleNext() {
    if (!playing) return;
    const fps = Math.max(1, Math.min(200, Number($<HTMLInputElement>("pFps").value) || 30));
    const due = lastShown + 1000 / fps;
    nextTimer = window.setTimeout(() => {
      const n = step();
      if (n === null) {
        setPlaying(false);
        return;
      }
      const now = performance.now();
      playFps = playFps ? playFps * 0.9 + (1000 / Math.max(1, now - lastShown)) * 0.1 : 1000 / Math.max(1, now - lastShown);
      lastShown = now;
      request(n);
    }, Math.max(0, due - performance.now()));
  }

  $("pPlay").addEventListener("click", () => setPlaying(!playing));
  $("pBack").addEventListener("click", () => { setPlaying(false); request(current - 1); });
  $("pFwd").addEventListener("click", () => { setPlaying(false); request(current + 1); });
  $("pStart").addEventListener("click", () => { setPlaying(false); request(lo()); });
  $("pEnd").addEventListener("click", () => { setPlaying(false); request(hi()); });
  slider.addEventListener("input", () => { setPlaying(false); request(Number(slider.value)); });

  // ---------- Marker ----------
  function updateMarkers() {
    const n = count();
    const bar = $("markerRange");
    if (markA === null && markB === null) {
      bar.style.left = "0";
      bar.style.width = "0";
    } else {
      bar.style.left = `${(lo() / Math.max(1, n - 1)) * 100}%`;
      bar.style.width = `${(Math.max(1, hi() - lo()) / Math.max(1, n - 1)) * 100}%`;
    }
    const info = ctx.getInfo();
    const frames = hi() - lo() + 1;
    $("rangeText").textContent = markA === null && markB === null
      ? L("play.rangeAll", n)
      : L("play.range", lo() + 1, hi() + 1, frames, info?.fps ? (frames / info.fps).toFixed(1) : "–");
  }
  const markIn = () => { markA = current; if (markB !== null && markB < markA) markB = null; updateMarkers(); };
  const markOut = () => { markB = current; if (markA !== null && markA > markB) markA = null; updateMarkers(); };
  $("pMarkIn").addEventListener("click", markIn);
  $("pMarkOut").addEventListener("click", markOut);
  $("pMarkClear").addEventListener("click", () => { markA = markB = null; updateMarkers(); });

  // ---------- Zoom ----------
  function applyZoom() {
    const z = $<HTMLSelectElement>("pZoom").value;
    stage.classList.toggle("zoomed", z !== "fit");
    canvas.style.width = z === "fit" ? "" : `${canvas.width * Number(z) / devicePixelRatio}px`;
  }
  $("pZoom").addEventListener("change", applyZoom);

  // ---------- Speichern ----------
  // Direkt auf die Platte: SER in eine Datei, PNG einzeln in einen Ordner (ohne Grössengrenze durch den Arbeitsspeicher)
  const pickers = window as unknown as {
    showDirectoryPicker?(o: object): Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?(o: object): Promise<FileSystemFileHandle>;
  };
  if (!pickers.showDirectoryPicker || !pickers.showSaveFilePicker) $("exDiskRow").hidden = true;
  $("exRun").addEventListener("click", async () => {
    const info = ctx.getInfo();
    if (!info || exporting) return;
    setPlaying(false);
    const exMode = $<HTMLSelectElement>("exFormat").value as "ser-raw" | "ser-processed" | "png";
    let folder: FileSystemDirectoryHandle | undefined;
    let target: FileSystemFileHandle | undefined;
    if ($<HTMLInputElement>("exToDisk").checked && !$("exDiskRow").hidden) {
      exporting = true; // kein zweiter Klick während des Dialogs
      try {
        if (exMode === "png") folder = await pickers.showDirectoryPicker!({ mode: "readwrite" });
        else
          target = await pickers.showSaveFilePicker!({
            suggestedName: `${info.name}_${lo() + 1}-${hi() + 1}.ser`,
            types: [{ description: "SER", accept: { "application/octet-stream": [".ser"] } }],
          });
      } catch {
        exporting = false; // Dialog abgebrochen
        return;
      }
    }
    exporting = true;
    lastExport = null;
    $<HTMLButtonElement>("exRun").disabled = true;
    const r = $("exResult");
    r.hidden = false;
    r.innerHTML = "<small>…</small>";
    send({ type: "export", from: lo(), to: hi(), mode: exMode, display, folder, target });
  });
  $("useRange").addEventListener("click", () => {
    ctx.onUseRange(lo(), hi());
    const r = $("exResult");
    r.hidden = false;
    r.innerHTML = `<small>${esc(L("play.usedRange", lo() + 1, hi() + 1))}</small>`;
  });

  function renderExport() {
    if (!lastExport) return;
    const e = lastExport;
    if (e.blob && exportUrl)
      $("exResult").innerHTML = `<a class="btn primary" href="${exportUrl}" download="${esc(e.fileName)}">${esc(L("result.save", e.fileName, (e.blob.size / 1048576).toFixed(1)))}</a>`;
    else if (e.savedTo)
      $("exResult").innerHTML = `<strong>${esc(e.fileName.endsWith(".zip") ? L("result.savedToFolder") : L("result.savedToFile", e.savedTo))}</strong>`;
  }

  // ---------- Tastatur ----------
  document.addEventListener("keydown", (e) => {
    if (mode !== "view" || !ctx.getInfo() || (e.target instanceof HTMLElement && e.target.matches("input:not([type=range]), select, textarea"))) return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); setPlaying(!playing); }
    else if (k === "ArrowRight") { e.preventDefault(); setPlaying(false); request(current + 1); }
    else if (k === "ArrowLeft") { e.preventDefault(); setPlaying(false); request(current - 1); }
    else if (k === "Home") { setPlaying(false); request(lo()); }
    else if (k === "End") { setPlaying(false); request(hi()); }
    else if (k === "i" || k === "I") markIn();
    else if (k === "o" || k === "O") markOut();
  });

  // ---------- Modus ----------
  function setMode(m: "process" | "view") {
    mode = m;
    document.querySelectorAll<HTMLButtonElement>("#modeTabs [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    $("player").hidden = m !== "view";
    $("playerPanel").hidden = m !== "view";
    $("viewer").hidden = m === "view";
    $("processPanel").hidden = m === "view";
    if (m === "view") {
      readDisplay();
      updateMarkers();
    } else setPlaying(false);
    ctx.onModeChange(m);
  }
  document.querySelectorAll<HTMLButtonElement>("#modeTabs [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as "process" | "view")));

  return {
    isViewing: () => mode === "view",
    isExporting: () => exporting,
    /** Neue Datei geöffnet; keepMode: Ansicht nicht wechseln (Stapel läuft) */
    opened(info: FileInfo, keepMode = false) {
      setPlaying(false);
      markA = markB = null;
      current = 0;
      slider.max = String(Math.max(0, info.frameCount - 1));
      $<HTMLInputElement>("pFps").value = String(Math.round(Math.min(200, info.fps ?? 30)) || 30);
      $("modeTabs").hidden = false;
      updateMarkers();
      // SER-Videos direkt im Betrachter öffnen (wie SER Player), Bildserien in der Verarbeitung
      if (!keepMode) setMode(info.kind === "images" ? "process" : "view");
    },
    handle(m: FromWorker) {
      if (m.type === "rendered") {
        pending = false;
        if (m.seq === seq) {
          lastRendered = m;
          draw(m);
        }
        if (wanted !== null) {
          const w = wanted;
          wanted = null;
          request(w);
        } else if (playing) scheduleNext();
      } else if (m.type === "exported") {
        exporting = false;
        $<HTMLButtonElement>("exRun").disabled = false;
        if (exportUrl) URL.revokeObjectURL(exportUrl);
        exportUrl = m.blob ? URL.createObjectURL(m.blob) : null;
        lastExport = m;
        renderExport();
      } else if (m.type === "progress" && exporting) {
        $("exResult").innerHTML = `<small>${esc(L("progress.write"))} ${m.done} / ${m.total}</small>`;
      } else if (m.type === "error") {
        exporting = false;
        pending = false;
        $<HTMLButtonElement>("exRun").disabled = false;
        const r = $("exResult");
        r.hidden = false;
        r.innerHTML = `<p class="error">${esc(ctx.M(m.message))}</p>`;
      }
    },
    /** aktuelles Bild neu holen (z. B. Kalibrierung geändert) */
    redraw() {
      if (mode === "view") request(current);
    },
    /** Sprache gewechselt */
    refresh() {
      updateMarkers();
      if (lastRendered) renderDetails(lastRendered);
      renderExport();
    },
  };
}
