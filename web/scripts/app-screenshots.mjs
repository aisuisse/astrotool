// Bildschirmfotos der Windows-App für README und GitHub (englische Oberfläche, 1600 × 1000).
// Startet astrotool.exe mit WebView2-Debug-Port, bedient die Oberfläche und speichert PNGs.
// Nur eigene oder freie Daten: die künstliche Jupiter-Aufnahme (npm run sample), drei Teile davon mit Zeit im
// Dateinamen (Stapel), eigene Finsternisbilder des Besitzers.
//
// Aufruf:
//   node scripts/app-screenshots.mjs <astrotool.exe> <ausgabeordner> --jupiter <sample-jupiter.ser> --batch <ordner mit SER> --images <finsternis-ordner>
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const exe = args[0], outDir = args[1] && resolve(args[1]);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const jupiter = opt("--jupiter"), batchDir = opt("--batch"), imageDir = opt("--images");
if (!exe || !outDir || !jupiter || !batchDir || !imageDir) {
  console.error("Aufruf: node scripts/app-screenshots.mjs <astrotool.exe> <ausgabeordner> --jupiter <ser> --batch <ordner> --images <ordner>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const W = 1600, H = 1000, PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = (d, re) => readdirSync(d).filter((f) => re.test(f)).sort().map((f) => resolve(join(d, f)));

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=http://127.0.0.1:${PORT}` },
  stdio: "ignore",
});
let ws, seq = 0;
const pending = new Map();
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
async function openFiles(list, titleStart) {
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
  await cdp("DOM.setFileInputFiles", { nodeId, files: list });
  await waitFor(`document.title.startsWith(${JSON.stringify(titleStart)}) && !document.getElementById('modeTabs').hidden`);
  await sleep(2500);
}
const set = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el.type === 'checkbox') el.checked = ${JSON.stringify(v)}; else el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input')); return true; })()`);
const click = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})?.click(), true)`);
const scrollTo = (sel, offset = 12) => ev(`(document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' }), window.scrollBy(0, -${offset}), document.querySelectorAll('aside, .panel, .side').forEach((el) => { const t = el.querySelector(${JSON.stringify(sel)}); if (t) el.scrollTop = t.offsetTop - ${offset}; }), true)`);
const top = () => ev(`(window.scrollTo(0, 0), document.querySelectorAll('aside').forEach((el) => (el.scrollTop = 0)), true)`);
/** Vorschau abwarten (Beurteilung steht da) */
const clearVerdict = () => ev("(document.getElementById('verdict').innerText = '', true)");
const preview = () => waitFor(`document.getElementById('verdict').innerText.trim().length > 0`, 60_000).then(() => sleep(1500));

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
  };
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  // englische Oberfläche, heller Modus
  await ev(`(document.documentElement.lang !== 'en' && document.getElementById('lang').click(), true)`);
  await ev(`(document.documentElement.dataset.night === '1' && document.getElementById('night').click(), true)`);
  await sleep(800);

  console.log("Planet: Betrachter und Verarbeitung");
  await openFiles([resolve(jupiter)], "sample-jupiter");
  await sleep(1500);
  await shot("viewer.png");
  await click('[data-mode="process"]');
  await clearVerdict();
  await click('[data-preset="planet"]');
  await sleep(500);
  await set('[data-opt="cropWidth"]', 256);
  await set('[data-opt="cropHeight"]', 256);
  await preview();
  await top();
  await shot("planet-processing.png");

  console.log("Stapel mit WinJUPOS-Namen");
  await openFiles(files(batchDir, /\.ser$/i), "2026-11-05-2130");
  await click('[data-mode="process"]');
  await clearVerdict();
  await click('[data-preset="planet"]');
  await sleep(500);
  await set('[data-opt="cropWidth"]', 256);
  await set('[data-opt="cropHeight"]', 256);
  await set("#format", "ser");
  await set('[data-tl="enabled"]', false);
  await set('[data-opt="winjupos"]', true);
  await set('[data-opt="wjObserver"]', "AT");
  await set('[data-opt="wjInfo"]', "Jup");
  // Ordner-Dialog durch einen Ordner im privaten Speicher der Seite ersetzen
  await ev(`(async () => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('shots', { recursive: true }); } catch {}
    const dir = await root.getDirectoryHandle('shots', { create: true });
    window.showDirectoryPicker = async () => dir;
    return true; })()`);
  await preview();
  await click("#run");
  await waitFor(`!document.getElementById('result').hidden && /3/.test(document.getElementById('result').innerText)`, 300_000);
  await sleep(1500);
  // Ausschnitt: Stapel-Karte mit Ergebnis (rechte Spalte), dazu links daneben die Vorschau des letzten Bildes
  await ev("(document.querySelector('.card.run').scrollIntoView({ block: 'end' }), true)");
  await sleep(800);
  const box = await ev("(() => { const r = document.querySelector('.card.run').getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }; })()");
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.w + 16, height: box.h + 16, scale: 1 } });
  writeFileSync(join(outDir, "batch-winjupos.png"), Buffer.from(data, "base64"));
  console.log("  Bild batch-winjupos.png", Math.round(box.w), "×", Math.round(box.h));
  await ev(`(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('shots', { recursive: true }); } catch {} return true; })()`);
  await set('[data-opt="winjupos"]', false);

  console.log("Finsternis");
  const eclipse = files(imageDir, /\.(jpe?g)$/i);
  await openFiles(eclipse, "SAM_");
  await click('[data-mode="process"]');
  await click('[data-preset="eclipse"]');
  await sleep(800);
  await clearVerdict();
  // ein Bild mit schmaler Sichel
  await ev(`(() => { const f = document.getElementById('frame'); if (f) { f.value = String(Math.floor(${eclipse.length} * 0.55)); f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); } return true; })()`);
  await sleep(1500);
  await preview();
  await top();
  await shot("eclipse-mode.png");

  console.log("Nachtmodus, Werkzeuge");
  await click("#night");
  await sleep(1200);
  await shot("night-mode.png");
  await click("#night");
  await click("#toolsBtn");
  await sleep(2500);
  // Benutzername aus den angezeigten Werkzeug-Pfaden entfernen (Bilder landen im öffentlichen Repo)
  await ev(`document.querySelectorAll('#toolsDialog *').forEach((el) => { if (el.children.length === 0) el.textContent = el.textContent.replace(/([A-Z]:\\\\Users\\\\)[^\\\\]+/gi, '$1<user>'); }); true`);
  await shot("tools.png");
  await click("#toolsClose");
} catch (e) {
  console.error("ABBRUCH:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
