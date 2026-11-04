// Bildschirmfotos und kurze Bildschirmaufnahmen der Windows-App für Präsentationen.
// Startet astrotool.exe mit WebView2-Debug-Port, bedient die Oberfläche und speichert PNGs und MP4/WebM.
//
// Aufruf:
//   node scripts/app-showcase.mjs <astrotool.exe> <ausgabeordner> --ser <saturn.ser> --images <finsternis-ordner> [--totality <ordner>]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const exe = args[0], outDir = args[1] && resolve(args[1]);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const serFile = opt("--ser"), imageDir = opt("--images"), totalityDir = opt("--totality");
const uiLang = opt("--lang") ?? "de", eclipseTitle = opt("--eclipse-title") ?? "Partielle Sonnenfinsternis 12.08.2026";
const totalityFrame = Number(opt("--totality-frame") ?? 6), totalityTitle = opt("--totality-title") ?? "Totale Sonnenfinsternis (Simulation)";
if (!exe || !outDir || !serFile || !imageDir) {
  console.error("Aufruf: node scripts/app-showcase.mjs <astrotool.exe> <ausgabeordner> --ser <saturn.ser> --images <ordner> [--totality <ordner> --totality-frame <n> --totality-title <text>] [--lang de|en] [--eclipse-title <text>]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const W = 1600, H = 1000, PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (d) => readdirSync(d).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).map((f) => resolve(join(d, f)));

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=http://127.0.0.1:${PORT}` },
  stdio: "ignore",
});
let ws, seq = 0;
const pending = new Map();
const listeners = new Set();
const cdp = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
async function ev(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, ms = 180_000) {
  const t0 = Date.now();
  while (!(await ev(expr))) { if (Date.now() - t0 > ms) throw new Error("Zeitüberschreitung: " + expr); await sleep(300); }
}
async function shot(name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  console.log("  Bild", name);
}
async function openFiles(files) {
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
  await cdp("DOM.setFileInputFiles", { nodeId, files });
  await waitFor(`!document.getElementById('modeTabs').hidden`);
  await sleep(2500);
}
const set = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el.type === 'checkbox') el.checked = ${JSON.stringify(v)}; else el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input')); return true; })()`);
const click = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})?.click(), true)`);
const scrollTo = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' }), window.scrollBy(0, -12), true)`);
const top = () => ev(`(window.scrollTo(0, 0), true)`);

/** Bildschirmaufnahme: Einzelbilder mit Zeitstempel sammeln, danach mit FFmpeg zu MP4 + WebM. */
async function record(name, fn) {
  const dir = join(outDir, `_frames_${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const on = async (m) => {
    if (m.method !== "Page.screencastFrame") return;
    const p = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(p, Buffer.from(m.params.data, "base64"));
    frames.push({ p, t: m.params.metadata.timestamp });
    cdp("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
  };
  listeners.add(on);
  await cdp("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  await fn();
  const end = Date.now();
  await cdp("Page.stopScreencast");
  listeners.delete(on);
  // Dauer je Bild aus den Zeitstempeln; das letzte Bild bis zum Ende stehen lassen
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : f.t + Math.max(0.5, (end - t0) / 1000 - (f.t - frames[0].t));
    lines.push(`file '${f.p.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, next - f.t).toFixed(3)}`);
  });
  lines.push(`file '${frames.at(-1).p.replace(/\\/g, "/")}'`);
  const list = join(dir, "list.txt");
  writeFileSync(list, lines.join("\n"));
  const mp4 = join(outDir, `${name}.mp4`), webm = join(outDir, `${name}.webm`);
  const vf = "fps=30,scale=1280:-2:flags=lanczos,format=yuv420p";
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", "-an", mp4]);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-an", webm]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  Film ${name} (${frames.length} Bilder, ${((end - t0) / 1000).toFixed(1)} s)`);
}

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { /* noch nicht bereit */ }
  }
  if (!target) throw new Error("WebView2-Debug-Schnittstelle nicht erreichbar");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    else for (const l of listeners) l(d);
  };
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  // Sprache (--lang de|en), heller Modus
  await ev(`(document.documentElement.lang !== ${JSON.stringify(uiLang)} && document.getElementById('lang').click(), true)`);
  await ev(`(document.documentElement.dataset.night === '1' && document.getElementById('night').click(), true)`);
  await sleep(800);

  console.log("Startbildschirm");
  await shot("01_start.png");

  console.log("Finsternis 12.08.2026");
  const eclipse = list(imageDir);
  await record("film_app_finsternis", async () => {
    await sleep(800);
    await openFiles(eclipse);
    await click('[data-mode="process"]');
    await click('[data-preset="eclipse"]');
    await sleep(2000);
    for (let i = 0; i < 8; i++) { await click("#next"); await sleep(450); }
    await set('[data-tl="title"]', eclipseTitle);
    await sleep(600);
    await scrollTo("#run");
    await sleep(600);
    await ev(`(document.getElementById('result').hidden = true, document.getElementById('run').click(), true)`);
    await waitFor(`!document.getElementById('result').hidden`, 900_000);
    await scrollTo("#result");
    await sleep(6000);
  });
  await top();
  await set("#frame", 40);
  await sleep(2500);
  await shot("02_finsternis_vorschau.png");
  await scrollTo("#result");
  await sleep(4000);
  await shot("03_finsternis_ergebnis.png");
  const b64 = await ev(`(async () => { const a = [...document.querySelectorAll('#result a[download]')].find((x) => /\\.mp4$/.test(x.download)); const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  writeFileSync(join(outDir, "_finsternis_app.mp4"), Buffer.from(b64, "base64"));

  console.log("Betrachter Saturn");
  await top();
  await openFiles([resolve(serFile)]);
  await click('[data-mode="view"]');
  await sleep(1500);
  await record("film_app_betrachter_saturn", async () => {
    await click("#pPlay");
    await sleep(7000);
  });
  await sleep(4000); // Anzeige der Wiedergaberate ohne Aufnahme-Last
  await shot("04_betrachter_saturn.png");
  await click("#pPlay");

  if (totalityDir) {
    console.log("Totalität");
    await openFiles(list(totalityDir));
    await click('[data-mode="process"]');
    await click('[data-preset="eclipse"]');
    await sleep(1500);
    await set("#frame", totalityFrame);
    await sleep(3000);
    await shot("05_totalitaet_vorschau.png");
    await set('[data-tl="title"]', totalityTitle);
    await ev(`(document.getElementById('result').hidden = true, document.getElementById('run').click(), true)`);
    await waitFor(`!document.getElementById('result').hidden`, 900_000);
    await scrollTo("#result");
    await sleep(3000);
    await shot("06_totalitaet_ergebnis.png");
    const t64 = await ev(`(async () => { const a = [...document.querySelectorAll('#result a[download]')].find((x) => /\\.mp4$/.test(x.download)); const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
    writeFileSync(join(outDir, "_totalitaet_app.mp4"), Buffer.from(t64, "base64"));
    await top();
  }

  console.log("Nachtmodus, Werkzeuge");
  await click("#night");
  await sleep(1200);
  await shot("07_nachtmodus.png");
  await click("#night");
  await click("#toolsBtn");
  await sleep(2500);
  // Benutzername aus den angezeigten Werkzeug-Pfaden entfernen (Bilder landen im öffentlichen Repo)
  await ev(`document.querySelectorAll('small.tag').forEach((el) => { el.textContent = el.textContent.replace(/([A-Z]:\\\\Users\\\\)[^\\\\]+/i, '$1<user>'); }); true`);
  await shot("08_werkzeuge.png");
  await click("#toolsClose");
} catch (e) {
  console.error("ABBRUCH:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
