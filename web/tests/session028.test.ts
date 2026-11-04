import { describe, expect, it } from "vitest";
import { Calibrator, darkRatio, decodeMaster, encodeMaster, MasterBuilder, type Master } from "../src/engine/calibrate";
import { SurfaceTracker } from "../src/engine/surface";
import { rotatedCrop } from "../src/engine/transform";
import type { Lum } from "../src/engine/image";
import { SerColor, type Frame } from "../src/engine/ser";
import { moonSurface } from "./surface.test";

// ---------- Kalibrierung ----------
const mono = (w: number, h: number, f: (i: number) => number, bitDepth = 16): Frame =>
  ({ width: w, height: h, planes: 1, bitDepth, colorId: SerColor.MONO, data: Uint16Array.from({ length: w * h }, (_, i) => f(i)) });

describe("Master: Belichtungszeit, Dark-Skalierung", () => {
  it("Belichtungszeit nur, wenn alle Bilder gleich lang belichtet sind", () => {
    const b = new MasterBuilder();
    b.add(mono(4, 4, () => 100), 2);
    b.add(mono(4, 4, () => 100), 2.01);
    expect(b.finish().exposure).toBe(2);
    const c = new MasterBuilder();
    c.add(mono(4, 4, () => 100), 2);
    c.add(mono(4, 4, () => 100), 4);
    expect(c.finish().exposure).toBeUndefined();
    expect(darkRatio({ exposure: 2 }, 4)).toBe(2);
    expect(darkRatio({ exposure: 2 }, 2.005)).toBe(1);
    expect(darkRatio({ exposure: undefined }, 4)).toBe(1);
  });

  // Sensor: Sockel 1000, Wärmesignal 50 e/s (heisses Pixel 0: 2000 e/s); Bild 4 s, Dark 2 s
  const w = 8, h = 8, sockel = 1000, rate = (i: number) => (i === 0 ? 2000 : 50);
  const sensor = (t: number, light = 0) => mono(w, h, (i) => sockel + rate(i) * t + light);
  const dark2s = (): Master => ({ ...new MasterBuilder().finish.call((() => { const b = new MasterBuilder(); b.add(sensor(2), 2); return b; })()) });

  it("Wärmeanteil wird mit der Zeit skaliert, Sockel bleibt (Median des Darks als Sockel)", () => {
    const dark = dark2s();
    const off = new Calibrator({ dark, scaleDark: false }, { width: w, height: h, planes: 1, bitDepth: 16 }).apply(sensor(4, 500), 4);
    const on = new Calibrator({ dark, scaleDark: true }, { width: w, height: h, planes: 1, bitDepth: 16 }).apply(sensor(4, 500), 4);
    // ohne Skalierung bleibt das heisse Pixel stehen (2000 e/s × 2 s zu wenig abgezogen)
    expect(off.data[0]).toBe(500 + 4000);
    expect(off.data[5]).toBe(500 + 100);
    // mit Skalierung: Median (1100) gilt als Sockel – das heisse Pixel ist weg; die gleichmässige Wärme ist im
    // Sockel enthalten und bleibt als kleiner Rest (100)
    expect(on.data[0]).toBe(500 + 100);
    expect(on.data[5]).toBe(500 + 100);
  });

  it("mit Bias als Sockel: auch die gleichmässige Wärme wird genau abgezogen", () => {
    const dark = dark2s();
    const bias = (() => { const b = new MasterBuilder(); b.add(sensor(0), 0.001); return b.finish(); })();
    const c = new Calibrator({ dark, flatDark: bias, scaleDark: true }, { width: w, height: h, planes: 1, bitDepth: 16 });
    const out = c.apply(sensor(4, 500), 4);
    expect(Array.from(out.data)).toEqual(new Array(w * h).fill(500));
    // gleiche Zeit wie das Dark: genau wie ohne Skalierung
    expect(Array.from(c.apply(sensor(2, 500), 2).data)).toEqual(new Array(w * h).fill(500));
    // Zeit unbekannt (z. B. SER): Dark unverändert
    expect(c.apply(sensor(2, 500)).data[3]).toBe(500);
  });
});

describe("Master als FITS speichern und laden", () => {
  it("genau zurück: Bayer mit Bittiefe, Farbe in Ebenen, Belichtungszeit, Anzahl", () => {
    const bayer: Master = { width: 5, height: 3, planes: 1, colorId: SerColor.BAYER_GBRG, bitDepth: 12, frames: 17, exposure: 0.25, data: Float32Array.from({ length: 15 }, (_, i) => i * 10.5 + 0.25) };
    const back = decodeMaster(encodeMaster(bayer, "dark"))!;
    expect(back).toEqual(bayer);
    const rgb: Master = { width: 3, height: 2, planes: 3, colorId: SerColor.RGB, bitDepth: 8, frames: 3, exposure: undefined, data: Float32Array.from({ length: 18 }, (_, i) => i * 7) };
    const back2 = decodeMaster(encodeMaster(rgb, "flat"))!;
    expect(Array.from(back2.data)).toEqual(Array.from(rgb.data));
    expect([back2.planes, back2.colorId, back2.frames]).toEqual([3, SerColor.RGB, 3]);
    const text = new TextDecoder().decode(encodeMaster(bayer, "flatDark").slice(0, 2880));
    expect(text).toMatch(/IMAGETYP= 'Master Bias'/);
    expect(text).toMatch(/BAYERPAT= 'GBRG +'/);
  });

  it("Master anderer Programme: Gleitkomma 0…1 → 16 bit, unterste Zeile zuerst; Einzelbild → null", () => {
    const cards = (extra: string[]) => {
      const c = ["SIMPLE  =                    T", "BITPIX  =                  -32", "NAXIS   =                    2", "NAXIS1  =                    2", "NAXIS2  =                    2", ...extra, "END"];
      const head = new TextEncoder().encode(c.map((s) => s.padEnd(80)).join(""));
      const out = new Uint8Array(2880 * 2).fill(32, 0, 2880);
      out.set(head);
      const v = new DataView(out.buffer, 2880);
      [0.1, 0.2, 0.3, 0.4].forEach((x, i) => v.setFloat32(4 * i, x));
      return out;
    };
    const m = decodeMaster(cards(["IMAGETYP= 'Master Dark'", "EXPTIME =                  30."]))!;
    expect(m.bitDepth).toBe(16);
    expect(m.exposure).toBe(30);
    // FITS-Norm: erste Zeile im File ist die unterste
    expect(Array.from(m.data, (x) => Math.round(x))).toEqual([0.3, 0.4, 0.1, 0.2].map((x) => Math.round(Math.fround(x) * 65535)));
    expect(decodeMaster(cards([]))).toBeNull();
  });
});

// ---------- Oberfläche: Drehung und Referenz nachführen ----------
const tex = moonSurface(11, 1400, 260);
/** Bild size × size: Inhalt um die Mitte um angle gedreht und verschoben (Punkt p der Vorlage → R·(p − c) + c + t) */
function view(size: number, angle: number, tx: number, ty: number, blur = 0): Lum {
  const data = new Float32Array(size * size);
  const c = Math.cos(angle), s = Math.sin(angle), m = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // zurückrechnen: p = R⁻¹(q − c − t) + c
      const qx = x + 0.5 - m - tx, qy = y + 0.5 - m - ty;
      const px = c * qx + s * qy + m, py = -s * qx + c * qy + m;
      let v = tex(px + 400, py + 400);
      if (blur) v = v * (1 - blur) + 0.45 * blur; // Struktur wird schwächer (Dunst, Seeing)
      data[y * size + x] = v;
    }
  return { width: size, height: size, data };
}
const deg = Math.PI / 180;

describe("Oberfläche: Bilddrehung", () => {
  it("misst Drehung und Verschiebung gegenüber dem ersten Bild", () => {
    const t = new SurfaceTracker(view(384, 0, 0, 0), null, { followRef: false, rotation: true });
    for (const [a, tx, ty] of [[0.5, 3.2, -1.7], [-1.2, -6, 4.5], [2, 1, 1]]) {
      const r = t.align(view(384, a * deg, tx, ty));
      expect(Math.abs(r.angle! / deg - a)).toBeLessThan(0.08);
      expect(Math.abs(r.dx - tx)).toBeLessThan(0.6);
      expect(Math.abs(r.dy - ty)).toBeLessThan(0.6);
    }
    // ohne Drehung: kein Winkel
    expect(new SurfaceTracker(view(384, 0, 0, 0), null, { followRef: false, rotation: false }).align(view(384, deg, 0, 0)).angle).toBeUndefined();
  });

  it("Ausschnitt mit Drehung: zurückgedrehtes Bild gleicht dem ersten", () => {
    const size = 256, a = 3 * deg;
    const ref = view(size, 0, 0, 0), cur = view(size, a, 0, 0);
    const toFrame = (l: Lum): Frame => ({ width: l.width, height: l.height, planes: 1, bitDepth: 16, colorId: SerColor.MONO, data: Uint16Array.from(l.data, (v) => Math.round(v * 60000)) });
    const out = rotatedCrop(toFrame(cur), size / 2, size / 2, a, 160, 160);
    const want = rotatedCrop(toFrame(ref), size / 2, size / 2, 0, 160, 160);
    let err = 0, n = 0;
    for (let i = 0; i < out.data.length; i++) { err += Math.abs(out.data[i] - want.data[i]); n++; }
    expect(err / n / 60000).toBeLessThan(0.01); // im Mittel < 1 % der Helligkeit
    // ohne Ausgleich deutlich verschieden
    const raw = rotatedCrop(toFrame(cur), size / 2, size / 2, 0, 160, 160);
    let err2 = 0;
    for (let i = 0; i < raw.data.length; i++) err2 += Math.abs(raw.data[i] - want.data[i]);
    expect(err2 / n / 60000).toBeGreaterThan(3 * (err / n / 60000));
  });
});

describe("Oberfläche: Referenz nachführen", () => {
  it("lange Drehung (0 → 12°) mit Ausgleich: Winkel bleibt genau", () => {
    const t = new SurfaceTracker(view(320, 0, 0, 0), null, { followRef: true, rotation: true });
    let worst = 0;
    for (let k = 1; k <= 12; k++) {
      const r = t.align(view(320, k * deg, 0.4 * k, -0.3 * k));
      worst = Math.max(worst, Math.abs(r.angle! / deg - k), Math.abs(r.dx - 0.4 * k), Math.abs(r.dy + 0.3 * k));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it("Struktur wandelt sich langsam (Granulation): mit Nachführen bleibt die Lage genau", () => {
    const tex2 = moonSurface(23, 1400, 260);
    const size = 288, steps = 30;
    // Mischung zweier Landschaften, Anteil der zweiten wächst von 0 auf 100 %
    const mixed = (k: number, tx: number, ty: number): Lum => {
      const a = view(size, 0, tx, ty), w2 = k / steps;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) a.data[y * size + x] = a.data[y * size + x] * (1 - w2) + tex2(x + 0.5 - tx + 500, y + 0.5 - ty + 500) * w2;
      return a;
    };
    const run = (followRef: boolean) => {
      const t = new SurfaceTracker(mixed(0, 0, 0), null, { followRef, rotation: false });
      let last = { err: 0, peak: 0 };
      for (let k = 1; k <= steps; k++) {
        const tx = 0.7 * k, ty = -0.4 * k;
        const r = t.align(mixed(k, tx, ty));
        last = { err: Math.hypot(r.dx - tx, r.dy - ty), peak: r.peak };
      }
      return { ...last, changes: t.refChanges };
    };
    const follow = run(true), fixed = run(false);
    expect(follow.changes).toBeGreaterThan(0);
    expect(follow.err).toBeLessThan(1);
    expect(follow.peak).toBeGreaterThan(0.3);
    // ohne Nachführen: am Ende kaum noch Übereinstimmung (würde verworfen)
    expect(fixed.peak).toBeLessThan(0.2);
  });

  it("ein einzelnes schlechtes Bild (Dunst) wird nicht zur Referenz", () => {
    const t = new SurfaceTracker(view(320, 0, 0, 0), null, { followRef: true, rotation: false });
    for (let k = 0; k < 6; k++) t.align(view(320, 0, k * 0.3, 0));
    t.align(view(320, 0, 2, 0, 0.97)); // fast ohne Struktur
    expect(t.refChanges).toBe(0);
    const r = t.align(view(320, 0, 2.5, 1));
    expect(Math.abs(r.dx - 2.5)).toBeLessThan(0.5);
  });
});
