import { describe, expect, it } from "vitest";
import { clampAnchor, fft, SurfaceAligner } from "../src/engine/surface";
import type { Lum } from "../src/engine/image";
import { defaultOptions, processSer } from "../src/engine/pipeline";
import { SerColor, SerReader, SerWriter } from "../src/engine/ser";

/** Zufallszahlen mit festem Startwert */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * Kraterlandschaft auf einem Gitter size × size: Grundhelligkeit, Krater (Ringwall + Schatten), feine Wellen.
 * Abgetastet bilinear – schnell und auch für Bruchteil-Verschiebungen.
 */
export function moonSurface(seed = 7, size = 900, count = 160) {
  const r = rng(seed);
  const g = new Float32Array(size * size).fill(0.45);
  for (let k = 0; k < count; k++) {
    const cx = r() * size, cy = r() * size, rad = 4 + r() ** 3 * 60, R = Math.ceil(rad * 1.3);
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(size, cy + R); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(size, cx + R); x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d < 1.3) g[y * size + x] += d < 1 ? -0.18 * (1 - d) * ((x - cx) / rad) - 0.05 : 0.12 * (1.3 - d);
      }
  }
  for (let q = 0; q < 12; q++) {
    const kx = (r() - 0.5) * 0.3, ky = (r() - 0.5) * 0.3, p = r() * 6.28, amp = 0.01 + r() * 0.02;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) g[y * size + x] += amp * Math.sin(kx * x + ky * y + p);
  }
  for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(1, g[i]));
  return (x: number, y: number) => {
    const x0 = Math.max(0, Math.min(size - 2, Math.floor(x))), y0 = Math.max(0, Math.min(size - 2, Math.floor(y)));
    const fx = x - x0, fy = y - y0, i = y0 * size + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + size] * (1 - fx) + g[i + size + 1] * fx) * fy;
  };
}

// Rauschen je Pixel aus Position und Startwert (ein einfacher Zufallsgenerator liefert bei anderem Startwert nur
// dieselbe Folge verschoben – das wäre selbst ein verschiebbares Muster)
const mix = (h: number) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
};
const hash = (x: number, y: number, s: number) => (mix(mix(mix(s + 0x9e3779b9) ^ x) ^ y) >>> 0) / 4294967296;

function frame(tex: (x: number, y: number) => number, w: number, h: number, dx: number, dy: number, noise: number, seed: number): Lum {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = tex(x - dx + 300, y - dy + 300) + (hash(x, y, seed) - 0.5) * noise;
  return { width: w, height: h, data };
}

describe("FFT", () => {
  it("hin und zurück ergibt die Eingabe; Einheitsimpuls → flaches Spektrum", () => {
    const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + i / 10), im = new Float64Array(n);
    const orig = Float64Array.from(re);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(orig[i], 9);
    const a = new Float64Array(8), b = new Float64Array(8);
    a[0] = 1;
    fft(a, b);
    expect(Array.from(a)).toEqual(Array(8).fill(1));
  });
});

describe("Oberflächen-Ausrichtung", () => {
  const tex = moonSurface();
  const W = 400, H = 300;
  const ref = frame(tex, W, H, 0, 0, 0.04, 1);
  const al = new SurfaceAligner(ref);

  it("findet bekannte Verschiebungen auf Bruchteile eines Pixels genau – auch grosse und bei Rauschen", () => {
    const cases: [number, number][] = [[0, 0], [3.5, -2.25], [-17.3, 8.6], [41, -33], [-80, 55], [0.4, 0.7]];
    for (const [k, [dx, dy]] of cases.entries()) {
      const s = al.align(frame(tex, W, H, dx, dy, 0.04, 10 + k));
      // grosse Verschiebung: ein Fünftel des Inhalts verlässt das Bild – dann ±1 Pixel
      const tol = Math.hypot(dx, dy) > 50 ? 1 : 0.35;
      expect(Math.abs(s.dx - dx), `dx ${dx}: ${s.dx}`).toBeLessThan(tol);
      expect(Math.abs(s.dy - dy), `dy ${dy}: ${s.dy}`).toBeLessThan(tol);
      expect(s.peak).toBeGreaterThan(0.35);
    }
  });

  it("Bild ohne gemeinsame Struktur (nur Rauschen, anderes Gebiet): geringe Sicherheit", () => {
    const noise = frame(() => 0.5, W, H, 0, 0, 0.3, 99);
    const other = frame(moonSurface(1234), W, H, 0, 0, 0.04, 5);
    expect(al.align(noise).peak).toBeLessThan(0.25);
    expect(al.align(other).peak).toBeLessThan(0.25);
  });

  it("grosses Bild (1280 × 960, Feinstufe in voller Auflösung): auf ein halbes Pixel genau", () => {
    const big = moonSurface(3, 1800, 1500);
    const al2 = new SurfaceAligner(frame(big, 1280, 960, 0, 0, 0.04, 2));
    for (const [k, [dx, dy]] of ([[12.4, -7.7], [-63.2, 21.5], [140, 90]] as [number, number][]).entries()) {
      const s = al2.align(frame(big, 1280, 960, dx, dy, 0.04, 30 + k));
      expect(Math.abs(s.dx - dx), `dx ${dx}: ${s.dx}`).toBeLessThan(0.5);
      expect(Math.abs(s.dy - dy), `dy ${dy}: ${s.dy}`).toBeLessThan(0.5);
    }
  }, 60_000);
});

describe("Oberflächen-Stabilisierung in der Verarbeitung", () => {
  it("SER mit Zittern: Ausgabebilder deckungsgleich, Wolkenbilder verworfen", async () => {
    const tex = moonSurface(11);
    const W = 320, H = 240;
    const jitter: [number, number][] = [[0, 0], [6, -4], [-9, 3], [12, 7], [-3, -11], [8, 2], [-14, 9], [4, -6]];
    const w = new SerWriter({ luId: 0, colorId: SerColor.MONO, littleEndianFlag: 0, width: W, height: H, bitDepth: 8, observer: "", instrument: "", telescope: "", dateTime: 0n, dateTimeUtc: 0n });
    const add = (f: Lum, k: number) => w.add({ width: W, height: H, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: Uint8Array.from(f.data, (v) => Math.max(0, Math.min(255, Math.round(v * 255)))) }, BigInt(k + 1));
    jitter.forEach(([dx, dy], k) => add(frame(tex, W, H, dx, dy, 0.03, 50 + k), k));
    add(frame(() => 0.5, W, H, 0, 0, 0.02, 98), 8); // Wolke: keine Struktur
    add(frame(() => 0.3, W, H, 0, 0, 0.02, 99), 9);
    const r = await SerReader.open(w.toBlob());
    const o = { ...defaultOptions, centreMode: "surface" as const, cropWidth: 280, cropHeight: 200, qualityEnabled: false };
    const { blob, report } = await processSer(r, o);
    expect(report.frames.filter((f) => !f.accepted).map((f) => f.index)).toEqual([8, 9]);
    expect(report.frames[8].reason).toMatch(/noSurface/);
    // gemessene Verschiebungen wie vorgegeben
    for (const [k, [dx, dy]] of jitter.entries()) {
      const s = report.frames[k].det.surface!;
      expect(Math.abs(s.dx - dx) + Math.abs(s.dy - dy), `Bild ${k}`).toBeLessThan(0.8);
    }
    // Ausgabe: alle Bilder zeigen dieselbe Stelle (mittlere Abweichung ≈ Rauschen)
    const out = await SerReader.open(blob);
    expect([out.header.frameCount, out.header.width, out.header.height]).toEqual([8, 280, 200]);
    const f0 = (await out.readFrame(0)).data;
    for (let k = 1; k < 8; k++) {
      const fk = (await out.readFrame(k)).data;
      let d = 0, n = 0;
      for (let y = 20; y < 180; y++) for (let x = 20; x < 260; x++) { d += Math.abs(fk[y * 280 + x] - f0[y * 280 + x]); n++; }
      expect(d / n, `Bild ${k}`).toBeLessThan(6); // Rauschen ±4 Graustufen, Rundung auf ganze Pixel
    }
  }, 60_000);
});

describe("Ankerbox", () => {
  const tex = moonSurface(21);
  const W = 400, H = 300;

  it("wird ins Bild gelegt; zu klein oder fehlend → ganzes Bild", () => {
    expect(clampAnchor(null, W, H)).toBeNull();
    expect(clampAnchor({ x: 10, y: 10, width: 10, height: 80 }, W, H)).toBeNull();
    expect(clampAnchor({ x: -20, y: 250, width: 100, height: 100 }, W, H)).toEqual({ x: 0, y: 250, width: 80, height: 50 });
    expect(new SurfaceAligner(frame(tex, W, H, 0, 0, 0.04, 1), { x: 0, y: 0, width: 5, height: 5 }).region).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  it("nur die markante Stelle zählt: ein anders bewegter Bildteil stört nicht mehr", () => {
    // links die Oberfläche (verschiebt sich um dx, dy), rechts ein zweites, stärker strukturiertes Gebiet,
    // das sich anders bewegt (z. B. Wolkenrand, Spiegelung) – über das ganze Bild gewinnt der falsche Teil
    const other = moonSurface(77, 900, 400);
    const scene = (dx: number, dy: number, seed: number): ReturnType<typeof frame> => {
      const a = frame(tex, W, H, dx, dy, 0.04, seed), b = frame(other, W, H, -2 * dx, 3, 0.04, seed + 500);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x >= 220) a.data[y * W + x] = 1.6 * b.data[y * W + x] - 0.3;
      return a;
    };
    const ref = scene(0, 0, 1);
    const box = { x: 40, y: 60, width: 140, height: 160 };
    for (const [k, [dx, dy]] of ([[6, -4], [-9, 7], [11, 5]] as [number, number][]).entries()) {
      const cur = scene(dx, dy, 20 + k);
      const whole = new SurfaceAligner(ref).align(cur), anchored = new SurfaceAligner(ref, box).align(cur);
      expect(Math.hypot(anchored.dx - dx, anchored.dy - dy), `Anker ${dx},${dy}`).toBeLessThan(0.5);
      expect(anchored.peak).toBeGreaterThan(0.35);
      expect(Math.hypot(whole.dx - dx, whole.dy - dy), `ganzes Bild ${dx},${dy}`).toBeGreaterThan(2);
    }
  });

  it("folgt einer langen Drift weit über die Boxgrösse hinaus", () => {
    const ref = frame(tex, W, H, 0, 0, 0.04, 1);
    const al = new SurfaceAligner(ref, { x: 150, y: 100, width: 100, height: 100 });
    for (let k = 1; k <= 40; k++) {
      const dx = 2.5 * k + Math.sin(k) * 3, dy = -1.2 * k + Math.cos(k * 1.3) * 3; // am Ende ≈ 100 px / −48 px (Box 100 px)
      const s = al.align(frame(tex, W, H, dx, dy, 0.04, 100 + k));
      expect(Math.hypot(s.dx - dx, s.dy - dy), `Bild ${k}`).toBeLessThan(0.5);
    }
  });

  it("Verarbeitung mit Ankerbox: Ausgabebilder deckungsgleich", async () => {
    const W2 = 320, H2 = 240;
    const jitter: [number, number][] = [[0, 0], [6, -4], [-9, 3], [12, 7], [-3, -11], [8, 2]];
    const w = new SerWriter({ luId: 0, colorId: SerColor.MONO, littleEndianFlag: 0, width: W2, height: H2, bitDepth: 8, observer: "", instrument: "", telescope: "", dateTime: 0n, dateTimeUtc: 0n });
    jitter.forEach(([dx, dy], k) => {
      const f = frame(tex, W2, H2, dx, dy, 0.03, 60 + k);
      w.add({ width: W2, height: H2, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: Uint8Array.from(f.data, (v) => Math.max(0, Math.min(255, Math.round(v * 255)))) }, BigInt(k + 1));
    });
    const r = await SerReader.open(w.toBlob());
    const o = { ...defaultOptions, centreMode: "surface" as const, surfaceAnchor: { x: 100, y: 70, width: 90, height: 90 }, cropWidth: 280, cropHeight: 200, qualityEnabled: false };
    const { report } = await processSer(r, o);
    expect(report.frames.every((f) => f.accepted)).toBe(true);
    for (const [k, [dx, dy]] of jitter.entries()) {
      const s = report.frames[k].det.surface!;
      expect(Math.abs(s.dx - dx) + Math.abs(s.dy - dy), `Bild ${k}`).toBeLessThan(0.8);
    }
  }, 60_000);
});
