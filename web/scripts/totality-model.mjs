// Künstliche Finsternis-Aufnahmen für Tests (keine echten Daten nötig).
// Totalität: dunkler Mond, Korona mit Strahlen, Protuberanzen; Belichtungsreihen wie aus einer Kamera (sRGB, 8 bit).
// Partielle Phase: Sonnenscheibe mit Filter, teilweise vom Mond verdeckt.

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * Leuchtdichte der Totalität (linear, Farbe RGB). Einheit: innere Korona ≈ 1.
 * s = Sonnenmitte, m = Mondmitte, R = Sonnenradius (Pixel). Mondradius 1.03 R.
 * sky = Himmelslicht in der Bildmitte, skyGrad = [gx, gy]: Zunahme bis zum rechten/unteren Rand (relativ),
 * skyCurve: Sattel-Anteil u·v (relativ), skyTint: Farbe des Himmels je Kanal.
 */
export function totalityRadiance(w, h, { sx, sy, mx, my, R, sky: sky0 = 2e-4, skyGrad = [0, 0], skyCurve = 0, skyTint = [1, 1, 1] }) {
  const Rm = 1.03 * R;
  const out = new Float32Array(w * h * 3);
  const proms = [
    [0.6, 1.0], [2.4, 0.7], [4.3, 1.4],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const dm = Math.hypot(x - mx, y - my);
      const dmEdge = 1 / (1 + Math.exp((Rm - dm) / 0.6)); // 0 im Mond, 1 ausserhalb
      const r = Math.max(1, Math.hypot(x - sx, y - sy) / R);
      const th = Math.atan2(y - sy, x - sx);
      const streamer = 1 + 1.5 * Math.cos(2 * th - 0.4) ** 8;
      const k = (0.7 * r ** -8 + 0.3 * r ** -3) * streamer;
      let pr = 0;
      for (const [a, amp] of proms) {
        const px = sx + Math.cos(a) * R * 1.02, py = sy + Math.sin(a) * R * 1.02;
        pr += amp * 3 * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * (0.02 * R) ** 2));
      }
      const u = (x - w / 2) / (w / 2), v = (y - h / 2) / (h / 2);
      const sky = sky0 * (1 + skyGrad[0] * u + skyGrad[1] * v + skyCurve * u * v), earthshine = 3e-5;
      out[i] = earthshine + dmEdge * (k + pr) + sky * skyTint[0];
      out[i + 1] = earthshine + dmEdge * (0.97 * k + 0.35 * pr) + sky * skyTint[1];
      out[i + 2] = earthshine + dmEdge * (0.94 * k + 0.45 * pr) + sky * skyTint[2];
    }
  return out;
}

/** Kamerabild (RGBA 8 bit, sRGB) einer Leuchtdichte bei relativer Belichtung e. */
export function expose(rad, w, h, e, seed = 1) {
  const rand = rng(seed);
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) {
      const lin = Math.min(1, Math.max(0, rad[p * 3 + c] * e + (rand() - 0.5) * 0.002));
      rgba[p * 4 + c] = Math.round(srgb(lin) * 255);
    }
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

/** Partielle Phase mit Sonnenfilter (RGBA 8 bit). Mit kleinerem Mond (Rm < R) auch ringförmig. */
export function partialImage(w, h, { sx, sy, mx, my, R, Rm = 1.03 * R }, seed = 1) {
  const rand = rng(seed);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ds = Math.hypot(x - sx, y - sy), dm = Math.hypot(x - mx, y - my);
      const sun = 1 / (1 + Math.exp((ds - R) / 0.7));
      const moon = 1 / (1 + Math.exp((Rm - dm) / 0.7));
      const v = Math.min(1, 0.02 + 0.85 * sun * moon * (1 - 0.3 * (ds / R) ** 2) + (rand() - 0.5) * 0.02);
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(255 * v);
      rgba[i + 1] = Math.round(220 * v);
      rgba[i + 2] = Math.round(120 * v);
      rgba[i + 3] = 255;
    }
  return rgba;
}

/**
 * Minimaler EXIF-Block (APP1-Segment ohne SOI): DateTimeOriginal, SubSecTimeOriginal, ExposureTime, FNumber, ISO, Modell.
 * date: "YYYY:MM:DD hh:mm:ss", subSec: "123", exposure in Sekunden.
 */
export function exifApp1({ date, subSec = "000", exposure, fNumber = 8, iso = 100, model = "Testkamera" }) {
  const tiff = new Uint8Array(256);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, 8, true);
  // IFD0 bei 8: Model, ExifIFD
  const model0 = model + "\0";
  v.setUint16(8, 2, true);
  v.setUint16(10, 0x0110, true); v.setUint16(12, 2, true); v.setUint32(14, model0.length, true); v.setUint32(18, 200, true);
  v.setUint16(22, 0x8769, true); v.setUint16(24, 4, true); v.setUint32(26, 1, true); v.setUint32(30, 40, true);
  v.setUint32(34, 0, true);
  // ExifIFD bei 40: 5 Einträge
  const dt = date + "\0", ss = subSec + "\0";
  const den = exposure >= 1 ? 10 : Math.round(1 / exposure) >= 1 && Math.abs(1 / exposure - Math.round(1 / exposure)) < 1e-6 ? Math.round(1 / exposure) : 1000000;
  const num = Math.round(exposure * den);
  v.setUint16(40, 5, true);
  let e = 42;
  const entry = (tag, type, count, val) => { v.setUint16(e, tag, true); v.setUint16(e + 2, type, true); v.setUint32(e + 4, count, true); v.setUint32(e + 8, val, true); e += 12; };
  entry(0x829a, 5, 1, 120); // ExposureTime → Rational bei 120
  entry(0x829d, 5, 1, 128); // FNumber → 128
  entry(0x8827, 3, 1, iso); // ISO (SHORT im Wertfeld)
  entry(0x9003, 2, dt.length, 140);
  entry(0x9291, 2, ss.length, 170);
  v.setUint32(e, 0, true);
  v.setUint32(120, num, true); v.setUint32(124, den, true);
  v.setUint32(128, Math.round(fNumber * 10), true); v.setUint32(132, 10, true);
  [...dt].forEach((c, i) => (tiff[140 + i] = c.charCodeAt(0)));
  [...ss].forEach((c, i) => (tiff[170 + i] = c.charCodeAt(0)));
  [...model0].forEach((c, i) => (tiff[200 + i] = c.charCodeAt(0)));
  const app1 = new Uint8Array(10 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xffe1); a.setUint16(2, 8 + tiff.length);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(tiff, 10);
  return app1;
}

/** Fügt den EXIF-Block direkt nach SOI in ein JPEG ein. Ohne JPEG: nur SOI + EXIF + EOI (für Tests). */
export function withExif(jpeg, exif) {
  if (!jpeg) {
    const out = new Uint8Array(4 + exif.length);
    out.set([0xff, 0xd8]); out.set(exif, 2); out.set([0xff, 0xd9], 2 + exif.length);
    return out;
  }
  const out = new Uint8Array(jpeg.length + exif.length);
  out.set(jpeg.subarray(0, 2)); out.set(exif, 2); out.set(jpeg.subarray(2), 2 + exif.length);
  return out;
}
