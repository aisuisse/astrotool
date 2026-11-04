import { describe, expect, it } from "vitest";
import { AviSource } from "../src/engine/avi";
import { SerColor } from "../src/engine/ser";

// Minimaler AVI-Schreiber nur für die Tests (Aufbau wie bei SharpCap/FireCapture/FFmpeg)
const enc = new TextEncoder();
function chunk(id: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(enc.encode(id));
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}
function list(type: string, id: string, parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat([enc.encode(type), ...parts]);
  return chunk(id, body);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32s(...v: number[]) {
  const b = new Uint8Array(v.length * 4);
  v.forEach((x, i) => new DataView(b.buffer).setInt32(i * 4, x, true));
  return b;
}

interface AviSpec { w: number; h: number; bitCount: number; compression: string | 0; frames: Uint8Array[]; palette?: Uint8Array; audioFirst?: boolean; split?: boolean }
function makeAvi(s: AviSpec): Blob {
  const avih = u32s(33333, 0, 0, 0x10, s.frames.length, 0, s.audioFirst ? 2 : 1, 0, s.w, s.h, 0, 0, 0, 0);
  const strh = (type: string, handler: string) => concat([enc.encode(type), enc.encode(handler), u32s(0, 0, 0, 1, 30, 0, s.frames.length, 0, 0, 0), new Uint8Array(8)]);
  const bih = new Uint8Array(40);
  const v = new DataView(bih.buffer);
  v.setUint32(0, 40, true); v.setInt32(4, s.w, true); v.setInt32(8, s.h, true); v.setUint16(12, 1, true); v.setUint16(14, s.bitCount, true);
  if (s.compression) bih.set(enc.encode(s.compression), 16);
  const vidStrl = list("strl", "LIST", [chunk("strh", strh("vids", s.compression || "DIB ")), chunk("strf", s.palette ? concat([bih, s.palette]) : bih)]);
  const audStrl = list("strl", "LIST", [chunk("strh", strh("auds", "\0\0\0\0")), chunk("strf", new Uint8Array(18))]);
  const hdrl = list("hdrl", "LIST", [chunk("avih", avih), ...(s.audioFirst ? [audStrl, vidStrl] : [vidStrl])]);
  const vid = s.audioFirst ? "01" : "00";
  const frameChunks = s.frames.map((f, i) => concat([chunk(`${vid}db`, f), ...(s.audioFirst && i % 2 ? [chunk("00wb", new Uint8Array(7))] : [])]));
  if (!s.split) {
    const movi = list("movi", "LIST", [chunk("JUNK", new Uint8Array(13)), ...frameChunks]);
    return new Blob([list("AVI ", "RIFF", [hdrl, movi])]);
  }
  // OpenDML: zweiter RIFF-Abschnitt „AVIX“ mit weiteren Bildern
  const half = Math.ceil(frameChunks.length / 2);
  const riff1 = list("AVI ", "RIFF", [hdrl, list("movi", "LIST", frameChunks.slice(0, half))]);
  const riff2 = list("AVIX", "RIFF", [list("movi", "LIST", frameChunks.slice(half))]);
  return new Blob([riff1, riff2]);
}

describe("AVI lesen", () => {
  it("8 bit grau (Y800), von oben nach unten, mit JUNK-Chunk", async () => {
    const w = 5, h = 3;
    const frames = [0, 1, 2].map((k) => Uint8Array.from({ length: w * h }, (_, i) => (i * 10 + k) & 255));
    const src = await AviSource.open(makeAvi({ w, h, bitCount: 8, compression: "Y800", frames }), "jupiter.avi");
    expect([src.width, src.height, src.frameCount, src.colorId, src.bitDepth]).toEqual([5, 3, 3, SerColor.MONO, 8]);
    expect(src.fps).toBeCloseTo(30, 5);
    expect(Array.from((await src.readFrame(2)).data)).toEqual(Array.from(frames[2]));
    expect(src.frameName(0)).toBe("jupiter_1");
  });

  it("24 bit BGR, von unten nach oben, Zeilen auf 4 Byte aufgefüllt (ungerade Breite)", async () => {
    const w = 3, h = 2, stride = 12; // 3 × 3 Byte = 9 → auf 12 aufgefüllt
    // gewünschtes Bild (RGB, oben links beginnend)
    const rgb = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [11, 21, 31], [41, 51, 61], [71, 81, 91]];
    const raw = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b] = rgb[y * w + x];
        const o = (h - 1 - y) * stride + x * 3; // unterste Zeile zuerst
        raw[o] = b; raw[o + 1] = g; raw[o + 2] = r;
      }
    const src = await AviSource.open(makeAvi({ w, h, bitCount: 24, compression: 0, frames: [raw] }), "sonne.avi");
    const f = await src.readFrame(0);
    expect(f.colorId).toBe(SerColor.RGB);
    expect(Array.from(f.data)).toEqual(rgb.flat());
  });

  it("8 bit mit grauer Palette (DIB), Audiospur vor der Videospur", async () => {
    const w = 4, h = 2;
    const palette = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) palette.set([i, i, i, 0], i * 4);
    const raw = Uint8Array.from({ length: w * h }, (_, i) => i * 30); // Breite 4 → kein Auffüllen
    const src = await AviSource.open(makeAvi({ w, h, bitCount: 8, compression: 0, frames: [raw, raw], palette, audioFirst: true }), "mond.avi");
    expect(src.frameCount).toBe(2);
    const f = await src.readFrame(1);
    expect(f.planes).toBe(1);
    // von unten nach oben: Zeile 1 der Datei ist Zeile 0 im Bild
    expect(Array.from(f.data)).toEqual([120, 150, 180, 210, 0, 30, 60, 90]);
  });

  it("16 bit grau (Y16) und OpenDML mit zweitem RIFF-Abschnitt", async () => {
    const w = 2, h = 2;
    const frames = [0, 1, 2, 3, 4].map((k) => {
      const b = new Uint8Array(8);
      const d = new DataView(b.buffer);
      for (let i = 0; i < 4; i++) d.setUint16(i * 2, 1000 * k + i, true);
      return b;
    });
    const src = await AviSource.open(makeAvi({ w, h, bitCount: 16, compression: "Y16 ", frames, split: true }), "saturn.avi");
    expect([src.frameCount, src.bitDepth]).toEqual([5, 16]);
    expect(Array.from((await src.readFrame(4)).data)).toEqual([4000, 4001, 4002, 4003]);
  });

  it("verständliche Meldung bei unbekanntem Format und bei Nicht-AVI", async () => {
    await expect(AviSource.open(makeAvi({ w: 2, h: 2, bitCount: 12, compression: "H264", frames: [new Uint8Array(4)] }), "x.avi")).rejects.toThrow(/aviUnsupported/);
    await expect(AviSource.open(new Blob([new Uint8Array(64)]), "x.avi")).rejects.toThrow(/aviInvalid/);
  });
});
