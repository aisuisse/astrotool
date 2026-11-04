// Einfacher ZIP-Schreiber ohne Kompression (PNG ist bereits komprimiert). Dateinamen in UTF-8.
// Schreibt über ein ByteSink (Speicher oder direkt auf die Platte). Ab 4 GB oder 65 535 Einträgen mit ZIP64
// (PKWARE APPNOTE 4.3.14/4.3.15): Offset im Zusatzfeld 0x0001, ZIP64-Ende und -Locator vor dem normalen Ende.
import { MemorySink, type ByteSink } from "./sink";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

const MAX32 = 0xffffffff;

export class ZipWriter {
  private central: Uint8Array[] = [];
  private count = 0;
  private readonly enc = new TextEncoder();

  constructor(readonly sink: ByteSink = new MemorySink()) {}

  /** Byte-Grösse bisher (für Fortschritt und Tests) */
  get size(): number {
    return this.sink.size;
  }

  add(name: string, data: Uint8Array, modified = new Date()): void {
    if (data.length >= MAX32) throw new Error("ZIP entry larger than 4 GB");
    const offset = this.sink.size;
    const nameBytes = this.enc.encode(name);
    const crc = crc32(data);
    const [time, date] = dosTime(modified);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true); // ohne Kompression
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const big = offset >= MAX32;
    const cen = new Uint8Array(46 + nameBytes.length + (big ? 12 : 0));
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, big ? 45 : 20, true);
    cv.setUint16(6, big ? 45 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, big ? 12 : 0, true);
    cv.setUint32(42, big ? MAX32 : offset, true);
    cen.set(nameBytes, 46);
    if (big) {
      const o = 46 + nameBytes.length;
      cv.setUint16(o, 0x0001, true);
      cv.setUint16(o + 2, 8, true);
      cv.setBigUint64(o + 4, BigInt(offset), true);
    }

    this.sink.write(local);
    this.sink.write(data);
    this.central.push(cen);
    this.count++;
  }

  get entries(): number {
    return this.count;
  }

  private complete(): void {
    const cdOffset = this.sink.size;
    let cdSize = 0;
    for (const c of this.central) {
      this.sink.write(c);
      cdSize += c.length;
    }
    const zip64 = this.count >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const recOffset = this.sink.size;
      const rec = new Uint8Array(56 + 20);
      const rv = new DataView(rec.buffer);
      rv.setUint32(0, 0x06064b50, true);
      rv.setBigUint64(4, 44n, true); // Grösse des restlichen Satzes
      rv.setUint16(12, 45, true);
      rv.setUint16(14, 45, true);
      rv.setBigUint64(24, BigInt(this.count), true);
      rv.setBigUint64(32, BigInt(this.count), true);
      rv.setBigUint64(40, BigInt(cdSize), true);
      rv.setBigUint64(48, BigInt(cdOffset), true);
      // Locator
      rv.setUint32(56, 0x07064b50, true);
      rv.setBigUint64(64, BigInt(recOffset), true);
      rv.setUint32(72, 1, true);
      this.sink.write(rec);
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, Math.min(this.count, 0xffff), true);
    ev.setUint16(10, Math.min(this.count, 0xffff), true);
    ev.setUint32(12, Math.min(cdSize, MAX32), true);
    ev.setUint32(16, Math.min(cdOffset, MAX32), true);
    this.sink.write(end);
    this.central = [];
  }

  /** abschliessen; Blob nur im Speicher */
  async finish(): Promise<Blob | null> {
    this.complete();
    return this.sink.close("application/zip");
  }

  /** nur für das Ziel im Speicher */
  toBlob(): Blob {
    if (!(this.sink instanceof MemorySink)) throw new Error("toBlob needs a MemorySink");
    this.complete();
    return this.sink.toBlob("application/zip");
  }
}
