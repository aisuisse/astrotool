import { describe, expect, it } from "vitest";
import { FileSink, MemorySink, type ByteSink, type WritableFile } from "../src/engine/sink";
import { SerReader, SerWriter, type Frame } from "../src/engine/ser";
import { ZipWriter } from "../src/engine/zip";

/** nachgebildete Datei: sammelt die Schreibaufträge an ihren Positionen */
class FakeFile implements WritableFile {
  bytes = new Uint8Array(0);
  writes = 0;
  closed = false;
  aborted = false;
  constructor(private failAt = Infinity) {}
  async write(op: { type: "write"; position: number; data: Uint8Array }) {
    await new Promise((r) => setTimeout(r, 0)); // wirklich asynchron
    if (++this.writes >= this.failAt) throw new Error("disk full");
    const end = op.position + op.data.length;
    if (end > this.bytes.length) { const n = new Uint8Array(end); n.set(this.bytes); this.bytes = n; }
    this.bytes.set(op.data, op.position);
  }
  async close() { this.closed = true; }
  async abort() { this.aborted = true; }
}

const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

async function fill(sink: ByteSink) {
  sink.write(pattern(10, 1));
  sink.write(pattern(100, 2)); // grösser als der Puffer
  for (let k = 0; k < 20; k++) { sink.write(pattern(7, k)); await sink.drain(); }
  sink.writeAt(0, pattern(4, 9)); // schon auf der Platte
  sink.writeAt(sink.size - 3, pattern(3, 5)); // noch im Puffer
  sink.writeAt(sink.size - 30, pattern(25, 6)); // halb Platte, halb Puffer
}

describe("Ausgabe-Ziel (Speicher / Platte)", () => {
  it("Platte und Speicher ergeben dieselben Bytes, auch mit kleinem Puffer und Korrekturen", async () => {
    const mem = new MemorySink();
    await fill(mem);
    const expected = new Uint8Array(await (await mem.close()).arrayBuffer());
    for (const buf of [16, 64, 1 << 20]) {
      const file = new FakeFile();
      const disk = new FileSink(file, buf);
      await fill(disk);
      expect(await disk.close()).toBeNull();
      expect(file.closed).toBe(true);
      expect(file.bytes).toEqual(expected);
    }
  });

  it("Schreibfehler (Platte voll): drain meldet ihn, die Datei wird verworfen", async () => {
    const file = new FakeFile(3);
    const disk = new FileSink(file, 16);
    let err: unknown = null;
    try {
      for (let k = 0; k < 20; k++) { disk.write(pattern(10, k)); await disk.drain(); }
      await disk.close();
    } catch (e) { err = e; }
    expect(String(err)).toMatch(/disk full/);
    await disk.abort();
    expect(file.aborted).toBe(true);
    expect(file.closed).toBe(false);
  });
});

describe("SER direkt auf die Platte", () => {
  it("gleiche Datei wie im Speicher, Bildzahl im Kopf nachgetragen, Zeitstempel angehängt", async () => {
    const header = { luId: 0, colorId: 0, littleEndianFlag: 0, width: 20, height: 10, bitDepth: 16, observer: "o", instrument: "i", telescope: "t", dateTime: 5n, dateTimeUtc: 5n };
    const frames: Frame[] = [0, 1, 2].map((k) => ({ width: 20, height: 10, planes: 1, bitDepth: 16, colorId: 0, data: Uint16Array.from({ length: 200 }, (_, i) => i * 300 + k) }));
    const mem = new SerWriter(header);
    const file = new FakeFile();
    const disk = new SerWriter(header, new FileSink(file, 256));
    for (const [k, f] of frames.entries()) { mem.add(f, BigInt(1000 + k)); disk.add(f, BigInt(1000 + k)); await disk.sink.drain(); }
    const blob = mem.toBlob();
    expect(await disk.finish()).toBeNull();
    expect(file.bytes).toEqual(new Uint8Array(await blob.arrayBuffer()));
    const r = await SerReader.open(new Blob([file.bytes as BlobPart]));
    expect(r.header.frameCount).toBe(3);
    expect(Array.from((await r.readFrame(2)).data.slice(0, 3))).toEqual([2, 302, 602]);
    expect(Array.from((await r.readTimestamps())!)).toEqual([1000n, 1001n, 1002n]);
  });
});

/** Ziel, das nur zählt und kleine Stücke behält – so lässt sich eine Datei über 4 GB nachbilden */
class CountingSink implements ByteSink {
  kept: { pos: number; data: Uint8Array }[] = [];
  constructor(public size = 0) {}
  write(d: Uint8Array) { if (d.length < 4096) this.kept.push({ pos: this.size, data: d.slice() }); this.size += d.length; }
  writeAt() {}
  async drain() {}
  async close() { return null; }
  async abort() {}
  /** Bytes ab Position (nur aus den behaltenen Stücken) */
  at(pos: number, n: number): DataView {
    const out = new Uint8Array(n);
    for (const k of this.kept) for (let i = 0; i < k.data.length; i++) { const p = k.pos + i - pos; if (p >= 0 && p < n) out[p] = k.data[i]; }
    return new DataView(out.buffer);
  }
}

describe("ZIP64", () => {
  it("Einträge hinter 4 GB: Offset im Zusatzfeld, ZIP64-Ende und Locator", async () => {
    const start = 5_000_000_000; // als stünden schon 5 GB in der Datei
    const sink = new CountingSink(start);
    const zip = new ZipWriter(sink);
    zip.add("a.png", pattern(50, 1));
    zip.add("b.png", pattern(60, 2));
    await zip.finish();
    const end = sink.at(sink.size - 22, 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint32(16, true)).toBe(0xffffffff); // Verzeichnis-Offset → ZIP64
    const loc = sink.at(sink.size - 42, 20);
    expect(loc.getUint32(0, true)).toBe(0x07064b50);
    const recPos = Number(loc.getBigUint64(8, true));
    const rec = sink.at(recPos, 56);
    expect(rec.getUint32(0, true)).toBe(0x06064b50);
    expect(rec.getBigUint64(24, true)).toBe(2n);
    const cdPos = Number(rec.getBigUint64(48, true));
    const cen = sink.at(cdPos, 46 + 5 + 12);
    expect(cen.getUint32(0, true)).toBe(0x02014b50);
    expect(cen.getUint16(6, true)).toBe(45);
    expect(cen.getUint32(42, true)).toBe(0xffffffff);
    expect(cen.getUint16(51, true)).toBe(0x0001);
    expect(Number(cen.getBigUint64(55, true))).toBe(start);
  });

  it("kleine Archive bleiben normales ZIP", async () => {
    const zip = new ZipWriter();
    zip.add("x.txt", pattern(5, 0));
    const b = new Uint8Array(await zip.toBlob().arrayBuffer());
    expect(new DataView(b.buffer).getUint32(b.length - 22, true)).toBe(0x06054b50);
    expect(b.length).toBe(30 + 5 + 5 + 46 + 5 + 22);
  });

  it("mehr als 65 535 Einträge: Anzahl im ZIP64-Ende", async () => {
    const sink = new CountingSink();
    const zip = new ZipWriter(sink);
    const d = pattern(1, 0);
    for (let k = 0; k < 70_000; k++) zip.add(`${k}.png`, d);
    await zip.finish();
    const end = sink.at(sink.size - 22, 22);
    expect(end.getUint16(10, true)).toBe(0xffff);
    const recPos = Number(sink.at(sink.size - 42, 20).getBigUint64(8, true));
    expect(sink.at(recPos, 56).getBigUint64(32, true)).toBe(70_000n);
  });
});
