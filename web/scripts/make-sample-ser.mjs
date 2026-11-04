// Erzeugt ein synthetisches Planeten-Video (SER) zum Ausprobieren:
// eine Scheibe mit Bändern, die zittert (Seeing) und unterschiedlich unscharf ist.
// Aufruf: node scripts/make-sample-ser.mjs [ausgabe.ser] [frames]
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "sample-jupiter.ser";
const N = Number(process.argv[3] ?? 200);
const W = 640, H = 480, R = 70;

function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const rand = rnd(42);

const header = Buffer.alloc(178);
header.write("LUCAM-RECORDER", 0, "latin1");
header.writeInt32LE(0, 14); header.writeInt32LE(0, 18); header.writeInt32LE(0, 22);
header.writeInt32LE(W, 26); header.writeInt32LE(H, 30); header.writeInt32LE(8, 34); header.writeInt32LE(N, 38);
header.write("Astrotool", 42, "latin1"); header.write("Testkamera", 82, "latin1"); header.write("Synthetisch", 122, "latin1");

const frames = [];
const stamps = Buffer.alloc(8 * N);
const t0 = 638_000_000_000_000_000n;
for (let f = 0; f < N; f++) {
  const cx = W / 2 + (rand() - 0.5) * 160, cy = H / 2 + (rand() - 0.5) * 120;
  const blur = 0.5 + rand() * 4; // Kantenbreite in Pixel = Unschärfe
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = (y - cy) * 1.07, d = Math.hypot(dx, dy);
    const edge = 1 / (1 + Math.exp((d - R) / blur));
    const bands = 0.75 + 0.25 * Math.cos((dy / R) * 9 + Math.sin(dx / 12) * (1.5 / blur));
    const v = 12 + 200 * edge * bands * (1 - 0.35 * (d / R) ** 2) + (rand() - 0.5) * 10;
    buf[y * W + x] = Math.max(0, Math.min(255, v));
  }
  frames.push(buf);
  stamps.writeBigInt64LE(t0 + BigInt(f) * 200_000n, f * 8);
}
writeFileSync(out, Buffer.concat([header, ...frames, stamps]));
console.log(`${out}: ${N} Frames ${W}×${H}`);
