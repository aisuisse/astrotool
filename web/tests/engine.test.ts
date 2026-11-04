import { describe, expect, it } from "vitest";
import { buildSerHeader, parseSerHeader, SerColor, SerReader, SerWriter, type Frame } from "../src/engine/ser";
import { cropFrame, detectObject, toLum } from "../src/engine/image";
import { gradientQuality } from "../src/engine/quality";
import { defaultOptions, processSer } from "../src/engine/pipeline";
import { applyPof, parsePof } from "../src/engine/pof";

/** Scheibe mit Radius r bei (cx, cy); blur = Kantenbreite. */
function disc(w: number, h: number, cx: number, cy: number, r: number, blur = 0.6, depth = 8): Frame {
  const max = (1 << depth) - 1;
  const data = depth > 8 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const stripes = 0.7 + 0.3 * Math.cos(y / 2);
      data[y * w + x] = Math.round((max * 0.8 * stripes) / (1 + Math.exp((d - r) / blur)));
    }
  return { width: w, height: h, planes: 1, bitDepth: depth, colorId: SerColor.MONO, data };
}

const baseHeader = {
  luId: 0, colorId: 0, littleEndianFlag: 0, observer: "Test", instrument: "Cam", telescope: "Scope",
  dateTime: 0n, dateTimeUtc: 0n,
};

describe("SER", () => {
  it("Header hin und zurück", () => {
    const h = { ...baseHeader, width: 320, height: 240, bitDepth: 12, frameCount: 7 };
    const p = parseSerHeader(buildSerHeader(h));
    expect(p).toMatchObject({ width: 320, height: 240, bitDepth: 12, frameCount: 7, observer: "Test" });
  });

  it("schreibt und liest 16-bit-Frames mit Zeitstempeln", async () => {
    const w = new SerWriter({ ...baseHeader, width: 40, height: 30, bitDepth: 16 });
    w.add(disc(40, 30, 20, 15, 8, 0.6, 16), 111n);
    w.add(disc(40, 30, 10, 10, 5, 0.6, 16), 222n);
    const r = await SerReader.open(w.toBlob());
    expect(r.header.frameCount).toBe(2);
    expect(Array.from((await r.readTimestamps())!)).toEqual([111n, 222n]);
    const f = await r.readFrame(1);
    expect(f.data).toBeInstanceOf(Uint16Array);
    expect(f.data[10 * 40 + 10]).toBeGreaterThan(30000);
  });

  it("kürzt abgebrochene Aufnahmen auf vollständige Frames", async () => {
    const w = new SerWriter({ ...baseHeader, width: 10, height: 10, bitDepth: 8 });
    for (let i = 0; i < 3; i++) w.add(disc(10, 10, 5, 5, 3));
    const full = new Uint8Array(await w.toBlob().arrayBuffer());
    const r = await SerReader.open(new Blob([full.slice(0, full.length - 50)]));
    expect(r.header.frameCount).toBe(2);
  });
});

describe("Erkennung und Zuschnitt", () => {
  it("findet den Schwerpunkt einer Scheibe", () => {
    const d = detectObject(toLum(disc(200, 150, 123.5, 61.5, 20)));
    expect(d.found).toBe(true);
    expect(d.cx).toBeCloseTo(123.5, 0);
    expect(d.cy).toBeCloseTo(61.5, 0);
    expect(d.size).toBeGreaterThanOrEqual(38);
    expect(d.size).toBeLessThanOrEqual(44);
  });

  it("ignoriert einzelne Hotpixel", () => {
    const f = disc(100, 100, 30, 30, 10);
    f.data[95 * 100 + 95] = 255;
    const d = detectObject(toLum(f));
    expect(d.x1).toBeLessThan(50);
  });

  it("füllt Bereiche ausserhalb schwarz auf", () => {
    const c = cropFrame(disc(20, 20, 10, 10, 5), -5, -5, 10, 10);
    expect(c.data[0]).toBe(0);
    expect(c.width).toBe(10);
  });
});

describe("Qualität", () => {
  it("scharfe Frames schneiden besser ab als unscharfe", () => {
    const sharp = gradientQuality(toLum(disc(128, 128, 64, 64, 40, 0.4)));
    const soft = gradientQuality(toLum(disc(128, 128, 64, 64, 40, 4)));
    expect(sharp).toBeGreaterThan(soft);
  });
});

describe("Pipeline", () => {
  it("zentriert, bewertet und behält die besten Frames", async () => {
    const w = new SerWriter({ ...baseHeader, width: 160, height: 120, bitDepth: 8 });
    const blurs = [3, 0.4, 2, 0.8, 5];
    blurs.forEach((b, i) => w.add(disc(160, 120, 50 + i * 12, 40 + i * 8, 18, b), BigInt(i + 1)));
    w.add(disc(160, 120, 80, 60, 2)); // zu klein → verworfen
    const r = await SerReader.open(w.toBlob());
    const { blob, report } = await processSer(r, {
      ...defaultOptions, cropWidth: 64, cropHeight: 64, minObjectSize: 20, keepMode: "count", keepValue: 3,
    });
    expect(report.frames.filter((f) => !f.accepted).map((f) => f.index)).toEqual([5]);
    expect(report.written).toEqual([1, 3, 2]);
    const out = await SerReader.open(blob);
    expect(out.header).toMatchObject({ width: 64, height: 64, frameCount: 3 });
    expect(Array.from((await out.readTimestamps())!)).toEqual([2n, 4n, 3n]);
    const centre = detectObject(toLum(await out.readFrame(0)));
    expect(centre.cx).toBeCloseTo(32, 0);
    expect(centre.cy).toBeCloseTo(32, 0);
  });
});

describe("PIPP-Optionsdatei", () => {
  it("übernimmt bekannte Werte", () => {
    const pof = parsePof("[PIPP OPTIONS FILE]\nCROP_WIDTH 300\nCROP_HEIGHT 280\nCENTRE_PLANET True\nQUALITY_LIMITING 1\nQUALITY_FRAMES 500\nGIF_FPS_VALUE 10\n");
    const { options, ignored } = applyPof(defaultOptions, pof);
    expect(options).toMatchObject({ cropWidth: 300, cropHeight: 280, centre: true, keepMode: "count", keepValue: 500 });
    expect(ignored).toEqual(["GIF_FPS_VALUE"]);
  });
});

describe("Zeitraffer-Planung", () => {
  it("vorwärts, Standbild am Ende, hin und zurück", async () => {
    const { buildSequence, outputSize, ticksToClock } = await import("../src/engine/timelapse");
    expect(buildSequence(4, { fps: 2, holdLastSeconds: 1, pingPong: false })).toEqual([0, 1, 2, 3, 3, 3]);
    expect(buildSequence(4, { fps: 2, holdLastSeconds: 0, pingPong: true })).toEqual([0, 1, 2, 3, 2, 1]);
    expect(outputSize(1080, 1080, { width: 541, format: "mp4-hevc" })).toEqual([540, 540]);
    // MP4 zum Teilen: höchstens 1920 auf der langen Seite
    expect(outputSize(6480, 4320, { width: 0, format: "mp4-h264" })).toEqual([1920, 1280]);
    expect(outputSize(4320, 6480, { width: 0, format: "mp4-hevc" })).toEqual([1280, 1920]);
    expect(outputSize(6480, 4320, { width: 0, format: "gif" })).toEqual([6480, 4320]);
    expect(outputSize(1080, 721, { width: 0, format: "gif" })).toEqual([1080, 721]);
    // konstante Bildrate: 8 fps → 30 fps, Standbild 3 Bilder lang, keine aufsummierte Abweichung
    const { constantRateCounts, videoFrameRate } = await import("../src/engine/timelapse");
    const c = constantRateCounts([1, 1, 1, 1, 3], 8, 30);
    expect(c.reduce((a, b) => a + b, 0)).toBe(26); // 7 Bilder / 8 fps × 30 = 26.25
    expect(Math.max(...c.slice(0, 4)) - Math.min(...c.slice(0, 4))).toBeLessThanOrEqual(1);
    expect(videoFrameRate(8)).toBe(30);
    expect(videoFrameRate(50)).toBe(60);
    expect(ticksToClock(621_355_968_000_000_000n + BigInt(Date.UTC(2026, 7, 12, 19, 33, 9)) * 10_000n)).toBe("19:33:09");
  });
});

describe("Robustheit", () => {
  it("überspringt unlesbare Bilder statt abzubrechen", async () => {
    const { processSource } = await import("../src/engine/pipeline");
    const good = disc(64, 64, 32, 32, 12);
    const src = {
      kind: "images" as const, width: 64, height: 64, frameCount: 3, colorId: 0, bitDepth: 8, meta: {}, clock: "utc" as const,
      frameName: (i: number) => `img${i}`,
      readTimestamps: async () => null,
      readFrame: async (i: number) => { if (i === 1) throw new Error("kaputt"); return good; },
    };
    const written: number[] = [];
    const report = await processSource(src, { ...defaultOptions, cropWidth: 32, cropHeight: 32, qualityEnabled: false }, (_f, r) => { written.push(r.index); });
    expect(written).toEqual([0, 2]);
    expect(report.frames[1]).toMatchObject({ accepted: false, reason: "@unreadable" });
  });
});

describe("Aufnahmedatum für Video-Metadaten", () => {
  it("UTC bleibt, Kamerazeit wird als Ortszeit dieses Rechners gedeutet", async () => {
    const { captureDate } = await import("../src/engine/timelapse");
    const ticks = 621_355_968_000_000_000n + BigInt(Date.UTC(2026, 7, 12, 19, 33, 9)) * 10_000n;
    expect(captureDate(ticks, "utc")!.toISOString()).toBe("2026-08-12T19:33:09.000Z");
    const local = captureDate(ticks, "local")!;
    // gleiche Wanduhrzeit in der Zeitzone des Testrechners
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 7, 12, 19, 33]);
    expect(captureDate(undefined, "utc")).toBeUndefined();
  });
});

describe("MP4-Erstellungszeit", () => {
  it("setzt mvhd (v0), tkhd (v1) und mdhd in verschachtelten Boxen", async () => {
    const { setMp4CreationTime } = await import("../src/engine/mp4time");
    const box = (type: string, body: Uint8Array) => {
      const b = new Uint8Array(8 + body.length);
      new DataView(b.buffer).setUint32(0, b.length);
      for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
      b.set(body, 8);
      return b;
    };
    const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
    const v0 = new Uint8Array(100), v1 = new Uint8Array(100); v1[0] = 1;
    const file = cat(box("ftyp", new Uint8Array(8)), box("moov", cat(box("mvhd", v0.slice()), box("trak", cat(box("tkhd", v1.slice()), box("mdia", box("mdhd", v0.slice())))))), box("mdat", new Uint8Array(16)));
    const date = new Date("2026-08-12T17:33:09Z");
    expect(setMp4CreationTime(file, date)).toBe(3);
    const secs = Math.floor(date.getTime() / 1000) + 2_082_844_800;
    const dv = new DataView(file.buffer);
    const find = (t: string) => { for (let i = 0; i < file.length - 4; i++) if (String.fromCharCode(...file.slice(i, i + 4)) === t) return i + 4; return -1; };
    expect(dv.getUint32(find("mvhd") + 4)).toBe(secs);
    expect(Number(dv.getBigUint64(find("tkhd") + 4))).toBe(secs);
    expect(dv.getUint32(find("mdhd") + 8)).toBe(secs); // Änderungszeit
  });
});
