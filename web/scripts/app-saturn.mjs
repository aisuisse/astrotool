// Saturn-Animation mit der Windows-App bauen und dabei jeden Schritt fotografieren (für Präsentationen).
// Aufruf: node scripts/app-saturn.mjs <astrotool.exe> <ausgabeordner> --ser <saturn.ser> [--keep 10] [--crop 360] [--title <text>] [--lang de|en]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const exe = args[0], outDir = args[1] && resolve(args[1]);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const serFile = opt("--ser"), keep = Number(opt("--keep") ?? 10), uiLang = opt("--lang") ?? "de", crop = Number(opt("--crop") ?? 360);
const title = opt("--title") ?? "Saturn · 25.10.2022 · beste 10 % von 8 984 Bildern";
if (!exe || !outDir || !serFile) { console.error("Aufruf: node scripts/app-saturn.mjs <astrotool.exe> <ausgabeordner> --ser <saturn.ser>"); process.exit(2); }
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

  console.log("1 Video öffnen, Betrachter");
  await openFiles([resolve(serFile)]);
  await click('[data-mode="view"]');
  await sleep(1500);
  await ev(`(() => { const s = document.getElementById('playFrame'); s.value = 4000; s.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(2500);
  await shot("saturn_1_video_im_betrachter.png");

  console.log("2 Vorlage Planet, beste Bilder");
  await click('[data-mode="process"]');
  await click('[data-preset="planet"]');
  await sleep(1200);
  await set('[data-opt="keepMode"]', "percent");
  await set('[data-opt="keepValue"]', keep);
  await set('[data-opt="cropWidth"]', crop);
  await set('[data-opt="cropHeight"]', crop);
  await set("#format", "none");
  await sleep(2500);
  await shot("saturn_2_vorlage_planet_beste_bilder.png");

  console.log("3 Zeitraffer einstellen");
  await set('[data-tl="enabled"]', true);
  await set('[data-tl="format"]', "mp4-h264");
  await set('[data-tl="fps"]', 30);
  await set('[data-tl="holdLastSeconds"]', 1);
  await set('[data-tl="showTime"]', true);
  await set('[data-tl="title"]', title);
  await sleep(800);
  await scrollTo("#tlCard");
  await sleep(800);
  await shot("saturn_3_zeitraffer_einstellen.png");

  console.log("4 Verarbeiten");
  await ev(`(document.getElementById('result').hidden = true, document.getElementById('run').click(), true)`);
  await sleep(4000);
  await scrollTo("#run");
  await shot("saturn_4_verarbeitung_laeuft.png");
  await waitFor(`!document.getElementById('result').hidden`, 1_800_000);
  await scrollTo("#result");
  await sleep(4000);
  await shot("saturn_5_ergebnis.png");
  const b64 = await ev(`(async () => { const a = [...document.querySelectorAll('#result a[download]')].find((x) => /\.mp4$/.test(x.download)); const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`);
  const mp4 = join(outDir, "saturn_animation.mp4");
  writeFileSync(mp4, Buffer.from(b64, "base64"));
  // Webfassung: doppelte Grösse (Lanczos), MP4 H.264 + WebM; das Original aus der App bleibt daneben
  const web = join(outDir, "saturn_animation_web.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "scale=iw*2:ih*2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-an", web]);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", "scale=iw*2:ih*2:flags=lanczos", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", "-an", join(outDir, "saturn_animation_web.webm")]);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "5", "-i", web, "-frames:v", "1", "-q:v", "2", join(outDir, "saturn_animation_poster.jpg")]);
  console.log("  Film", mp4, await ev(`document.getElementById('result').innerText.split(String.fromCharCode(10)).join(' | ').slice(0, 300)`));
} catch (e) {
  console.error("ABBRUCH:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
