import { describe, expect, it } from "vitest";
import { decodeFits, FITS_EXT, fitsBaseName, readFitsLayout } from "../src/engine/fits";
import { ditherTable, riceDecode, riceEncode } from "../src/engine/fitscomp";
import { backgroundLevel, fitSunDisc } from "../src/engine/limb";
import { SerColor } from "../src/engine/ser";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

type Card = string | number | boolean;
const card = (k: string, v: Card) =>
  `${k.padEnd(8)}= ${typeof v === "string" ? `'${v}'`.padEnd(20) : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20)}`.padEnd(80);
function block(text: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(text.length / 2880) * 2880).fill(32);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Komprimierte FITS-Datei von Hand: leerer Hauptteil, dann Binärtabelle mit einer Kachel je Zeile
 * (Spalte COMPRESSED_DATA als 1PB, optional ZSCALE/ZZERO als 1D) und Heap.
 */
function tiled(cards: Record<string, Card>, tiles: Uint8Array[], extraCols?: { ZSCALE: number[]; ZZERO: number[] }): Blob {
  const primary = block(card("SIMPLE", true) + card("BITPIX", 8) + card("NAXIS", 0) + card("EXTEND", true) + "END".padEnd(80));
  const rowBytes = 8 + (extraCols ? 16 : 0);
  const heap = tiles.reduce((s, t) => s + t.length, 0);
  const cols: Record<string, Card> = { TTYPE1: "COMPRESSED_DATA", TFORM1: `1PB(${Math.max(...tiles.map((t) => t.length))})` };
  if (extraCols) Object.assign(cols, { TTYPE2: "ZSCALE", TFORM2: "1D", TTYPE3: "ZZERO", TFORM3: "1D" });
  const head = { XTENSION: "BINTABLE", BITPIX: 8, NAXIS: 2, NAXIS1: rowBytes, NAXIS2: tiles.length, PCOUNT: heap, GCOUNT: 1, TFIELDS: extraCols ? 3 : 1, ...cols, ZIMAGE: true, ...cards };
  const hb = block(Object.entries(head).map(([k, v]) => card(k, v)).join("") + "END".padEnd(80));
  const data = new Uint8Array(Math.ceil((rowBytes * tiles.length + heap) / 2880) * 2880);
  const dv = new DataView(data.buffer);
  let at = 0;
  tiles.forEach((t, r) => {
    dv.setInt32(r * rowBytes, t.length);
    dv.setInt32(r * rowBytes + 4, at);
    if (extraCols) {
      dv.setFloat64(r * rowBytes + 8, extraCols.ZSCALE[r]);
      dv.setFloat64(r * rowBytes + 16, extraCols.ZZERO[r]);
    }
    data.set(t, rowBytes * tiles.length + at);
    at += t.length;
  });
  return new Blob([primary as BlobPart, hb as BlobPart, data as BlobPart]);
}

async function gzip(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

describe("Komprimiertes FITS (.fits.fz)", () => {
  it("Dateiendungen", () => {
    expect(FITS_EXT.test("x.fits.fz") && FITS_EXT.test("y.fz") && FITS_EXT.test("z.FIT")).toBe(true);
    expect(fitsBaseName("20260812185022Th.fits.fz")).toBe("20260812185022Th");
  });

  it("Zufallsfolge für das Zittern wie im Standard (10 000. Startwert 1043618065)", () => {
    const r = ditherTable();
    expect(Math.round(r[9999] * 2147483647)).toBe(1043618065);
    expect(r[0]).toBeCloseTo(16807 / 2147483647, 15);
  });

  for (const bytepix of [1, 2, 4] as const) {
    it(`Rice ${8 * bytepix} bit: Rauschen, flache Blöcke, grosse Sprünge, Blockgrenzen`, () => {
      const rand = rng(bytepix);
      const n = 1000;
      const lo = bytepix === 1 ? 0 : bytepix === 2 ? -32768 : -2147483648, hi = bytepix === 1 ? 255 : bytepix === 2 ? 32767 : 2147483647;
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (i < 100) v[i] = 50; // flach → Blöcke ohne Differenzen
        else if (i < 300) v[i] = Math.round(100 + 20 * Math.sin(i / 7) + rand() * 6); // Rauschen
        else if (i < 340) v[i] = rand() < 0.5 ? lo : hi; // grosse Sprünge → rohe Blöcke
        else v[i] = Math.round(lo + rand() * (hi - lo)); // ganzer Bereich
      }
      for (const bs of [16, 32]) {
        const enc = riceEncode(v, bytepix, bs);
        expect(Array.from(riceDecode(enc, n, bytepix, bs))).toEqual(Array.from(v));
      }
    });
  }

  it("16-bit-Bild mit Rice, Zeilenkacheln (wie GONG): Werte, Zeilenfolge, BZERO", async () => {
    const w = 37, h = 9; // 37 nicht durch 32 teilbar: letzter Block kürzer
    const img = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => -32768 + 1000 * y + x * 3 + ((x * y) % 5)));
    const tiles = img.map((row) => riceEncode(row, 2, 32));
    const file = tiled({ ZCMPTYPE: "RICE_1", ZBITPIX: 16, ZNAXIS: 2, ZNAXIS1: w, ZNAXIS2: h, ZTILE1: w, ZTILE2: 1, ZNAME1: "BLOCKSIZE", ZVAL1: 32, ZNAME2: "BYTEPIX", ZVAL2: 2, BZERO: 32768, "DATE-OBS": "2026-08-12T18:50:22" }, tiles);
    const layout = await readFitsLayout(file);
    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({ width: w, height: h, bitpix: 16, frames: 1 });
    expect(layout[0].header.get("DATE-OBS")).toBe("2026-08-12T18:50:22");
    const f = await decodeFits(file);
    expect(f).toMatchObject({ width: w, height: h, bitDepth: 16, colorId: SerColor.MONO });
    // FITS: unterste Zeile zuerst → oben im Frame steht die letzte Zeile der Datei
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(f.data[y * w + x]).toBe(img[h - 1 - y][x] + 32768);
  });

  it("2-D-Kacheln, GZIP_1 und GZIP_2 (umsortierte Bytes)", async () => {
    const w = 10, h = 7, tw = 4, th = 3;
    const val = (x: number, y: number) => y * 100 + x;
    for (const type of ["GZIP_1", "GZIP_2"]) {
      const tiles: Uint8Array[] = [];
      for (let ty = 0; ty < h; ty += th)
        for (let tx = 0; tx < w; tx += tw) {
          const cw = Math.min(tw, w - tx), ch = Math.min(th, h - ty);
          const raw = new Uint8Array(cw * ch * 2);
          const dv = new DataView(raw.buffer);
          let k = 0;
          for (let y = ty; y < ty + ch; y++) for (let x = tx; x < tx + cw; x++) dv.setInt16(2 * k++, val(x, y));
          let b = raw;
          if (type === "GZIP_2") {
            b = new Uint8Array(raw.length);
            const n = raw.length / 2;
            for (let i = 0; i < n; i++) { b[i] = raw[2 * i]; b[n + i] = raw[2 * i + 1]; }
          }
          tiles.push(await gzip(b));
        }
      const file = tiled({ ZCMPTYPE: type, ZBITPIX: 16, ZNAXIS: 2, ZNAXIS1: w, ZNAXIS2: h, ZTILE1: tw, ZTILE2: th, ROWORDER: "TOP-DOWN" }, tiles);
      const f = await decodeFits(file);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(f.data[y * w + x]).toBe(val(x, y));
    }
  });

  it("quantisiertes Gleitkommabild mit subtraktivem Zittern: auf eine halbe Stufe genau", async () => {
    const w = 50, h = 4, scale = 0.001, zero = 0.25, dither0 = 7;
    const ran = ditherTable();
    const truth: number[][] = [];
    const tiles: Uint8Array[] = [];
    for (let y = 0; y < h; y++) {
      // Zeile y = Kachel y: Startpunkt der Folge wie beim Lesen
      let iseed = (y + dither0 - 1) % 10000, next = Math.floor(ran[iseed] * 500);
      const row: number[] = [], ints: number[] = [];
      for (let x = 0; x < w; x++) {
        const v = 0.5 + 0.4 * Math.sin(x / 5 + y);
        row.push(v);
        ints.push(Math.round((v - zero) / scale + ran[next] - 0.5));
        if (++next === 10000) { iseed = (iseed + 1) % 10000; next = Math.floor(ran[iseed] * 500); }
      }
      truth.push(row);
      tiles.push(riceEncode(ints, 4, 32));
    }
    const file = tiled({ ZCMPTYPE: "RICE_1", ZBITPIX: -32, ZNAXIS: 2, ZNAXIS1: w, ZNAXIS2: h, ZTILE1: w, ZTILE2: 1, ZQUANTIZ: "SUBTRACTIVE_DITHER_1", ZDITHER0: dither0, ROWORDER: "TOP-DOWN" },
      tiles, { ZSCALE: Array(h).fill(scale), ZZERO: Array(h).fill(zero) });
    const f = await decodeFits(file);
    // Werte 0…1 → × 65535
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(Math.abs(f.data[y * w + x] / 65535 - truth[y][x])).toBeLessThan(scale / 2 + 1 / 65535);
  });

  it("nicht unterstützte Verfahren werden verständlich gemeldet", async () => {
    const file = tiled({ ZCMPTYPE: "HCOMPRESS_1", ZBITPIX: 16, ZNAXIS: 2, ZNAXIS1: 4, ZNAXIS2: 4 }, [new Uint8Array(4)]);
    await expect(readFitsLayout(file)).rejects.toThrow(/HCOMPRESS_1/);
  });
});

describe("Sonnenrand: Scheibe füllt das halbe Bild", () => {
  it("Hintergrund ist dann nicht der Median, Rand wird gefunden (wie GONG)", () => {
    const w = 400, h = 400, cx = 203.2, cy = 198.7, R = 175;
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - cx, y - cy);
        // Scheibe hell, Ring der Blende grau, Ecken schwarz
        d[y * w + x] = r < R ? 0.7 : r < 196 ? 0.08 : 0;
      }
    const l = { width: w, height: h, data: d };
    expect(backgroundLevel(l)).toBeLessThan(0.1);
    const f = fitSunDisc(l);
    expect(Math.hypot(f.cx - cx, f.cy - cy)).toBeLessThan(0.5);
    expect(Math.abs(f.r - R)).toBeLessThan(0.7);
  });
});
