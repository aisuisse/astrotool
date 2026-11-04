import { describe, expect, it } from "vitest";
import { decodeFits, fitsExif, isFits, parseFitsHeader, readFitsLayout } from "../src/engine/fits";
import { FitsCubeSource } from "../src/engine/source";
import { encodeFits } from "../src/engine/imagewrite";
import { exifTimeMs } from "../src/engine/exif";
import { SerColor, type Frame } from "../src/engine/ser";

/** FITS von Hand: Kopfkarten + Daten (big-endian) */
function fits(cards: Record<string, string | number | boolean>, data: (v: DataView) => void, dataBytes: number): Blob {
  const card = (k: string, v: string | number | boolean) =>
    `${k.padEnd(8)}= ${typeof v === "string" ? `'${v}'`.padEnd(20) : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20)}`.padEnd(80);
  const head = Object.entries({ SIMPLE: true, ...cards }).map(([k, v]) => card(k, v)).join("") + "END".padEnd(80);
  const hl = Math.ceil(head.length / 2880) * 2880, dl = Math.ceil(dataBytes / 2880) * 2880;
  const out = new Uint8Array(hl + dl);
  out.fill(32, 0, hl);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  data(new DataView(out.buffer, hl));
  return new Blob([out]);
}

const W = 4, H = 2;

describe("FITS lesen", () => {
  it("eigene 16-bit-Ausgabe zurücklesen: Bayer, Farbe, Zeit und Belichtung bleiben erhalten", async () => {
    const bayer: Frame = { width: W, height: H, planes: 1, bitDepth: 16, colorId: SerColor.BAYER_GBRG, data: Uint16Array.from({ length: 8 }, (_, i) => i * 8000 + 7) };
    const file = new Blob([encodeFits(bayer, { date: new Date("2026-08-12T17:45:10.250Z"), exposure: 0.002 }) as BlobPart]);
    expect(await isFits(file)).toBe(true);
    const f = await decodeFits(file);
    expect(f).toMatchObject({ width: W, height: H, planes: 1, bitDepth: 16, colorId: SerColor.BAYER_GBRG });
    expect(Array.from(f.data)).toEqual(Array.from(bayer.data));
    const head = parseFitsHeader(new Uint8Array(await file.arrayBuffer()))!.header;
    const e = fitsExif(head);
    expect(exifTimeMs(e)).toBe(Date.UTC(2026, 7, 12, 17, 45, 10, 250));
    expect(e.exposureTime).toBe(0.002);

    const rgb: Frame = { width: W, height: H, planes: 3, bitDepth: 8, colorId: SerColor.RGB, data: Uint8Array.from({ length: 24 }, (_, i) => i * 10) };
    const c = await decodeFits(new Blob([encodeFits(rgb) as BlobPart]));
    expect(c).toMatchObject({ planes: 3, bitDepth: 16, colorId: SerColor.RGB });
    expect(Array.from(c.data)).toEqual(Array.from(rgb.data, (v) => v * 257)); // 8 bit wurde auf 16 bit gestreckt
  });

  it("ohne ROWORDER: unterste Zeile zuerst (FITS-Norm) – wird gespiegelt, Bayer-Muster passt sich an", async () => {
    // 16 bit mit Vorzeichen (BZERO 0): Zeile 0 der Datei = 1, Zeile 1 = 2
    const f = await decodeFits(fits({ BITPIX: 16, NAXIS: 2, NAXIS1: W, NAXIS2: H, BAYERPAT: "RGGB" }, (v) => {
      for (let i = 0; i < 8; i++) v.setInt16(2 * i, i < W ? 1 : 2);
    }, 16));
    expect(Array.from(f.data)).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
    expect(f.colorId).toBe(SerColor.BAYER_GBRG); // gerade Höhe: Zeilen des Musters getauscht
  });

  it("Gleitkomma 0…1 (Siril/PixInsight) → 16 bit; fehlende Werte (NaN) → 0", async () => {
    const f = await decodeFits(fits({ BITPIX: -32, NAXIS: 2, NAXIS1: W, NAXIS2: H, ROWORDER: "TOP-DOWN" }, (v) => {
      [0, 0.5, 1, NaN, 0.25, 0.75, 0.1, 0].forEach((x, i) => v.setFloat32(4 * i, x));
    }, 32));
    expect(f.bitDepth).toBe(16);
    expect(Array.from(f.data)).toEqual([0, 32768, 65535, 0, 16384, 49151, 6554, 0]);
  });

  it("32 bit ganzzahlig, grosse Werte: in den 16-bit-Bereich eingepasst; 8 bit bleibt 8 bit", async () => {
    const big = await decodeFits(fits({ BITPIX: 32, NAXIS: 2, NAXIS1: 2, NAXIS2: 1, ROWORDER: "TOP-DOWN" }, (v) => {
      v.setInt32(0, 1000000); v.setInt32(4, 500000);
    }, 8));
    expect(big.data[0]).toBe(65535);
    expect(Math.abs(big.data[1] - 32768)).toBeLessThanOrEqual(1); // halber Wert (Rundung)
    const eight = await decodeFits(fits({ BITPIX: 8, NAXIS: 2, NAXIS1: 2, NAXIS2: 1, ROWORDER: "TOP-DOWN" }, (v) => {
      v.setUint8(0, 3); v.setUint8(1, 250);
    }, 2));
    expect(eight).toMatchObject({ bitDepth: 8 });
    expect(Array.from(eight.data)).toEqual([3, 250]);
  });

  it("Würfel als Einzelbild und kaputte Dateien: verständliche Meldung", async () => {
    await expect(decodeFits(fits({ BITPIX: 16, NAXIS: 3, NAXIS1: 2, NAXIS2: 2, NAXIS3: 10 }, () => {}, 80))).rejects.toThrow(/fitsCube\|10/);
    await expect(decodeFits(fits({ BITPIX: 16, NAXIS: 4, NAXIS1: 2, NAXIS2: 2, NAXIS3: 5, NAXIS4: 2 }, () => {}, 80))).rejects.toThrow(/fitsUnsupported/);
    await expect(decodeFits(new Blob([new Uint8Array(100)]))).rejects.toThrow(/fitsBad/);
    // Daten kürzer als angegeben
    const full = new Uint8Array(await fits({ BITPIX: 16, NAXIS: 2, NAXIS1: 100, NAXIS2: 100 }, () => {}, 20000).arrayBuffer());
    await expect(decodeFits(new Blob([full.slice(0, 2880 + 100)]))).rejects.toThrow(/fitsBad/);
  });

  it("DATE-OBS nur mit Datum plus TIME-OBS; Instrument und Brennweite", () => {
    const h = new Map<string, string | number | boolean>([["DATE-OBS", "2026-08-12"], ["TIME-OBS", "18:30:00"], ["INSTRUME", "ZWO ASI678MC"], ["FOCALLEN", 1200], ["EXPOSURE", 0.01]]);
    const e = fitsExif(h);
    expect(exifTimeMs(e)).toBe(Date.UTC(2026, 7, 12, 18, 30));
    expect(e).toMatchObject({ model: "ZWO ASI678MC", focalLength: 1200, exposureTime: 0.01 });
  });
});

/** Ein Teil (HDU) einer FITS-Datei: Kopf + Daten, auf 2880 Bytes aufgefüllt; ext = Erweiterung statt Hauptteil */
function hduBytes(cards: Record<string, string | number | boolean>, data: (v: DataView) => void, dataBytes: number, ext = false): Uint8Array {
  const card = (k: string, v: string | number | boolean) =>
    `${k.padEnd(8)}= ${typeof v === "string" ? `'${v}'`.padEnd(20) : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20)}`.padEnd(80);
  const first = ext ? { XTENSION: "IMAGE" } : { SIMPLE: true };
  const head = Object.entries({ ...first, ...cards }).map(([k, v]) => card(k, v)).join("") + "END".padEnd(80);
  const hl = Math.ceil(head.length / 2880) * 2880, dl = Math.ceil(dataBytes / 2880) * 2880;
  const out = new Uint8Array(hl + dl);
  out.fill(32, 0, hl);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  data(new DataView(out.buffer, hl));
  return out;
}

describe("FITS-Würfel (mehrere Bilder in einer Datei)", () => {
  it("3D-Würfel, Bayer 16 bit: Bilder einzeln, gespiegelt, Zeit gleichmässig bis DATE-END", async () => {
    const n = 5;
    const file = new Blob([hduBytes(
      { BITPIX: 16, NAXIS: 3, NAXIS1: W, NAXIS2: H, NAXIS3: n, BZERO: 32768, BAYERPAT: "RGGB", "DATE-OBS": "2026-08-12T18:00:00.000", "DATE-END": "2026-08-12T18:00:01.000", INSTRUME: "ZWO ASI678MC" },
      // Bild k, Dateizeile r, Spalte x: Wert 1000·k + 10·r + x (vorzeichenlos über BZERO)
      (v) => { for (let k = 0; k < n; k++) for (let r = 0; r < H; r++) for (let x = 0; x < W; x++) v.setInt16(2 * ((k * H + r) * W + x), 1000 * k + 10 * r + x - 32768); },
      2 * W * H * n,
    ) as BlobPart]);
    const src = (await FitsCubeSource.open(file, "jupiter.fits"))!;
    expect(src).toMatchObject({ kind: "ser", frameCount: 5, width: W, height: H, bitDepth: 16, linear: true });
    // 2 Zeilen (gerade Höhe), gespiegelt: RGGB → GBRG
    expect(src.colorId).toBe(SerColor.BAYER_GBRG);
    expect(src.meta.instrument).toBe("ZWO ASI678MC");
    expect(src.frameName(3)).toBe("jupiter_4");
    const f3 = await src.readFrame(3);
    expect(Array.from(f3.data)).toEqual([3010, 3011, 3012, 3013, 3000, 3001, 3002, 3003]);
    const ts = (await src.readTimestamps())!;
    const ms = Array.from(ts, (t) => Number((t - ts[0]) / 10_000n));
    expect(ms).toEqual([0, 200, 400, 600, 800]);
    await expect(decodeFits(file)).rejects.toThrow(/fitsCube/);
  });

  it("4D-Würfel aus Farbbildern (NAXIS3 = 3 Farben, NAXIS4 = Bilder), Gleitkomma: gleicher Faktor für alle Bilder", async () => {
    const n = 4, plane = W * H;
    const file = new Blob([hduBytes(
      { BITPIX: -32, NAXIS: 4, NAXIS1: W, NAXIS2: H, NAXIS3: 3, NAXIS4: n, ROWORDER: "TOP-DOWN" },
      // Bild k, Farbe c: überall (k + 1) / 4 · (c + 1) / 3 → im ersten Bild höchstens 0.25
      (v) => { for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) v.setFloat32(4 * ((k * 3 + c) * plane + i), ((k + 1) / 4) * ((c + 1) / 3)); },
      4 * plane * 3 * n,
    ) as BlobPart]);
    const src = (await FitsCubeSource.open(file, "sun.fits"))!;
    expect(src).toMatchObject({ frameCount: 4, colorId: SerColor.RGB });
    expect(await src.readTimestamps()).toBeNull(); // ohne DATE-OBS keine Zeiten
    for (let k = 0; k < n; k++) {
      const f = await src.readFrame(k);
      expect(f.planes).toBe(3);
      // Pixel 5, Farben R, G, B: ohne Flackern derselbe Faktor 65535 (normierte Gleitkommawerte)
      expect(Array.from(f.data.subarray(15, 18))).toEqual([1, 2, 3].map((c) => Math.round(((k + 1) / 4) * (c / 3) * 65535)));
    }
  });

  it("ein Bild je Erweiterung (FITS-Sequenz), Tabelle dazwischen übersprungen, Zeit je Bild aus DATE-OBS", async () => {
    const img = (k: number, sec: number) => hduBytes(
      { BITPIX: 8, NAXIS: 2, NAXIS1: W, NAXIS2: H, PCOUNT: 0, GCOUNT: 1, ROWORDER: "TOP-DOWN", "DATE-OBS": `2026-08-12T18:00:${String(sec).padStart(2, "0")}.500` },
      (v) => { for (let i = 0; i < W * H; i++) v.setUint8(i, 10 * k + i); },
      W * H, true,
    );
    const table = hduBytes({ BITPIX: 8, NAXIS: 2, NAXIS1: 16, NAXIS2: 300, PCOUNT: 0, GCOUNT: 1, TFIELDS: 1 }, () => {}, 4800, true);
    table.set(Array.from("XTENSION= 'BINTABLE'", (ch) => ch.charCodeAt(0)), 0);
    const primary = hduBytes({ BITPIX: 8, NAXIS: 0, EXTEND: true }, () => {}, 0);
    const file = new Blob([primary, img(0, 1), table, img(1, 3), img(2, 4)] as BlobPart[]);
    const layout = await readFitsLayout(file);
    expect(layout.map((u) => u.frames)).toEqual([1, 1, 1]);
    const src = (await FitsCubeSource.open(file, "seq.fit"))!;
    expect(src).toMatchObject({ frameCount: 3, bitDepth: 8, colorId: SerColor.MONO });
    expect(Array.from((await src.readFrame(2)).data)).toEqual([20, 21, 22, 23, 24, 25, 26, 27]);
    const ts = (await src.readTimestamps())!;
    expect(Array.from(ts, (t) => Number((t - ts[0]) / 10_000n))).toEqual([0, 2000, 3000]);
  });

  it("NAXIS3 = 3: ohne BAYERPAT ein Farbbild, mit BAYERPAT drei Rohbilder; Einzelbild ist kein Würfel", async () => {
    const cube3 = (extra: Record<string, string>) => new Blob([hduBytes({ BITPIX: 8, NAXIS: 3, NAXIS1: W, NAXIS2: H, NAXIS3: 3, ...extra }, () => {}, W * H * 3) as BlobPart]);
    expect(await FitsCubeSource.open(cube3({}), "rgb.fits")).toBeNull();
    expect((await decodeFits(cube3({}))).planes).toBe(3);
    expect((await FitsCubeSource.open(cube3({ BAYERPAT: "RGGB" }), "raw.fits"))!.frameCount).toBe(3);
    expect(await FitsCubeSource.open(fits({ BITPIX: 16, NAXIS: 2, NAXIS1: W, NAXIS2: H }, () => {}, 2 * W * H), "one.fits")).toBeNull();
  });
});
