// Untersucht eine SER-Datei und verarbeitet sie probeweise mit der Astrotool-Engine.
// Aufruf: npx vite-node scripts/inspect-ser.ts -- <datei.ser> <ausgabeordner> [maxFrames]
// Schreibt: <name>_astro.ser, vorschau_eingabe.png, vorschau_ausgabe.png, qualitaet.csv
import { openAsBlob } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PNG } from "pngjs";
import { defaultOptions, processSer } from "../src/engine/pipeline";
import { colorName, SerReader, type Frame } from "../src/engine/ser";
import { detectObject, toLum } from "../src/engine/image";

const [file, outDir, maxArg] = process.argv.slice(2).filter((a) => a !== "--");
if (!file || !outDir) throw new Error("Aufruf: inspect-ser.ts <datei.ser> <ausgabeordner> [maxFrames]");
mkdirSync(outDir, { recursive: true });

/** Graustufen-Vorschau mit automatischer Streckung (Bayer-Rohdaten erscheinen als feines Muster). */
function previewPng(f: Frame, path: string) {
  const p = new PNG({ width: f.width, height: f.height });
  let max = 1;
  for (const v of f.data) if (v > max) max = v;
  for (let i = 0; i < f.width * f.height; i++) {
    const v = f.planes === 3 ? (f.data[i * 3] + f.data[i * 3 + 1] + f.data[i * 3 + 2]) / 3 : f.data[i];
    const g = Math.min(255, Math.round((v / max) * 255));
    p.data[i * 4] = p.data[i * 4 + 1] = p.data[i * 4 + 2] = g;
    p.data[i * 4 + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(p));
}

const blob = await openAsBlob(file);
const r = await SerReader.open(blob);
const h = r.header;
const ts = await r.readTimestamps();
const info: Record<string, unknown> = {
  datei: basename(file),
  bytes: blob.size,
  groesse: `${h.width} × ${h.height}`,
  frames: h.frameCount,
  farbe: `${colorName(h.colorId)} (ColorID ${h.colorId})`,
  bittiefe: h.bitDepth,
  littleEndianFlag: h.littleEndianFlag,
  beobachter: h.observer, kamera: h.instrument, teleskop: h.telescope,
  zeitstempel: !!ts,
};
if (ts && ts.length > 1) {
  const toIso = (t: bigint) => new Date(Number((t - 621_355_968_000_000_000n) / 10_000n)).toISOString();
  info.start_utc = toIso(ts[0]);
  info.dauer_s = Number(ts[ts.length - 1] - ts[0]) / 1e7;
  info.fps = ((ts.length - 1) * 1e7) / Number(ts[ts.length - 1] - ts[0]);
}
// Wertebereich des ersten Frames (zeigt, ob 16-bit-Daten z. B. nur 12 bit nutzen)
const f0 = await r.readFrame(0);
let min = Infinity, max = 0;
for (const v of f0.data) { if (v < min) min = v; if (v > max) max = v; }
info.erstes_frame_min_max = [min, max];
const d0 = detectObject(toLum(f0));
info.objekt_frame0 = { gefunden: d0.found, mitte: [+d0.cx.toFixed(1), +d0.cy.toFixed(1)], groesse_px: d0.size, randberuehrung: d0.touchesEdge };
console.log(JSON.stringify(info, null, 2));
previewPng(f0, join(outDir, "vorschau_eingabe.png"));

// Probeverarbeitung: Vorlage "Planet", Ausschnitt an Objektgrösse angepasst
const crop = Math.min(h.width, h.height, Math.max(64, Math.ceil((d0.size * 1.6) / 16) * 16));
const opts = { ...defaultOptions, cropWidth: crop, cropHeight: crop, maxFrames: Number(maxArg ?? 0), keepMode: "percent" as const, keepValue: 50 };
const t0 = performance.now();
let last = 0;
const { blob: out, report } = await processSer(r, opts, (phase, done, total) => {
  const now = performance.now();
  if (now - last > 3000 || done === total) { last = now; console.log(`  ${phase} ${done}/${total}`); }
});
const secs = (performance.now() - t0) / 1000;
const outName = `${basename(file).replace(/\.ser$/i, "")}_astro.ser`;
writeFileSync(join(outDir, outName), Buffer.from(await out.arrayBuffer()));
const outReader = await SerReader.open(out);
previewPng(await outReader.readFrame(0), join(outDir, "vorschau_ausgabe.png"));
writeFileSync(join(outDir, "qualitaet.csv"), "frame;akzeptiert;grund;mitte_x;mitte_y;groesse;qualitaet\r\n" +
  report.frames.map((f) => [f.index, f.accepted ? 1 : 0, f.reason ?? "", f.det.cx.toFixed(1), f.det.cy.toFixed(1), f.det.size, f.score.toPrecision(5)].join(";")).join("\r\n"));
const xs = report.frames.filter((f) => f.accepted).map((f) => f.det.cx), ys = report.frames.filter((f) => f.accepted).map((f) => f.det.cy);
const span = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
console.log(JSON.stringify({
  verarbeitet: report.frames.length,
  verworfen: report.frames.filter((f) => !f.accepted).length,
  geschrieben: report.written.length,
  ausschnitt: `${report.outWidth} × ${report.outHeight}`,
  planet_wanderte_px: { x: +span(xs).toFixed(1), y: +span(ys).toFixed(1) },
  sekunden: +secs.toFixed(1),
  frames_pro_s: +(report.frames.length / secs).toFixed(1),
  ausgabe_mb: +(out.size / 1048576).toFixed(1),
}, null, 2));
