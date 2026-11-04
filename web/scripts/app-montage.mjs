// Phasenmontage mit der Windows-App bauen und dabei die Einstellungen fotografieren (für Präsentationen).
// Aufruf: node scripts/app-montage.mjs <astrotool.exe> <ausgabeordner> --images <ordner> --name <dateiname> [--layout arc|row|grid] [--count 11] [--title <text>] [--lang de|en]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const exe = args[0], outDir = args[1] && resolve(args[1]);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const imageDir = opt("--images"), name = opt("--name") ?? "montage", layout = opt("--layout") ?? "arc";
const count = Number(opt("--count") ?? 11), title = opt("--title") ?? "", uiLang = opt("--lang") ?? "de";
if (!exe || !outDir || !imageDir) { console.error("Aufruf: node scripts/app-montage.mjs <astrotool.exe> <ausgabeordner> --images <ordner> --name <name>"); process.exit(2); }
const files = readdirSync(imageDir).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).map((f) => resolve(join(imageDir, f)));
mkdirSync(outDir, { recursive: true });
const W = 1600, H = 1000, PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await ev(`(document.documentElement.lang !== ${JSON.stringify(uiLang)} && document.getElementById('lang').click(), true)`);
  await ev(`(document.documentElement.dataset.night === '1' && document.getElementById('night').click(), true)`);
  await sleep(800);
  await openFiles(files);
  await click('[data-mode="process"]');
  await click('[data-preset="eclipse"]');
  await sleep(1500);
  await set("#format", "none");
  await set('[data-tl="enabled"]', false);
  await set('[data-mt="enabled"]', true);
  await set('[data-mt="layout"]', layout);
  await set('[data-mt="count"]', count);
  await set('[data-mt="title"]', title);
  await sleep(800);
  await scrollTo("#mtCard");
  await sleep(600);
  await shot(`${name}_einstellungen.png`);
  await ev(`(document.getElementById('result').hidden = true, document.getElementById('run').click(), true)`);
  await waitFor(`!document.getElementById('result').hidden`, 1_800_000);
  await scrollTo("#result");
  await sleep(2500);
  await shot(`${name}_ergebnis.png`);
  const b64 = await ev(`(async () => { const a = [...document.querySelectorAll('#result a[download]')].find((x) => /_montage\.png$/.test(x.download)); const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(b64, "base64"));
  console.log("  Montage", join(outDir, `${name}.png`));
} catch (e) {
  console.error("ABBRUCH:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
