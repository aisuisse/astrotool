// Erzeugt eine künstliche totale Finsternis als JPG-Serie mit EXIF (Zeit, Belichtung) – für den Test der App.
// Aufruf: node scripts/make-totality-testset.mjs <ausgabeordner> [breite] [höhe]
// Inhalt: 4 partielle Bilder (mit Filter), 3 Belichtungsreihen à 5 Bilder in der Totalität, 3 partielle Bilder.
// Die Kamera ist nicht nachgeführt: Die Sonne wandert langsam durchs Bild.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { exifApp1, expose, partialImage, totalityRadiance, withExif } from "./totality-model.mjs";

const [out, wArg, hArg] = process.argv.slice(2);
if (!out) {
  console.error("Aufruf: node scripts/make-totality-testset.mjs <ausgabeordner> [breite] [höhe]");
  process.exit(1);
}
const W = Number(wArg ?? 1600), H = Number(hArg ?? 1200), R = Math.round(Math.min(W, H) / 6);
mkdirSync(out, { recursive: true });

const t0 = Date.UTC(2027, 7, 2, 10, 50, 0); // Kamerazeit
const stamp = (sec) => {
  const d = new Date(t0 + sec * 1000);
  const p = (n, k = 2) => String(n).padStart(k, "0");
  return { date: `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`, subSec: p(d.getUTCMilliseconds(), 3) };
};
const drift = (sec) => [W / 2 - 0.15 * W + sec * 0.4, H / 2 + 0.05 * H - sec * 0.12];
let n = 0;
const save = (rgba, sec, exposure) => {
  const jpg = jpeg.encode({ data: rgba, width: W, height: H }, 92).data;
  const name = `TOT_${String(++n).padStart(4, "0")}.JPG`;
  writeFileSync(join(out, name), withExif(new Uint8Array(jpg), exifApp1({ ...stamp(sec), exposure, fNumber: 8, iso: 100, model: "Astrotool Testkamera" })));
  return name;
};

// Der Mond zieht gleichmässig vor der Sonne vorbei: Abstand Mond − Sonne = (v · (T − t), −1.5 px).
// Totalität, solange der Abstand kleiner ist als die Radiusdifferenz (Mond 3 % grösser).
const T = 455, v = 0.15;
const moonAt = (sec, sx, sy) => ({ mx: sx + v * (T - sec), my: sy - 1.5 });
// Partielle Phasen vor dem 2. Kontakt
for (const sec of [0, 120, 240, 360]) {
  const [sx, sy] = drift(sec);
  save(partialImage(W, H, { sx, sy, ...moonAt(sec, sx, sy), R }, sec), sec, 1 / 2000);
}
// Totalität: 3 Reihen 1/1000 … 1/4 s (Faktor 4 je Stufe)
const times = [1 / 1000, 1 / 250, 1 / 60, 1 / 15, 1 / 4];
for (const start of [420, 450, 480]) {
  let sec = start;
  for (const t of times) {
    const [sx, sy] = drift(sec);
    const rad = totalityRadiance(W, H, { sx, sy, ...moonAt(sec, sx, sy), R });
    save(expose(rad, W, H, t * 500, Math.round(sec * 10)), sec, t);
    sec += t + 0.35;
  }
}
// Nach dem 3. Kontakt
for (const sec of [560, 680, 800]) {
  const [sx, sy] = drift(sec);
  save(partialImage(W, H, { sx, sy, ...moonAt(sec, sx, sy), R }, sec), sec, 1 / 2000);
}
console.log(`${n} Bilder (${W} × ${H}, Sonnenradius ${R} px) in ${out}`);
