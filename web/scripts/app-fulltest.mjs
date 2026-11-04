// Vollständiger Testdurchgang der Windows-App: startet astrotool.exe mit WebView2-Debug-Port und
// bedient die Oberfläche wie ein Mensch. Prüft jede Vorlage, den Betrachter, Import, Sprache und Dialoge.
// Ergebnisse (Videos, Bericht) landen im Ausgabeordner.
//
// Aufruf:
//   node scripts/app-fulltest.mjs <astrotool.exe> <ausgabeordner> --ser <klein.ser> --images <bilderordner> [--big <gross.ser>] [--totality <ordner>] [--avi <ordner>]
// Testbilder für --totality: node scripts/make-totality-testset.mjs <ordner>
// --cal <ordner>: dark.ser, flat.ser, bias.ser passend zu --ser (node scripts/make-calibration-testset.mjs <klein.ser> <ordner>)
// --avi <ordner>: saturn_y800.avi, saturn_mjpeg.avi, optional saturn_big.avi (mit FFmpeg erzeugt, siehe docs/testdaten.md)
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const exe = args[0], outDir = args[1] && resolve(args[1]);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const smallSer = opt("--ser"), imageDir = opt("--images"), bigSer = opt("--big"), totalityDir = opt("--totality"), aviDir = opt("--avi"), rawDir = opt("--raw"), calDir = opt("--cal"), fitsDir = opt("--fits"), fitsCube = opt("--fitscube"), surfaceSer = opt("--surface");
if (!exe || !outDir || !smallSer || !imageDir) {
  console.error("Aufruf: node scripts/app-fulltest.mjs <astrotool.exe> <ausgabeordner> --ser <klein.ser> --images <bilderordner> [--big <gross.ser>]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const PORT = 9333;
const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const listImages = (dir) => readdirSync(dir).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).map((f) => resolve(join(dir, f)));
const images = readdirSync(imageDir).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).map((f) => resolve(join(imageDir, f)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=http://127.0.0.1:${PORT}` },
  stdio: "ignore",
});
let appExit = null;
app.on("exit", (code, signal) => { appExit = `App beendet (Code ${code}, Signal ${signal})`; console.log(`
!! ${appExit}`); });

let ws, seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
async function ev(expression, timeoutMs = 120_000) {
  if (appExit) throw new Error(appExit);
  const r = await Promise.race([
    cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => { throw new Error(appExit ?? "Seite antwortet nicht (Zeitüberschreitung)"); }),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function setFiles(selector, files) {
  files = files.map((f) => resolve(f));
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector });
  await cdp("DOM.setFileInputFiles", { nodeId, files });
}
async function waitFor(expr, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Zeitüberschreitung: ${what}`);
    await sleep(300);
  }
}

// Hilfsfunktionen in der Seite
const PAGE_HELPERS = `
window.__t = {
  set(sel, v) { const el = document.querySelector(sel); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input')); },
  async blobInfo(a) {
    const b = await (await fetch(a.href)).blob();
    const r = { name: a.download, bytes: b.size };
    if (/\\.ser$/i.test(a.download)) {
      const v = new DataView(await b.slice(0, 178).arrayBuffer());
      Object.assign(r, { colorId: v.getInt32(18, true), width: v.getInt32(26, true), height: v.getInt32(30, true), bitDepth: v.getInt32(34, true), frames: v.getInt32(38, true) });
    }
    if (/\\.zip$/i.test(a.download)) {
      const v = new DataView(await b.slice(b.size - 22).arrayBuffer());
      r.entries = v.getUint16(10, true);
      const h = new DataView(await b.slice(0, 30).arrayBuffer());
      r.first = await b.slice(30, 30 + h.getUint16(26, true)).text();
      const head = new Uint8Array(await b.slice(30 + h.getUint16(26, true) + h.getUint16(28, true), 30 + h.getUint16(26, true) + h.getUint16(28, true) + 30).arrayBuffer());
      r.magic = String.fromCharCode(...head.slice(0, 8)).replace(/[^ -~]/g, '.');
    }
    return r;
  },
  async results() { return Promise.all([...document.querySelectorAll('#result a[download]')].map((a) => this.blobInfo(a))); },
  async base64(sel, re) {
    const a = [...document.querySelectorAll(sel)].find((x) => new RegExp(re).test(x.download));
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
  seek(i) { const s = document.getElementById('playFrame'); s.value = i; s.dispatchEvent(new Event('input')); },
  key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); },
};
true`;

const report = [];
// --only <regex>: nur passende Tests (z. B. zum Wiederholen eines einzelnen Tests)
const only = opt("--only") && new RegExp(opt("--only"), "i");
async function test(name, fn) {
  if (only && !only.test(name)) return;
  const t0 = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const details = await fn();
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK (${s} s)`);
    report.push({ name, ok: true, seconds: Number(s), details });
  } catch (e) {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FEHLER (${s} s): ${e.message}`);
    let shot = null;
    try {
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      shot = join(outDir, `fehler_${report.length + 1}.png`);
      writeFileSync(shot, Buffer.from(data, "base64"));
    } catch { /* egal */ }
    report.push({ name, ok: false, seconds: Number(s), error: e.message, screenshot: shot });
  }
}
function check(cond, msg) { if (!cond) throw new Error(msg); }

async function openFiles(files, titleStart) {
  await setFiles("#file", files);
  await waitFor(`document.title.startsWith(${JSON.stringify(titleStart)}) && !document.getElementById('modeTabs').hidden || (document.title.startsWith(${JSON.stringify(titleStart)}) && !document.getElementById('viewer').hidden)`, 120_000, "Datei öffnen");
  await sleep(1500);
}
async function processMode() {
  await ev(`document.querySelector('[data-mode="process"]')?.click(); true`);
  await sleep(800);
}
async function runAndWait(timeoutMs) {
  await ev(`document.getElementById('result').hidden = true; document.getElementById('run').click(); true`);
  await sleep(500);
  const t0 = Date.now();
  for (;;) {
    const st = await ev(`({ done: !document.getElementById('result').hidden, err: document.getElementById('error').innerText })`);
    if (st.err) throw new Error("App meldet: " + st.err);
    if (st.done) break;
    if (Date.now() - t0 > timeoutMs) throw new Error("Zeitüberschreitung bei der Verarbeitung");
    await sleep(1000);
  }
  return { seconds: (Date.now() - t0) / 1000, text: await ev(`document.getElementById('result').innerText`), files: await ev(`__t.results()`) };
}
async function saveVideo(file) {
  const b64 = await ev(`__t.base64('#result a[download]', '\\\\.(mp4|webm|gif)$')`);
  const p = join(outDir, file);
  writeFileSync(p, Buffer.from(b64, "base64"));
  let probe = null;
  try {
    probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_tag_string,width,height,avg_frame_rate,nb_frames:format=duration:format_tags=creation_time,title", "-of", "json", p]).toString());
  } catch { /* ffprobe fehlt */ }
  return { file: p, probe };
}

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* noch nicht bereit */ }
  }
  if (!target) throw new Error("WebView2-Debug-Schnittstelle nicht erreichbar – läuft noch eine Astrotool-Instanz oder hängen msedgewebview2-Prozesse mit dem Datenordner ch.aisuisse.astrotool?");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  await cdp("Page.enable");
  await sleep(1500);
  await ev(PAGE_HELPERS);

  await test("Start: Desktop-App erkannt, Version", async () => {
    const r = await ev(`({ tauri: '__TAURI_INTERNALS__' in window, ua: navigator.userAgent, title: document.title })`);
    check(r.tauri, "Tauri-Schnittstelle fehlt");
    await ev(`document.getElementById('aboutBtn').click(); true`);
    await sleep(500);
    const about = await ev(`document.getElementById('aboutVersion').innerText`);
    await ev(`document.getElementById('aboutClose').click(); true`);
    check(about.includes(appVersion), `Über-Dialog zeigt "${about}"`);
    return { ...r, about };
  });

  await test("Sprache umschalten (EN ↔ DE)", async () => {
    const before = await ev(`({ btn: document.getElementById('lang').innerText, run: document.getElementById('run').innerText })`);
    await ev(`document.getElementById('lang').click(); true`);
    await sleep(400);
    const after = await ev(`({ btn: document.getElementById('lang').innerText, run: document.getElementById('run').innerText })`);
    check(after.run !== before.run, "Beschriftung hat sich nicht geändert");
    // Englisch als Standard für den Rest des Tests
    if (!/English|Englisch/.test(after.btn)) { /* ok */ }
    const now = await ev(`document.documentElement.lang`);
    if (now === "de") { await ev(`document.getElementById('lang').click(); true`); await sleep(300); }
    return { before, after, end: await ev(`document.documentElement.lang`) };
  });

  await test("Werkzeuge & Einrichtung (FFmpeg-Status nativ)", async () => {
    await ev(`document.getElementById('toolsBtn').click(); true`);
    await waitFor(`/ffmpeg/i.test(document.getElementById('toolsBody').innerText)`, 15_000, "Werkzeugliste");
    await sleep(2500);
    const text = await ev(`document.getElementById('toolsBody').innerText`);
    await ev(`document.getElementById('toolsClose').click(); true`);
    return { text: text.slice(0, 600) };
  });

  await test("Kaputte AVI-Datei: verständliche Meldung", async () => {
    const avi = join(outDir, "dummy.avi");
    writeFileSync(avi, Buffer.alloc(1024));
    await ev(`document.getElementById('error').innerText = ''; true`);
    await setFiles("#file", [avi]);
    await sleep(1500);
    const r = await ev(`({ err: document.getElementById('error').innerText })`);
    check(/AVI/.test(r.err), `Meldung: ${JSON.stringify(r)}`);
    return r;
  });

  // ---------- SER: Betrachter ----------
  await test("SER öffnen → Betrachter", async () => {
    await openFiles([resolve(smallSer)], "saturn600");
    const r = await ev(`({ player: !document.getElementById('player').hidden, details: document.getElementById('playDetails').innerText.replace(/\\n/g, ' | ').slice(0, 400) })`);
    check(r.player, "Betrachter nicht sichtbar");
    return r;
  });

  await test("Betrachter: Wiedergabe-Geschwindigkeit (Ziel 30 fps)", async () => {
    await ev(`__t.set('#pFps', 30); true`);
    await ev(`document.getElementById('playFrame').value = 0; document.getElementById('playFrame').dispatchEvent(new Event('input')); document.getElementById('pPlay').click(); true`);
    await sleep(1000);
    const a = await ev(`Number(document.getElementById('playFrame').value)`);
    await sleep(5000);
    const b = await ev(`Number(document.getElementById('playFrame').value)`);
    await ev(`document.getElementById('pPlay').click(); true`);
    const fps = (b - a) / 5;
    check(fps > 5, `nur ${fps.toFixed(1)} Bilder/s`);
    return { fps: Number(fps.toFixed(1)) };
  });

  await test("Betrachter: Marker per Tastatur und Bereich als SER (roh) speichern", async () => {
    await ev(`__t.seek(100); true`);
    await sleep(600);
    await ev(`__t.key('i'); true`);
    await ev(`__t.seek(249); true`);
    await sleep(600);
    await ev(`__t.key('o'); true`);
    const range = await ev(`document.getElementById('rangeText').innerText`);
    await ev(`__t.set('#exFormat', 'ser-raw'); document.getElementById('exResult').innerHTML = ''; document.getElementById('exRun').click(); true`);
    await waitFor(`!!document.querySelector('#exResult a[download]')`, 120_000, "Export");
    const f = await ev(`__t.blobInfo(document.querySelector('#exResult a[download]'))`);
    check(f.frames === 150 && f.colorId === 8, `Export: ${JSON.stringify(f)}`);
    check(f.bytes === 178 + 150 * 640 * 640 + 150 * 8, `Grösse ${f.bytes}`);
    return { range, file: f };
  });

  await test("Betrachter: Bereich als SER in Farbe und als PNG speichern", async () => {
    await ev(`__t.set('#exFormat', 'ser-processed'); document.getElementById('exResult').innerHTML = ''; document.getElementById('exRun').click(); true`);
    await waitFor(`!!document.querySelector('#exResult a[download]')`, 180_000, "Export farbig");
    const ser = await ev(`__t.blobInfo(document.querySelector('#exResult a[download]'))`);
    check(ser.colorId === 100 && ser.frames === 150, `SER farbig: ${JSON.stringify(ser)}`);
    await ev(`__t.set('#exFormat', 'png'); document.getElementById('exResult').innerHTML = ''; document.getElementById('exRun').click(); true`);
    await waitFor(`!!document.querySelector('#exResult a[download]')`, 300_000, "Export PNG");
    const zip = await ev(`__t.blobInfo(document.querySelector('#exResult a[download]'))`);
    check(zip.entries === 150, `ZIP: ${JSON.stringify(zip)}`);
    return { ser, zip };
  });

  await test("Betrachter: Bereich direkt auf die Platte (SER-Datei und PNG-Ordner)", async () => {
    // Statt der Dialoge Datei bzw. Ordner im privaten Speicher der Seite (OPFS)
    await ev(`(() => {
      window.__origSave = window.showSaveFilePicker; window.__origDir = window.showDirectoryPicker;
      window.showSaveFilePicker = async (o) => { window.__suggested = o.suggestedName; const d = await navigator.storage.getDirectory(); return d.getFileHandle('astrotool-view-test.ser', { create: true }); };
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('astrotool-view-png', { create: true });
      __t.set('#exToDisk', true); __t.set('#exFormat', 'ser-raw'); document.getElementById('exResult').innerHTML = ''; document.getElementById('exRun').click();
      return true; })()`);
    await waitFor(`!!document.querySelector('#exResult strong')`, 120_000, "Export SER auf Platte");
    await ev(`__t.set('#exFormat', 'png'); document.getElementById('exResult').innerHTML = ''; document.getElementById('exRun').click(); true`);
    await waitFor(`!!document.querySelector('#exResult strong')`, 300_000, "Export PNG in Ordner");
    const disk = await ev(`(async () => {
      const d = await navigator.storage.getDirectory();
      const f = await (await d.getFileHandle('astrotool-view-test.ser')).getFile();
      const v = new DataView(await f.slice(0, 178).arrayBuffer());
      const dir = await d.getDirectoryHandle('astrotool-view-png');
      let pngs = 0, magic = '';
      for await (const [name, h] of dir.entries()) { pngs++; if (!magic) magic = Array.from(new Uint8Array(await (await h.getFile()).slice(1, 4).arrayBuffer()), (c) => String.fromCharCode(c)).join('') + ':' + name; }
      const out = { bytes: f.size, frames: v.getInt32(38, true), colorId: v.getInt32(18, true), suggested: window.__suggested, pngs, magic, downloads: document.querySelectorAll('#exResult a[download]').length, text: document.getElementById('exResult').innerText };
      await d.removeEntry('astrotool-view-test.ser'); await d.removeEntry('astrotool-view-png', { recursive: true });
      window.showSaveFilePicker = window.__origSave; window.showDirectoryPicker = window.__origDir; __t.set('#exToDisk', false);
      return out; })()`);
    check(disk.frames === 150 && disk.colorId === 8 && disk.bytes === 178 + 150 * 640 * 640 + 150 * 8, `SER: ${JSON.stringify(disk)}`);
    check(/_101-250\.ser$/.test(disk.suggested) && disk.pngs === 150 && /^PNG:/.test(disk.magic) && disk.downloads === 0, `Anzeige/PNG: ${JSON.stringify(disk)}`);
    return disk;
  });

  await test("Betrachter: Bereich für die Verarbeitung übernehmen", async () => {
    await ev(`document.getElementById('useRange').click(); true`);
    await sleep(800);
    const r = await ev(`({ start: document.querySelector('[data-opt="startFrame"]').value, max: document.querySelector('[data-opt="maxFrames"]').value, processVisible: !document.getElementById('processPanel').hidden })`);
    check(r.start === "100" && r.max === "150", `Start ${r.start}, Anzahl ${r.max}`);
    // zurücksetzen für die folgenden Tests
    await ev(`__t.set('[data-opt="startFrame"]', 0); __t.set('[data-opt="maxFrames"]', 0); true`);
    return r;
  });

  // ---------- SER: Verarbeitung ----------
  await test("Planet (Farb-SER): beste 50 % als SER (Bayer roh) + Zeitraffer HEVC", async () => {
    await processMode();
    await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
    await sleep(800);
    await ev(`__t.set('[data-opt="keepMode"]', 'percent'); __t.set('[data-opt="keepValue"]', 50); __t.set('#format', 'ser');
             __t.set('[data-tl="enabled"]', true); __t.set('[data-tl="format"]', 'mp4-hevc'); true`);
    const r = await runAndWait(600_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 300 && ser.width === 448 && ser.colorId === 8, `SER: ${JSON.stringify(ser)}`);
    const video = await saveVideo("planet_saturn_hevc.mp4");
    const st = video.probe?.streams?.[0];
    if (video.probe) check(st.codec_name === "hevc" && st.codec_tag_string === "hvc1", `Video: ${JSON.stringify(st)}`);
    return { ...r, video };
  });

  await test("Planet: SER farbig (Debayer) + PNG", async () => {
    await ev(`__t.set('[data-opt="maxFrames"]', 100); __t.set('[data-opt="debayerSer"]', true); __t.set('[data-tl="enabled"]', false); __t.set('#format', 'ser'); true`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.colorId === 100 && ser.frames === 50 && ser.bytes === 178 + 50 * 448 * 448 * 3 + 50 * 8, `SER: ${JSON.stringify(ser)}`);
    await ev(`__t.set('#format', 'png'); true`);
    const p = await runAndWait(300_000);
    const zip = p.files.find((f) => /\.zip$/.test(f.name));
    check(zip && zip.entries === 51, `ZIP: ${JSON.stringify(zip)}`); // 50 PNG + Protokoll
    await ev(`__t.set('[data-opt="maxFrames"]', 0); __t.set('[data-opt="debayerSer"]', false); true`);
    return { ser, zip };
  });

  await test("Planet: SER direkt auf die Platte (während der Verarbeitung)", async () => {
    // Statt des Speichern-Dialogs eine Datei im privaten Speicher der Seite (OPFS) – gleiche Schnittstelle
    await ev(`(() => {
      window.__origSave = window.showSaveFilePicker;
      window.showSaveFilePicker = async (o) => { window.__suggested = o.suggestedName; const d = await navigator.storage.getDirectory(); return d.getFileHandle('astrotool-disk-test.ser', { create: true }); };
      __t.set('[data-opt="maxFrames"]', 100); __t.set('[data-opt="debayerSer"]', false); __t.set('[data-tl="enabled"]', false); __t.set('#format', 'ser'); __t.set('#toFolder', true);
      return true; })()`);
    const r = await runAndWait(300_000);
    const disk = await ev(`(async () => {
      const d = await navigator.storage.getDirectory();
      const f = await (await d.getFileHandle('astrotool-disk-test.ser')).getFile();
      const v = new DataView(await f.slice(0, 178).arrayBuffer());
      const out = { bytes: f.size, frames: v.getInt32(38, true), width: v.getInt32(26, true), suggested: window.__suggested, downloads: document.querySelectorAll('#result a[download]').length, text: document.getElementById('result').innerText.slice(0, 200) };
      await d.removeEntry('astrotool-disk-test.ser');
      window.showSaveFilePicker = window.__origSave; __t.set('#toFolder', false); __t.set('[data-opt="maxFrames"]', 0);
      return out; })()`);
    check(disk.frames === 50 && disk.width === 448 && disk.bytes === 178 + 50 * 448 * 448 + 50 * 8, `Datei: ${JSON.stringify(disk)}`);
    check(/_astro\.ser$/.test(disk.suggested) && disk.downloads === 0 && /astrotool-disk-test\.ser/.test(disk.text), `Anzeige: ${JSON.stringify(disk)}`);
    return { ...r, disk };
  });

  if (calDir) await test("Planet: Kalibrierung mit Dark, Flat und Bias", async () => {
    const info = (k) => ev(`document.querySelector('[data-cal="${k}"] .calInfo').innerText`);
    for (const [k, f] of [["dark", "dark.ser"], ["flat", "flat.ser"], ["flatDark", "bias.ser"]]) {
      await setFiles(`[data-cal="${k}"] input[type=file]`, [join(calDir, f)]);
      await waitFor(`/^Master (from|aus)/.test(document.querySelector('[data-cal="${k}"] .calInfo').innerText) || document.querySelector('[data-cal="${k}"] .calInfo').classList.contains('error')`, 60_000, `Master ${k}`);
    }
    const texts = { dark: await info("dark"), flat: await info("flat"), flatDark: await info("flatDark") };
    check(/6 .*640 × 640/.test(texts.dark) && /6 .*640 × 640/.test(texts.flat) && /3 .*640 × 640/.test(texts.flatDark), `Master: ${JSON.stringify(texts)}`);
    const applied = await ev(`[...document.querySelectorAll('[data-cal-use]')].map((c) => c.checked)`);
    check(applied.every(Boolean), `anwenden: ${JSON.stringify(applied)}`);
    await ev(`__t.set('[data-opt="maxFrames"]', 100); __t.set('[data-tl="enabled"]', false); __t.set('#format', 'ser'); true`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 50 && ser.width === 448, `SER: ${JSON.stringify(ser)}`);
    // entfernen, damit die folgenden Tests unkalibriert laufen
    await ev(`document.querySelectorAll('[data-cal-clear]').forEach((b) => b.click()); __t.set('[data-opt="maxFrames"]', 0); true`);
    await waitFor(`[...document.querySelectorAll('.calRow .calInfo')].every((e) => !/Master/.test(e.innerText))`, 10_000, "Master entfernt");
    return { ...r, masters: texts };
  });

  await test("Nur sortieren: alle 600 Frames, volle Grösse, sortiert", async () => {
    await ev(`document.querySelector('[data-preset="quality"]').click(); true`);
    await sleep(800);
    await ev(`__t.set('#format', 'ser'); true`);
    const r = await runAndWait(600_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 600 && ser.width === 640 && ser.colorId === 8, `SER: ${JSON.stringify(ser)}`);
    return r;
  });

  await test("PIPP-Optionsdatei (.pof) importieren", async () => {
    const pof = join(outDir, "test.pof");
    writeFileSync(pof, "[PIPP OPTIONS FILE]\r\nCROP_WIDTH 300\r\nCROP_HEIGHT 280\r\nENABLE_CROP True\r\nCENTRE_PLANET True\r\nQUALITY_LIMITING True\r\nQUALITY__LIMITING_TYPE 0\r\nQUALITY_FRAMES 123\r\nDEBAYER_ENABLED True\r\nGIF_FPS_VALUE 10\r\n");
    await setFiles("#pof", [pof]);
    await sleep(1200);
    const r = await ev(`({ w: document.querySelector('[data-opt="cropWidth"]').value, h: document.querySelector('[data-opt="cropHeight"]').value, keep: document.querySelector('[data-opt="keepValue"]').value, deb: document.querySelector('[data-opt="debayerSer"]').checked, msg: document.getElementById('result').innerText.slice(0, 200) })`);
    check(r.w === "300" && r.h === "280" && r.keep === "123" && r.deb, JSON.stringify(r));
    return r;
  });

  // ---------- AVI ----------
  if (aviDir) {
    const info = () => ev(`document.getElementById('info').innerText.replace(/\\n/g, ' | ')`);
    const digits = (s) => s.replace(/[’'., ]/g, "");
    await test("AVI 8 bit grau (Y800): öffnen, Planet → SER mono", async () => {
      await openFiles([resolve(join(aviDir, "saturn_y800.avi"))], "saturn_y800");
      const i = await info();
      check(/(Frames|Bilder)\s*\|?\s*40(?!\d)/.test(i), `Info: ${i}`);
      await processMode();
      await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
      await sleep(800);
      await ev(`__t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
      const r = await runAndWait(300_000);
      const ser = r.files.find((f) => /\.ser$/.test(f.name));
      check(ser && ser.frames === 40 && ser.colorId === 0, `SER: ${JSON.stringify(ser)}`);
      return { info: i, ...r };
    });
    await test("AVI MJPEG: öffnen und als PNG verarbeiten", async () => {
      await openFiles([resolve(join(aviDir, "saturn_mjpeg.avi"))], "saturn_mjpeg");
      await processMode();
      await ev(`__t.set('#format', 'png'); __t.set('[data-tl="enabled"]', false); true`);
      const r = await runAndWait(300_000);
      const zip = r.files.find((f) => /\.zip$/.test(f.name));
      check(zip && zip.entries === 41, `ZIP: ${JSON.stringify(zip)}`);
      return r;
    });
    if (readdirSync(aviDir).includes("saturn_big.avi")) {
      await test("AVI 4 GB (OpenDML, 6720 Bilder): öffnen, beste 10 % als SER", async () => {
        const t0 = Date.now();
        await openFiles([resolve(join(aviDir, "saturn_big.avi"))], "saturn_big");
        const openMs = Date.now() - t0;
        const i = await info();
        check(digits(i).includes("6720"), `Info: ${i}`);
        await processMode();
        await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
        await sleep(800);
        await ev(`__t.set('[data-opt="keepMode"]', 'percent'); __t.set('[data-opt="keepValue"]', 10); __t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
        const r = await runAndWait(1_800_000);
        const ser = r.files.find((f) => /\.ser$/.test(f.name));
        check(ser && ser.frames === 672 && ser.colorId === 100, `SER: ${JSON.stringify(ser)}`);
        return { openMs, info: i, ...r };
      });
    }
  }

  // ---------- Bilderserie: Sonne und Finsternis ----------
  await test(`Bilder öffnen (${images.length} JPG)`, async () => {
    await openFiles(images, "SAM_");
    const r = await ev(`({ viewer: !document.getElementById('viewer').hidden, colourRowsHidden: [...document.querySelectorAll('.colourRow')].every((e) => e.hidden), info: document.getElementById('info').innerText.replace(/\\n/g, ' | ').slice(0, 300) })`);
    check(r.viewer, "Vorschau nicht sichtbar");
    check(r.colourRowsHidden, "Debayer-Optionen bei JPG sichtbar");
    return r;
  });

  await test("Sonne/Mond: 10 Bilder volle Grösse als PNG", async () => {
    await processMode();
    await ev(`document.querySelector('[data-preset="disc"]').click(); true`);
    await sleep(800);
    await ev(`__t.set('[data-opt="maxFrames"]', 10); __t.set('#format', 'png'); __t.set('[data-tl="enabled"]', false); true`);
    const r = await runAndWait(600_000);
    const zip = r.files.find((f) => /\.zip$/.test(f.name));
    check(zip && zip.entries >= 2, `ZIP: ${JSON.stringify(zip)}`);
    await ev(`__t.set('[data-opt="maxFrames"]', 0); true`);
    return r;
  });

  await test("Sonne/Mond: 16-bit-PNG, TIFF und FITS", async () => {
    await ev(`__t.set('[data-opt="maxFrames"]', 3); __t.set('[data-tl="enabled"]', false); true`);
    const out = {};
    for (const [fmt, ext, magic] of [["png16", "png", ".PNG...."], ["tiff", "tif", "II*."], ["fits", "fits", "SIMPLE  "]]) {
      await ev(`__t.set('#format', '${fmt}'); true`);
      const r = await runAndWait(600_000);
      const zip = r.files.find((f) => /\.zip$/.test(f.name));
      check(zip && zip.entries === 4 && zip.first.endsWith(`_astro.${ext}`) && zip.magic.startsWith(magic), `${fmt}: ${JSON.stringify(zip)}`);
      out[fmt] = zip;
    }
    await ev(`__t.set('[data-opt="maxFrames"]', 0); __t.set('#format', 'png'); true`);
    return out;
  });

  await test("Finsternis: alle Bilder, PNG + Zeitraffer HEVC", async () => {
    await ev(`document.querySelector('[data-preset="eclipse"]').click(); true`);
    await sleep(1200);
    await ev(`__t.set('[data-tl="format"]', 'mp4-hevc'); __t.set('[data-tl="title"]', 'Partielle Sonnenfinsternis 12.08.2026'); true`);
    const r = await runAndWait(900_000);
    check(r.files.some((f) => /_montage\.png$/.test(f.name)), `Phasenmontage fehlt: ${JSON.stringify(r.files)}`);
    const video = await saveVideo("finsternis_hevc.mp4");
    const st = video.probe?.streams?.[0];
    if (video.probe) check(st.codec_tag_string === "hvc1" && /2026-08-12/.test(video.probe.format?.tags?.creation_time ?? ""), `Video: ${JSON.stringify(video.probe)}`);
    return { ...r, video };
  });

  await test("Finsternis: Zeitraffer als GIF und H.264", async () => {
    await ev(`__t.set('#format', 'none'); __t.set('[data-tl="format"]', 'gif'); true`);
    const g = await runAndWait(900_000);
    const gif = await saveVideo("finsternis.gif");
    await ev(`__t.set('[data-tl="format"]', 'mp4-h264'); true`);
    const h = await runAndWait(900_000);
    const h264 = await saveVideo("finsternis_h264.mp4");
    if (h264.probe) check(h264.probe.streams[0].codec_name === "h264", `H.264: ${JSON.stringify(h264.probe)}`);
    return { gif: { seconds: g.seconds, ...gif }, h264: { seconds: h.seconds, ...h264 } };
  });

  // ---------- MP4 (H.264, im Test davor selbst erzeugt) ----------
  await test("MP4 (H.264): eigenen Zeitraffer wieder öffnen, Finsternis → PNG", async () => {
    const mp4 = join(outDir, "finsternis_h264.mp4");
    await openFiles([mp4], "finsternis_h264");
    const i = await ev(`document.getElementById('info').innerText.replace(/\\n/g, ' | ')`);
    let n = null;
    try {
      n = Number(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v", "-show_entries", "stream=nb_read_packets", "-of", "json", mp4]).toString()).streams[0].nb_read_packets);
    } catch { /* ohne ffprobe */ }
    if (n) check(i.replace(/[’'., ]/g, "").includes(String(n)), `Info ${i}, erwartet ${n} Bilder`);
    await processMode();
    await ev(`document.querySelector('[data-preset="eclipse"]').click(); true`);
    await sleep(1200);
    await ev(`__t.set('#format', 'png'); __t.set('[data-tl="enabled"]', false); true`);
    const r = await runAndWait(900_000);
    const zip = r.files.find((f) => /\.zip$/.test(f.name));
    check(zip && zip.entries > 10, `ZIP: ${JSON.stringify(zip)}`);
    return { info: i, frames: n, ...r };
  });

  // ---------- Totalität (künstliche Serie mit Belichtungsreihen) ----------
  if (totalityDir) {
    const tot = listImages(totalityDir);
    await test(`Totalität: ${tot.length} Bilder, Mondrand + HDR-Belichtungsreihen, PNG + Zeitraffer`, async () => {
      await openFiles(tot, "TOT_");
      await processMode();
      await ev(`document.querySelector('[data-preset="eclipse"]').click(); true`);
      await sleep(1200);
      const hdrOn = await ev(`document.querySelector('[data-opt="hdr"]').checked`);
      check(hdrOn, "HDR in der Vorlage Finsternis nicht eingeschaltet");
      await ev(`__t.set('#format', 'png'); __t.set('[data-tl="format"]', 'mp4-hevc'); __t.set('[data-tl="title"]', 'Totale Sonnenfinsternis (Test)'); true`);
      const r = await runAndWait(900_000);
      const zip = r.files.find((f) => /\.zip$/.test(f.name));
      check(zip && zip.entries === 11, `ZIP (erwartet 10 PNG + Log): ${JSON.stringify(zip)}`);
      check(/(Totalität|totality): 15 /.test(r.text), `Ergebnis: ${r.text}`);
      check(r.files.some((f) => /_montage\.png$/.test(f.name)), `Phasenmontage fehlt: ${JSON.stringify(r.files)}`);
      const b64 = await ev(`__t.base64('#result a[download]', '\\\\.zip$')`);
      if (b64) writeFileSync(join(outDir, "totalitaet.zip"), Buffer.from(b64, "base64"));
      const video = await saveVideo("totalitaet_hevc.mp4");
      return { ...r, video };
    });
  }

  // ---------- Kamera-RAW (Unterordner arw, cr2, dng, nef, cr3, raf mit je einer Belichtungsreihe) ----------
  if (rawDir) {
    const rawFiles = (sub) => readdirSync(join(rawDir, sub)).map((f) => resolve(join(rawDir, sub, f)));
    const infoText = () => ev(`document.getElementById('info').innerText.replace(/\\n/g, ' | ')`);
    await test("RAW: Sony ARW Sensordaten, Finsternis mit HDR → PNG", async () => {
      await ev(`__t.set('#rawMode', 'raw'); true`);
      await openFiles(rawFiles("arw"), "DSC0");
      const i = await infoText();
      check(/ARW lossless/.test(i) && /Bayer|RGGB/i.test(i), `Info: ${i}`);
      await processMode();
      await ev(`document.querySelector('[data-preset="eclipse"]').click(); true`);
      await sleep(1200);
      await ev(`__t.set('#format', 'png'); __t.set('[data-tl="enabled"]', false); true`);
      const r = await runAndWait(900_000);
      const zip = r.files.find((f) => /\.zip$/.test(f.name));
      check(zip && zip.entries >= 3, `ZIP: ${JSON.stringify(zip)}`);
      check(/(Totalität|totality): 4 /.test(r.text), `Ergebnis: ${r.text}`);
      return { info: i, ...r };
    });
    await test("RAW: Umschalten auf Kamerabild (eingebettetes JPEG)", async () => {
      await ev(`__t.set('#rawMode', 'preview'); true`);
      await waitFor(`/JPEG/.test(document.getElementById('info').innerText)`, 120_000, "Neu einlesen als JPEG");
      const i = await infoText();
      check(/7008/.test(i) && /RGB/.test(i), `Info: ${i}`);
      await ev(`__t.set('#rawMode', 'raw'); true`);
      await sleep(3000);
      return { info: i };
    });
    for (const [sub, re, title] of [["cr2", /CR2/, "IMG_"], ["dng", /DNG lossless/, "NM2A"], ["nef", /NEF compressed/, "DSC_"], ["cr3", /JPEG.*CR3.*DNG Converter/, "Donald"], ["raf", /JPEG.*RAF.*DNG Converter/, "_DSF"], ["raf-unc", /RAF uncompressed.*(Sensordaten|sensor data)/, "DSCF"], ["srw", /SRW compressed/, "SAM_"]]) {
      if (!readdirSync(rawDir).includes(sub)) continue;
      await test(`RAW: ${sub.toUpperCase()} öffnen und Vorschau`, async () => {
        // alte Beurteilung leeren, damit nur die neue Vorschau zählt
        await ev(`document.getElementById('verdict').innerText = ''; true`);
        await openFiles(rawFiles(sub), title);
        const i = await infoText();
        check(re.test(i), `Info: ${i}`);
        if (sub === "cr3") check(!/RAF/.test(i), `CR3-Hinweis nennt RAF: ${i}`);
        await processMode();
        // Vorschau der neuen Datei abwarten: eine späte Vorschau der vorigen Datei kann die Beurteilung noch überschreiben
        await waitFor(`document.getElementById('inLabel').textContent.startsWith(${JSON.stringify(title)}) && document.getElementById('verdict').innerText.trim().length > 0`, 60_000, "Vorschau-Beurteilung");
        const v = await ev(`document.getElementById('verdict').innerText`);
        if (sub === "raf-unc") check(!/(totality|Totalität)/.test(v), `Farbtafel als Finsternis beurteilt: ${v}`);
        return { info: i, verdict: v };
      });
    }
  }

  // ---------- FITS (Bildserie aus scripts/make-fits-testset.mjs: 16 bit, Bayer, unterste Zeile zuerst) ----------
  if (fitsDir) await test("FITS: Bildserie (16 bit, Bayer) öffnen, Planet → beste 50 % als SER", async () => {
    const files = readdirSync(fitsDir).filter((f) => /\.fits?$/i.test(f)).sort().map((f) => resolve(join(fitsDir, f)));
    await openFiles(files, "frame_");
    const i = await ev(`document.getElementById('info').innerText.replace(/\\n/g, ' | ')`);
    check(new RegExp(`${files.length}`).test(i) && /640 × 640/.test(i) && /RGGB/.test(i) && /16 bit/.test(i) && /2022-10-25 00:55/.test(i), `Info: ${i}`);
    await processMode();
    await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
    await sleep(800);
    await ev(`__t.set('[data-opt="keepMode"]', 'percent'); __t.set('[data-opt="keepValue"]', 50); __t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    const half = Math.round(files.length / 2);
    check(ser && ser.frames === half && ser.colorId === 8 && ser.width === 448, `SER: ${JSON.stringify(ser)}`);
    return { info: i, ...r };
  });

  // ---------- FITS-Würfel (scripts/make-fits-testset.mjs <ser> <datei.fits>: alle Bilder in einer Datei) ----------
  if (fitsCube) await test("FITS-Würfel: eine Datei mit 30 Bildern öffnen, Betrachter, Planet → beste 50 % als SER", async () => {
    await openFiles([resolve(fitsCube)], "saturn_cube");
    const i = await ev(`document.getElementById('info').innerText.replace(/\\n/g, ' | ')`);
    check(/(Frames|Bilder)\D{0,4}30\D/.test(i) && /640 × 640/.test(i) && /RGGB/.test(i) && /16 bit/.test(i) && /2022-10-25 00:55/.test(i) && /(29\.9|30\.0)/.test(i), `Info: ${i}`);
    // wie ein Video: Betrachter mit Bild 15
    await ev(`document.querySelector('[data-mode="view"]')?.click(); true`);
    await sleep(800);
    await ev(`__t.seek(14); true`);
    await sleep(1500);
    const details = await ev(`document.getElementById('playDetails').innerText.replace(/\\n/g, ' | ').slice(0, 300)`);
    check(/15/.test(details), `Betrachter: ${details}`);
    await processMode();
    await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
    await sleep(800);
    await ev(`__t.set('[data-opt="keepMode"]', 'percent'); __t.set('[data-opt="keepValue"]', 50); __t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 15 && ser.colorId === 8 && ser.width === 448 && /saturn_cube/.test(ser.name), `SER: ${JSON.stringify(ser)}`);
    return { info: i, details, ...r };
  });

  // ---------- Oberfläche (scripts/make-surface-testset.mjs: Mond-Nahaufnahme mit Zittern, 2 Wolkenbilder) ----------
  if (surfaceSer) await test("Oberfläche: Mond-Nahaufnahme stabilisieren → SER", async () => {
    await openFiles([resolve(surfaceSer)], "moon_surface");
    await processMode();
    await ev(`document.querySelector('[data-preset="surface"]').click(); true`);
    await sleep(800);
    const opt = await ev(`({ mode: document.querySelector('[data-opt="centreMode"]').value, w: document.querySelector('[data-opt="cropWidth"]').value, h: document.querySelector('[data-opt="cropHeight"]').value })`);
    check(opt.mode === "surface" && opt.w === "576" && opt.h === "432", `Vorlage: ${JSON.stringify(opt)}`);
    await ev(`__t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 60 && ser.width === 576 && ser.height === 432, `SER: ${JSON.stringify(ser)}`);
    // Deckung im Ergebnis: mittlere Abweichung zum ersten Bild, verglichen mit absichtlich 4 px verschoben
    const cmp = await ev(`(async () => {
      const a = [...document.querySelectorAll('#result a[download]')].find((x) => /\\.ser$/.test(x.download));
      const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
      const W = 576, H = 432, f = (k) => b.subarray(178 + k * W * H, 178 + (k + 1) * W * H);
      const d0 = f(0), diff = (k, sh) => { const d = f(k); let s = 0, n = 0; for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 44; x++) { s += Math.abs(d[y * W + x + sh] - d0[y * W + x]); n++; } return s / n; };
      let al = 0, sh = 0; for (let k = 1; k < 60; k += 6) { al += diff(k, 0); sh += diff(k, 4); }
      return { aligned: +(al / 10).toFixed(2), shifted: +(sh / 10).toFixed(2) };
    })()`);
    check(cmp.aligned < 6 && cmp.shifted > 1.4 * cmp.aligned, `Deckung: ${JSON.stringify(cmp)}`);
    const all = await ev(`document.getElementById('result').textContent`); // auch im zugeklappten Teil
    check(/(Oberfläche nicht wiedererkannt|Surface not recognised)/.test(all) && /moon_surface_21\b/.test(all) && /moon_surface_42\b/.test(all), `Wolkenbilder nicht gemeldet: ${all.slice(0, 400)}`);
    return { ...r, cmp };
  });

  // Ankerbox: mit der Maus in der Eingabe-Ansicht ziehen (wie eine Person), verarbeiten, wieder löschen
  if (surfaceSer) await test("Oberfläche: Ankerbox ziehen → SER, Box löschen", async () => {
    const hint = await ev(`(() => { const r = document.getElementById('anchorRow'); return { hidden: r.hidden, text: document.getElementById('anchorText').textContent, clear: !document.getElementById('anchorClear').hidden }; })()`);
    check(!hint.hidden && /(Ankerbox \(freiwillig\)|Anchor box \(optional\))/.test(hint.text) && !hint.clear, `Hinweis: ${JSON.stringify(hint)}`);
    const box = await ev(`(() => { const c = document.getElementById('inCanvas'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, sx: r.width / c.width, sy: r.height / c.height }; })()`);
    await sleep(300);
    const at = (x, y) => ({ x: box.left + x * box.sx, y: box.top + y * box.sy });
    const p0 = at(200, 150), p1 = at(360, 290);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p0 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p0, button: "left", buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 5; k++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x + ((p1.x - p0.x) * k) / 5, y: p0.y + ((p1.y - p0.y) * k) / 5, button: "left", buttons: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p1, button: "left", buttons: 0, clickCount: 1 });
    await sleep(1000);
    const set = await ev(`({ text: document.getElementById('anchorText').textContent, legend: !document.getElementById('anchorLegend').hidden, clear: !document.getElementById('anchorClear').hidden })`);
    check(/160 × 140/.test(set.text) && set.legend && set.clear, `Ankerbox: ${JSON.stringify(set)}`);
    const r = await runAndWait(300_000);
    const ser = r.files.find((f) => /\.ser$/.test(f.name));
    check(ser && ser.frames === 60 && ser.width === 576 && ser.height === 432, `SER: ${JSON.stringify(ser)}`);
    const cmp = await ev(`(async () => {
      const a = [...document.querySelectorAll('#result a[download]')].find((x) => /\\.ser$/.test(x.download));
      const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
      const W = 576, H = 432, f = (k) => b.subarray(178 + k * W * H, 178 + (k + 1) * W * H);
      const d0 = f(0), diff = (k, sh) => { const d = f(k); let s = 0, n = 0; for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 44; x++) { s += Math.abs(d[y * W + x + sh] - d0[y * W + x]); n++; } return s / n; };
      let al = 0, sh = 0; for (let k = 1; k < 60; k += 6) { al += diff(k, 0); sh += diff(k, 4); }
      return { aligned: +(al / 10).toFixed(2), shifted: +(sh / 10).toFixed(2) };
    })()`);
    check(cmp.aligned < 6 && cmp.shifted > 1.4 * cmp.aligned, `Deckung: ${JSON.stringify(cmp)}`);
    await ev(`document.getElementById('anchorClear').click(); true`);
    await sleep(500);
    const cleared = await ev(`({ text: document.getElementById('anchorText').textContent, legend: !document.getElementById('anchorLegend').hidden })`);
    check(/(Ankerbox \(freiwillig\)|Anchor box \(optional\))/.test(cleared.text) && !cleared.legend, `Löschen: ${JSON.stringify(cleared)}`);
    return { ...r, anchor: set.text, cmp };
  });

  // ---------- grosse Datei ----------
  if (bigSer) {
    await test("Grosses SER (Strata-Saturn): öffnen, Betrachter, beste 50 % als SER", async () => {
      await openFiles([resolve(bigSer)], "2022-10-25");
      const details = await ev(`document.getElementById('playDetails').innerText.replace(/\\n/g, ' | ').slice(0, 300)`);
      await ev(`__t.seek(8000); true`);
      await sleep(1500);
      await processMode();
      await ev(`document.querySelector('[data-preset="planet"]').click(); true`);
      await sleep(800);
      await ev(`__t.set('[data-opt="keepMode"]', 'percent'); __t.set('[data-opt="keepValue"]', 50); __t.set('#format', 'ser'); __t.set('[data-tl="enabled"]', false); true`);
      const r = await runAndWait(1_800_000);
      const ser = r.files.find((f) => /\.ser$/.test(f.name));
      check(ser && ser.frames === 4492, `SER: ${JSON.stringify(ser)}`);
      const mem = await ev(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null`);
      return { details, ...r, heapMB: mem };
    });
  }
} catch (e) {
  console.error("ABBRUCH:", e.message);
  report.push({ name: "Testlauf", ok: false, error: e.message });
} finally {
  writeFileSync(join(outDir, "bericht.json"), JSON.stringify(report, null, 2));
  const ok = report.filter((r) => r.ok).length;
  console.log(`\n${ok} von ${report.length} Tests bestanden. Bericht: ${join(outDir, "bericht.json")}`);
  process.exitCode = ok === report.length ? 0 : 1;
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
