import { describe, expect, it } from "vitest";
import { SerColor, type Frame } from "../src/engine/ser";
import { JoinedSource, msToTicks, type FrameSource } from "../src/engine/source";
import { defaultOptions, processSource } from "../src/engine/pipeline";

/** Scheibe bei (cx, cy); blur = Unschärfe der Kante (grösser = weniger scharf) */
function disc(w: number, h: number, cx: number, cy: number, r: number, blur: number): Frame {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      data[y * w + x] = Math.round((200 * (0.7 + 0.3 * Math.cos(x / 1.5) * Math.cos(y / 1.5))) / (1 + Math.exp((d - r) / blur)));
    }
  return { width: w, height: h, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data };
}

/** Kleine Aufnahme im Speicher: n Bilder, Schärfe je Bild, Zeitstempel ab t0 (ms) im Abstand von 100 ms */
function recording(name: string, blurs: number[], t0: number | null, size = 64, colorId: number = SerColor.MONO): FrameSource {
  const frames = blurs.map((b, i) => ({ ...disc(size, size, 30 + i, 32, 12, b), colorId }));
  return {
    kind: "ser", width: size, height: size, frameCount: frames.length, colorId, bitDepth: 8,
    readFrame: async (i) => frames[i],
    readTimestamps: async () => (t0 === null ? null : BigInt64Array.from(frames.map((_, i) => msToTicks(t0 + 100 * i)))),
    frameName: (i) => `${name}_${i + 1}`,
    meta: { observer: "Test" },
    clock: "utc",
    fps: 10,
  };
}

describe("Aufnahmen zusammenfügen (wie PIPP -join)", () => {
  it("Bilder, Namen und Zeitstempel laufen über alle Dateien", async () => {
    const a = recording("a", [0.6, 0.6, 0.6], 1000), b = recording("b", [0.6, 0.6], 5000);
    const j = new JoinedSource([a, b]);
    expect(j.frameCount).toBe(5);
    expect([0, 2, 3, 4].map((i) => j.frameName(i))).toEqual(["a_1", "a_3", "b_1", "b_2"]);
    expect((await j.readFrame(3)).data).toEqual((await b.readFrame(0)).data);
    const ts = (await j.readTimestamps())!;
    expect(Array.from(ts.slice(2, 4))).toEqual([msToTicks(1200), msToTicks(5000)]);
    // eine Datei ohne Zeitstempel: keine für die ganze Serie
    expect(await new JoinedSource([a, recording("c", [0.6], null)]).readTimestamps()).toBeNull();
  });

  it("verschiedene Grösse oder Farbart wird abgelehnt", () => {
    expect(() => new JoinedSource([recording("a", [0.6], 0), recording("b", [0.6], 0, 48)])).toThrow(/joinMismatch|48/);
    expect(() => new JoinedSource([recording("a", [0.6], 0), recording("b", [0.6], 0, 64, SerColor.BAYER_RGGB)])).toThrow();
  });

  it("die besten Bilder werden aus allen Dateien gewählt", async () => {
    // scharfe Bilder in beiden Dateien verteilt
    const a = recording("a", [3, 0.5, 3, 3], 0), b = recording("b", [0.5, 3, 0.5, 3], 1000);
    const written: string[] = [];
    const j = new JoinedSource([a, b]);
    await processSource(j, { ...defaultOptions, cropWidth: 40, cropHeight: 40, keepMode: "count", keepValue: 3 }, (_f, r) => { written.push(j.frameName(r.index)); });
    expect(written.sort()).toEqual(["a_2", "b_1", "b_3"]);
  });
});
