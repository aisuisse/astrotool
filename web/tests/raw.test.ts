import { describe, expect, it } from "vitest";
import { existsSync, openAsBlob, readdirSync } from "node:fs";
import { decodeLjpeg } from "../src/engine/ljpeg";
import { readExifBlob } from "../src/engine/exif";
import { rawPreview } from "../src/engine/raw";
import { decodeRawData } from "../src/engine/rawdata";
import { SerColor } from "../src/engine/ser";

/** Minimaler verlustfreier JPEG-Kodierer (nur für Tests): eine Huffman-Tabelle, wählbarer Prädiktor. */
function encodeLjpeg(data: Uint16Array, width: number, height: number, nc: number, precision: number, predictor: number): Uint8Array {
  // Codelängen: Kategorie k bekommt Länge k+1 (0..16) – einfach, gültig, nicht optimal
  const counts = new Uint8Array(16), symbols: number[] = [];
  for (let k = 0; k <= 16; k++) { if (k + 1 <= 16) counts[k]++; symbols.push(k); }
  // Länge 16 ist doppelt belegt (k = 15 und k = 16) → k = 16 auf Länge 16 neben 15
  counts[15] = 2; counts[16 - 1] = 2;
  const codes: { code: number; len: number }[] = [];
  let code = 0, s = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) codes[symbols[s++]] = { code: code++, len };
    code <<= 1;
  }
  const out: number[] = [0xff, 0xd8];
  const seg = (m: number, body: number[]) => out.push(0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const sof = [precision, height >> 8, height & 255, width >> 8, width & 255, nc];
  for (let c = 0; c < nc; c++) sof.push(c + 1, 0x11, 0);
  seg(0xc3, sof);
  seg(0xc4, [0x00, ...counts, ...symbols]);
  const sos = [nc];
  for (let c = 0; c < nc; c++) sos.push(c + 1, 0x00);
  sos.push(predictor, 0, 0);
  seg(0xda, sos);
  let acc = 0, nbits = 0;
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1);
      if (++nbits === 8) { out.push(acc); if (acc === 0xff) out.push(0); acc = 0; nbits = 0; }
    }
  };
  const rowLen = width * nc, init = 1 << (precision - 1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < nc; c++) {
        const i = y * rowLen + x * nc + c;
        let pred: number;
        if (y === 0) pred = x === 0 ? init : data[i - nc];
        else if (x === 0) pred = data[i - rowLen];
        else {
          const a = data[i - nc], b = data[i - rowLen], cc = data[i - rowLen - nc];
          pred = [0, a, b, cc, a + b - cc, a + ((b - cc) >> 1), b + ((a - cc) >> 1), (a + b) >> 1][predictor];
        }
        let diff = ((data[i] - pred) << 16) >> 16; // modulo 2^16, mit Vorzeichen
        if (diff === -32768) diff = 32768;
        const k = diff === 0 ? 0 : diff === 32768 ? 16 : 32 - Math.clz32(Math.abs(diff));
        put(codes[k].code, codes[k].len);
        if (k && k < 16) put(diff > 0 ? diff : diff + (1 << k) - 1, k);
      }
  if (nbits) put(0x7f, 8 - nbits);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

describe("Verlustfreies JPEG", () => {
  for (const [nc, prec, pred] of [[1, 12, 1], [2, 14, 1], [2, 16, 6], [4, 14, 1], [1, 16, 4], [3, 12, 7], [1, 14, 2], [1, 14, 3], [1, 14, 5]] as const) {
    it(`${nc} Komponente(n), ${prec} bit, Prädiktor ${pred}: exakt`, () => {
      const w = 37, h = 23, n = w * h * nc;
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
      const data = new Uint16Array(n);
      const max = (1 << prec) - 1;
      for (let i = 0; i < n; i++) data[i] = Math.min(max, Math.round(max * (0.3 + 0.2 * Math.sin(i / 9)) + (rnd() - 0.5) * 400));
      data[5] = 0; data[6] = max; // Extremwerte
      const r = decodeLjpeg(encodeLjpeg(data, w, h, nc, prec, pred));
      expect([r.width, r.height, r.components, r.precision]).toEqual([w, h, nc, prec]);
      expect(Array.from(r.data)).toEqual(Array.from(data));
    });
  }
});

// Echte Kameradateien (nur lokal vorhanden, nicht im Repository – siehe docs/testdaten.md)
const RAW = ".testdata/raw";
const have = existsSync(RAW);
describe.skipIf(!have)("Kamera-RAW (lokale Testdateien)", () => {
  const first = (dir: string) => `${RAW}/${dir}/${readdirSync(`${RAW}/${dir}`)[0]}`;
  it("eingebettetes JPEG in voller Grösse und Aufnahmedaten", async () => {
    const expected: Record<string, [number, number, string]> = {
      nef: [4928, 3264, "NIKON D5100"], cr2: [6000, 4000, "Canon EOS Rebel T7"], cr3: [8192, 5464, "Canon EOS R5"],
      arw: [7008, 4672, "ILCE-7M4"], raf: [4416, 2944, "X-T4"], dng: [1024, 683, "Canon EOS R6"],
      srw: [6480, 4320, "NX500"],
    };
    for (const [dir, [w, h, model]] of Object.entries(expected)) {
      if (!existsSync(`${RAW}/${dir}`)) continue;
      const b = await openAsBlob(first(dir));
      const p = await rawPreview(b);
      expect([dir, p?.width, p?.height]).toEqual([dir, w, h]);
      const e = await readExifBlob(b);
      expect(e.model).toContain(model);
      expect(e.dateTimeOriginal).toMatch(dir === "srw" ? /^2026:11:03/ : /^2024:04:08/);
      expect(e.exposureTime).toBeGreaterThan(0);
    }
  });
  it("Sensordaten: DNG, CR2, ARW, NEF mit Grösse und Farbmuster wie die Kamera", async () => {
    const expected: Record<string, [number, number, number, string]> = {
      dng: [5472, 3648, SerColor.BAYER_RGGB, "DNG lossless"], cr2: [6000, 4000, SerColor.BAYER_GBRG, "CR2"], arw: [7008, 4672, SerColor.BAYER_RGGB, "ARW lossless"],
      nef: [4928, 3264, SerColor.BAYER_RGGB, "NEF compressed"],
      srw: [6480, 4320, SerColor.BAYER_GRBG, "SRW compressed"],
    };
    for (const [dir, [w, h, cfa, fmt]] of Object.entries(expected)) {
      if (!existsSync(`${RAW}/${dir}`)) continue;
      const r = (await decodeRawData(await openAsBlob(first(dir))))!;
      expect([dir, r.info.format, r.frame.width, r.frame.height, r.frame.colorId, r.frame.bitDepth]).toEqual([dir, fmt, w, h, cfa, 16]);
      // Himmel nach Abzug des Schwarzwerts nahe 0, Korona hell
      const d = r.frame.data;
      let dark = 0, max = 0;
      for (let i = 0; i < d.length; i += 101) if (d[i] < 2000) dark++;
      for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
      if (dir !== "srw") expect(dark / (d.length / 101)).toBeGreaterThan(0.5); // Finsternis: Himmel dunkel (SRW: Zimmeraufnahme)
      expect(max).toBeGreaterThan(dir === "nef" ? 1000 : 8000); // kurze Belichtung: Korona nicht ganz hell
    }
    // nicht (noch) unterstützt → null, dann greift das eingebettete JPEG
    for (const dir of ["cr3", "raf"]) expect(await decodeRawData(await openAsBlob(first(dir)))).toBeNull();
    // Nikon: Weissabgleich der Kamera aus der MakerNote
    const nef = (await decodeRawData(await openAsBlob(first("nef"))))!;
    expect(nef.info.cameraWb?.[0]).toBeCloseTo(506 / 256, 3);
    expect(nef.info.cameraWb?.[2]).toBeCloseTo(365 / 256, 3);
  }, 120_000);
  it.skipIf(!existsSync(`${RAW}/srw`))("Samsung SRW: Schwarzwert 128, Weissabgleich der Kamera", async () => {
    const r = (await decodeRawData(await openAsBlob(first("srw"))))!;
    expect(r.info.cameraWb?.[0]).toBeGreaterThan(1.5);
    expect(r.info.cameraWb?.[2]).toBeGreaterThan(1.5);
    // nach Abzug des Schwarzwerts liegen die dunkelsten 0.1 % nahe 0
    const d = r.frame.data, h = new Uint32Array(65536);
    for (const v of d) h[v]++;
    let acc = 0, p01 = 0;
    for (let v = 0; v < 65536; v++) { acc += h[v]; if (acc >= d.length * 0.001) { p01 = v; break; } }
    expect(p01).toBeLessThan(200);
  }, 60_000);
  // CC0-Muster von raw.pixls.us (Samsung NX500, alle vier Modi), nur lokal
  const PIXLS = ".testdata/raw-srw-pixls";
  it.skipIf(!existsSync(PIXLS))("Samsung NX500: 12/14 bit, normal/lossless gleich hell (Schwarzwert je Bittiefe)", async () => {
    const means: number[] = [];
    for (const f of readdirSync(PIXLS).filter((x) => /\.SRW$/i.test(x))) {
      const r = (await decodeRawData(await openAsBlob(`${PIXLS}/${f}`)))!;
      expect([f, r.info.format, r.frame.width, r.frame.height]).toEqual([f, "SRW compressed", 6480, 4320]);
      let sum = 0;
      for (let i = 0; i < r.frame.data.length; i += 61) sum += r.frame.data[i];
      means.push(sum / (r.frame.data.length / 61));
    }
    expect(means.length).toBe(4);
    // gleiche Szene: Mit falschem Schwarzwert (128 statt 32 bei 12 bit) fielen die Schatten ab. 12 bit ist bei
    // gleicher Belichtung konstant rund 11 % heller als 14 bit (Weisspunkt der Modi) – für Serien unerheblich.
    expect(Math.max(...means) / Math.min(...means)).toBeLessThan(1.2);
  }, 120_000);
});

