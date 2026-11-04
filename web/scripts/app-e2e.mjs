// End-to-End-Test der Windows-App: startet astrotool.exe mit lokalem WebView2-Debug-Port und
// bedient die Oberfläche wie ein Mensch (Dateien wählen, Vorlage, Zeitraffer, Start).
// Das Ergebnis (MP4) wird gespeichert und kann mit ffprobe geprüft werden.
//
// Aufruf:
//   node scripts/app-e2e.mjs <astrotool.exe> <Bilderordner> <Ausgabedatei.mp4> [hevc|h264|gif]
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [exe, folder, outFile, format = "hevc"] = process.argv.slice(2);
if (!exe || !folder || !outFile) {
  console.error("Aufruf: node scripts/app-e2e.mjs <astrotool.exe> <Bilderordner> <Ausgabe.mp4> [hevc|h264|gif]");
  process.exit(2);
}
const PORT = 9333;
const files = readdirSync(folder).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).map((f) => resolve(join(folder, f)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --remote-allow-origins=http://127.0.0.1:${PORT}` },
  stdio: "ignore",
});

let ws;
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

try {
  // Debug-Schnittstelle abwarten
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* noch nicht bereit */ }
  }
  if (!target) throw new Error("WebView2-Debug-Schnittstelle nicht erreichbar – läuft noch eine Astrotool-Instanz oder hängen msedgewebview2-Prozesse mit dem Datenordner ch.aisuisse.astrotool? Diese beenden und erneut starten.");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  await sleep(1000);
  console.log("App:", await evaluate("navigator.userAgent"));
  console.log("Desktop-App erkannt:", await evaluate("'__TAURI_INTERNALS__' in window"));

  // Dateien wählen wie über den Öffnen-Dialog
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
  await cdp("DOM.setFileInputFiles", { nodeId, files });
  console.log(`${files.length} Bilder ausgewählt`);
  await evaluate(`new Promise(r => { const t = setInterval(() => { if (!document.getElementById('viewer').hidden) { clearInterval(t); r(); } }, 300); })`);
  await sleep(1500);

  // Vorlage "Finsternis", nur Zeitraffer im gewünschten Format
  const tlFormat = { hevc: "mp4-hevc", h264: "mp4-h264", gif: "gif" }[format];
  await evaluate(`(async () => {
    document.querySelector('[data-preset="eclipse"]').click();
    await new Promise(r => setTimeout(r, 1500));
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('change')); };
    set('#format', 'none');
    set('[data-tl="format"]', '${tlFormat}');
    set('[data-tl="title"]', 'Partielle Sonnenfinsternis 12.08.2026');
    document.getElementById('run').click();
  })()`);
  console.log("Verarbeitung läuft …");
  const t0 = Date.now();
  let last = "";
  for (;;) {
    await sleep(2000);
    const st = await evaluate(`({ done: !document.getElementById('result').hidden, err: document.getElementById('error').innerText, p: document.getElementById('progressLabel').innerText })`);
    if (st.p !== last) { process.stdout.write(`  ${st.p}\n`); last = st.p; }
    if (st.err) throw new Error("App meldet: " + st.err);
    if (st.done) break;
    if (Date.now() - t0 > 15 * 60_000) throw new Error("Zeitüberschreitung");
  }
  const result = await evaluate("document.getElementById('result').innerText");
  console.log("Ergebnis:\n" + result.split("\n").map((l) => "  " + l).join("\n"));

  // Video aus der App holen (Blob-URL → Base64)
  const b64 = await evaluate(`(async () => {
    const a = [...document.querySelectorAll('#result a')].find(x => /\\.(mp4|webm|gif)$/.test(x.download));
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  writeFileSync(outFile, Buffer.from(b64, "base64"));
  console.log(`Gespeichert: ${outFile} (${(Buffer.byteLength(b64, "base64") / 1048576).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} catch (e) {
  console.error("FEHLER:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* egal */ }
  app.kill();
}
