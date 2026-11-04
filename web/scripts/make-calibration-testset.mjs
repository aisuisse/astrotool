// Künstliche Kalibrierbilder passend zu einer SER-Aufnahme (gleiche Grösse, Bittiefe, Farbcode):
// dark.ser (Offset + heisse Pixel, in einem Bild ein „kosmischer Strahl“), flat.ser (Vignettierung, Staubring,
// Bayer-Empfindlichkeit), bias.ser (nur Offset). Für den App-Volltest.
// Aufruf: node scripts/make-calibration-testset.mjs <aufnahme.ser> <zielordner>
import { mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [serPath, outDir] = process.argv.slice(2);
if (!serPath || !outDir) {
  console.error("Aufruf: node scripts/make-calibration-testset.mjs <aufnahme.ser> <zielordner>");
  process.exit(2);
}
const head = Buffer.alloc(178);
readSync(openSync(serPath, "r"), head, 0, 178, 0);
const colorId = head.readInt32LE(18), W = head.readInt32LE(26), H = head.readInt32LE(30), bitDepth = head.readInt32LE(34);
const max = 2 ** bitDepth - 1, bytes = bitDepth > 8 ? 2 : 1;
mkdirSync(outDir, { recursive: true });

function ser(name, frames, value) {
  const h = Buffer.from(head);
  h.writeInt32LE(frames, 38);
  const data = Buffer.alloc(W * H * bytes * frames);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < frames; k++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = Math.max(0, Math.min(max, Math.round(value(x, y, k, rnd))));
        const o = ((k * H + y) * W + x) * bytes;
        if (bytes === 2) data.writeUInt16LE(v, o); else data[o] = v;
      }
  writeFileSync(join(outDir, name), Buffer.concat([h, data]));
}

const s = max / 255;
const hot = new Set(Array.from({ length: 60 }, (_, i) => ((i * 7919) % H) * W + ((i * 104729) % W)));
const offset = 6 * s;
ser("dark.ser", 6, (x, y, k, rnd) => offset + (rnd() - 0.5) * 3 * s + (hot.has(y * W + x) ? 180 * s : 0) + (k === 3 && x === 100 && y === 100 ? 240 * s : 0));
const vignette = (x, y) => 1 - 0.5 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 4;
const dust = (x, y) => { const r = Math.hypot(x - W * 0.7, y - H * 0.3); return r > 18 && r < 30 ? 0.7 : 1; };
const cfaGain = (x, y) => [1, 0.85, 0.85, 0.6][((y & 1) << 1) | (x & 1)];
ser("flat.ser", 6, (x, y, k, rnd) => offset + 160 * s * vignette(x, y) * dust(x, y) * cfaGain(x, y) + (rnd() - 0.5) * 2 * s);
ser("bias.ser", 3, (x, y, k, rnd) => offset + (rnd() - 0.5) * 3 * s);
console.log(`${W} × ${H}, ${bitDepth} bit, Farbcode ${colorId}: dark.ser, flat.ser, bias.ser in ${outDir}`);
