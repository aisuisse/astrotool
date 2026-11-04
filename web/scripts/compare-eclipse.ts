// Vergleicht die Zentrierung von PIPP mit Astrotool an einer echten Finsternis-Serie.
//
// Aufruf (Dateien werden nur gelesen):
//   npx vite-node scripts/compare-eclipse.ts -- <JPG-Ordner> <PIPP-Ausgabeordner> <Ergebnisordner>
//
// Misst für jedes Bild:
//  - wo PIPP die Sonnenscheibe im 1080×1080-Ergebnis platziert hat (Kreisanpassung auf PIPPs PNG),
//  - wo Astrotool sie platziert (Kreisanpassung auf dem Astrotool-Ausschnitt).
// Ideal: Scheibenmitte genau in der Bildmitte, in allen Bildern gleich.
// Schreibt vergleich.csv und ueberlagerung.png (Mittelwert aller Ergebnisse: links PIPP, rechts Astrotool).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { cropFrame, cropOrigin, detectObject, toLum, type Lum } from "../src/engine/image";
import { fitSunDisc } from "../src/engine/limb";
import { rejectRadiusOutliers, type FrameResult } from "../src/engine/pipeline";
import { SerColor, type Frame } from "../src/engine/ser";
import { exifTimeMs, readExif } from "../src/engine/exif";

const [jpgDir, pippDir, outDir] = process.argv.slice(2).filter((a) => a !== "--");
if (!jpgDir || !pippDir || !outDir) throw new Error("Aufruf: compare-eclipse.ts <JPG-Ordner> <PIPP-Ordner> <Ergebnisordner>");
mkdirSync(outDir, { recursive: true });
const SIZE = 1080;
const mid = (SIZE - 1) / 2;

function rgbFrame(width: number, height: number, rgba: Uint8Array): Frame {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    data[j] = rgba[i * 4];
    data[j + 1] = rgba[i * 4 + 1];
    data[j + 2] = rgba[i * 4 + 2];
  }
  return { width, height, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data };
}

function pngLum(path: string): Lum {
  const p = PNG.sync.read(readFileSync(path));
  return toLum(rgbFrame(p.width, p.height, p.data));
}

const stats = (xs: number[]) => {
  const n = xs.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return { mean, max: Math.max(0, ...xs), sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) };
};

const files = readdirSync(jpgDir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const sumPipp = new Float64Array(SIZE * SIZE), sumAstro = new Float64Array(SIZE * SIZE);
let nPipp = 0, nAstro = 0;
const rows = ["bild;zeit;pipp_vorhanden;pipp_versatz_x;pipp_versatz_y;pipp_versatz;astro_versatz_x;astro_versatz_y;astro_versatz;sonnen_radius;rand_sichtbar;schwerpunkt_abstand_zur_mitte"];
const pippErr: number[] = [], centroidErr: number[] = [];
let astroRejected = 0;
interface Rec { name: string; row: string[]; ax: number; ay: number; crop: Uint8Array | null; res: FrameResult }
const recs: Rec[] = [];

for (const f of files) {
  const name = basename(f).replace(/\.[^.]+$/, "");
  const buf = readFileSync(join(jpgDir, f));
  const t = exifTimeMs(readExif(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.min(buf.length, 131072))));
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
  const frame = rgbFrame(img.width, img.height, img.data);
  const lum = toLum(frame);
  const centroid = detectObject(lum);
  const disc = fitSunDisc(lum);

  // Astrotool: Ausschnitt um die Scheibenmitte, dann unabhängig nachmessen
  let ax = NaN, ay = NaN;
  let cropBytes: Uint8Array | null = null;
  if (disc.found) {
    const [x0, y0] = cropOrigin(disc.cx, disc.cy, SIZE, SIZE, SerColor.RGB);
    const crop = toLum(cropFrame(frame, x0, y0, SIZE, SIZE));
    const check = fitSunDisc(crop);
    if (check.found) { ax = check.cx - mid; ay = check.cy - mid; }
    cropBytes = Uint8Array.from(crop.data, (v) => Math.round(v * 255));
    centroidErr.push(Math.hypot(centroid.cx - disc.cx, centroid.cy - disc.cy));
  }

  // PIPP: dessen Ergebnis-PNG (gleicher Name) nachmessen
  const pippPng = join(pippDir, `${name}.png`);
  let px = NaN, py = NaN;
  const hasPipp = existsSync(pippPng);
  if (hasPipp) {
    const pl = pngLum(pippPng);
    const pf = fitSunDisc(pl);
    if (pf.found) {
      px = pf.cx - mid; py = pf.cy - mid;
      pippErr.push(Math.hypot(px, py));
    }
    for (let i = 0; i < pl.data.length; i++) sumPipp[i] += pl.data[i];
    nPipp++;
  }
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "");
  const res: FrameResult = {
    index: recs.length, score: 0, accepted: disc.found, reason: disc.found ? undefined : "kein Sonnenrand",
    det: { ...centroid, disc: disc.found ? { cx: disc.cx, cy: disc.cy, r: disc.r, visibleLimb: disc.visibleLimb, rms: disc.rms } : undefined },
  };
  recs.push({ name, ax, ay, crop: cropBytes, res, row: [
    name, t ? new Date(t).toISOString().slice(11, 19) : "", hasPipp ? 1 : 0,
    fmt(px), fmt(py), fmt(Math.hypot(px, py)), fmt(ax), fmt(ay), fmt(Math.hypot(ax, ay)),
    disc.found ? disc.r.toFixed(1) : "", disc.found ? disc.visibleLimb.toFixed(2) : "",
    disc.found ? Math.hypot(centroid.cx - disc.cx, centroid.cy - disc.cy).toFixed(1) : "",
  ] });
  process.stdout.write(`${name} PIPP ${fmt(Math.hypot(px, py)).padStart(6)} px | Astrotool ${fmt(Math.hypot(ax, ay)).padStart(5)} px | sichtbarer Rand ${disc.found ? (disc.visibleLimb * 100).toFixed(0) : "-"} %\n`);
}
// Gleiche Regel wie in Astrotool: Frames mit stark abweichendem Radius verwerfen
rejectRadiusOutliers(recs.map((r) => r.res));
const astroErr: number[] = [], radii: number[] = [];
for (const r of recs) {
  r.row.push(r.res.accepted ? "ja" : `nein: ${r.res.reason ?? ""}`);
  rows.push(r.row.join(";"));
  if (!r.res.accepted) { astroRejected++; continue; }
  radii.push(r.res.det.disc!.r);
  if (Number.isFinite(r.ax)) astroErr.push(Math.hypot(r.ax, r.ay));
  if (r.crop) { for (let i = 0; i < r.crop.length; i++) sumAstro[i] += r.crop[i] / 255; nAstro++; }
}
rows[0] += ";astrotool_verwendet";
writeFileSync(join(outDir, "vergleich.csv"), rows.join("\r\n") + "\r\n");

// Überlagerung: Mittelwert aller Ergebnisbilder, nebeneinander (je 540 px)
const H = SIZE / 2, out = new PNG({ width: SIZE + 20, height: H });
out.data.fill(0);
const put = (sum: Float64Array, n: number, ox: number) => {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < H; x++) {
      let v = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v += sum[(2 * y + j) * SIZE + 2 * x + i];
      const g = Math.min(255, Math.round(((v / 4) / Math.max(1, n)) * 255));
      const o = (y * out.width + ox + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = g;
      out.data[o + 3] = 255;
    }
};
put(sumPipp, nPipp, 0);
put(sumAstro, nAstro, H + 20);
for (let y = 0; y < H; y++) { const o = (y * out.width + H) * 4; for (let k = 0; k < 20 * 4; k += 4) out.data[o + k + 3] = 255; }
writeFileSync(join(outDir, "ueberlagerung.png"), PNG.sync.write(out));

const P = stats(pippErr), A = stats(astroErr), C = stats(centroidErr), R = stats(radii);
const summary = {
  bilder: files.length,
  pipp: { ergebnisse: nPipp, versatz_mittel_px: +P.mean.toFixed(1), versatz_max_px: +P.max.toFixed(1), streuung_px: +P.sd.toFixed(1) },
  astrotool: { ergebnisse: nAstro, verworfen: astroRejected, versatz_mittel_px: +A.mean.toFixed(2), versatz_max_px: +A.max.toFixed(2), streuung_px: +A.sd.toFixed(2) },
  sonnenradius_px: { mittel: +R.mean.toFixed(1), streuung: +R.sd.toFixed(2) },
  schwerpunkt_neben_sonnenmitte_px: { mittel: +C.mean.toFixed(1), max: +C.max.toFixed(1) },
};
writeFileSync(join(outDir, "zusammenfassung.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
