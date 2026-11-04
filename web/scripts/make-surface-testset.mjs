// Künstliche Mond-Nahaufnahme als SER für die Oberflächen-Stabilisierung (App-Volltest):
// Kraterlandschaft, Bildzittern (±12 px), langsame Drift, wechselnde Luftunruhe (Unschärfe), Rauschen und zwei
// „Wolkenbilder“ ohne Struktur. 640 × 480, 8 bit grau, mit Zeitstempeln.
// Aufruf: node scripts/make-surface-testset.mjs <ziel.ser> [bilder=62]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [out, countArg] = process.argv.slice(2);
if (!out) {
  console.error("Aufruf: node scripts/make-surface-testset.mjs <ziel.ser> [bilder=62]");
  process.exit(2);
}
const n = Number(countArg) || 62, W = 640, H = 480, S = 1200;
let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const mix = (h) => { h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return h ^ (h >>> 16); };
const hash = (x, y, s) => (mix(mix(mix(s + 0x9e3779b9) ^ x) ^ y) >>> 0) / 4294967296;

// Oberfläche S × S
const g = new Float32Array(S * S).fill(0.42);
for (let k = 0; k < 1100; k++) {
  const cx = rnd() * S, cy = rnd() * S, rad = 3 + rnd() ** 3 * 70, R = Math.ceil(rad * 1.3);
  for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(S, cy + R); y++)
    for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(S, cx + R); x++) {
      const d = Math.hypot(x - cx, y - cy) / rad;
      if (d < 1.3) g[y * S + x] += d < 1 ? -0.2 * (1 - d) * ((x - cx) / rad) - 0.04 : 0.1 * (1.3 - d);
    }
}
for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(1, g[i] + (hash(i % S, Math.floor(i / S), 1) - 0.5) * 0.06));
const at = (x, y) => {
  const x0 = Math.max(0, Math.min(S - 2, Math.floor(x))), y0 = Math.max(0, Math.min(S - 2, Math.floor(y)));
  const fx = x - x0, fy = y - y0, i = y0 * S + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + S] * (1 - fx) + g[i + S + 1] * fx) * fy;
};

const header = Buffer.alloc(178);
header.write("LUCAM-RECORDER", 0, "latin1");
header.writeInt32LE(0, 14); header.writeInt32LE(0, 18); header.writeInt32LE(0, 22);
header.writeInt32LE(W, 26); header.writeInt32LE(H, 30); header.writeInt32LE(8, 34); header.writeInt32LE(n, 38);
header.write("Astrotool surface test", 42 + 40, "latin1");
const t0 = 638_000_000_000_000_000n;
header.writeBigInt64LE(t0, 162); header.writeBigInt64LE(t0, 170);
const frames = Buffer.alloc(W * H * n);
const stamps = Buffer.alloc(8 * n);
const clouds = new Set([20, 41]);
const truth = [];
for (let k = 0; k < n; k++) {
  const dx = 0.3 * k + (rnd() - 0.5) * 24, dy = -0.2 * k + (rnd() - 0.5) * 24, blur = rnd() * 2.5;
  truth.push([dx, dy]);
  const img = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = x - dx + 280, sy = y - dy + 360;
      // Unschärfe: Mittel aus 5 Punkten im Abstand blur
      const v = clouds.has(k) ? 0.45 : (at(sx, sy) * 2 + at(sx - blur, sy) + at(sx + blur, sy) + at(sx, sy - blur) + at(sx, sy + blur)) / 6;
      img[y * W + x] = v + (hash(x, y, 100 + k) - 0.5) * 0.04;
    }
  for (let i = 0; i < W * H; i++) frames[k * W * H + i] = Math.max(0, Math.min(255, Math.round(img[i] * 255)));
  stamps.writeBigInt64LE(t0 + BigInt(k) * 333_333n, k * 8);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, frames, stamps]));
console.log(`${n} Bilder ${W} × ${H} (Wolken: ${[...clouds].join(", ")}) → ${out}`);
