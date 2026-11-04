// Setzt Erstellungs- und Änderungszeit in einer MP4-Datei (Boxen mvhd, tkhd, mdhd).
// Google Fotos, Handys und Explorer sortieren Videos nach diesem Zeitstempel ("creation_time").
// Die Videodaten selbst bleiben unverändert; geändert werden nur Zahlenfelder fester Länge.

const SECONDS_1904_TO_1970 = 2_082_844_800;
const CONTAINERS = new Set(["moov", "trak", "mdia"]);
const TIMED = new Set(["mvhd", "tkhd", "mdhd"]);

/** Ändert die Datei an Ort und Stelle. Gibt die Anzahl geänderter Boxen zurück. */
export function setMp4CreationTime(data: Uint8Array, date: Date): number {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const secs = BigInt(Math.floor(date.getTime() / 1000) + SECONDS_1904_TO_1970);
  let changed = 0;

  const walk = (start: number, end: number) => {
    let off = start;
    while (off + 8 <= end) {
      let size = v.getUint32(off);
      const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return;
        size = Number(v.getBigUint64(off + 8));
        header = 16;
      } else if (size === 0) size = end - off;
      if (size < header || off + size > end) return; // beschädigt – nichts anfassen
      if (CONTAINERS.has(type)) walk(off + header, off + size);
      else if (TIMED.has(type)) {
        const p = off + header; // Version (1 Byte) + Flags (3 Byte)
        const version = data[p];
        if (version === 1 && p + 20 <= off + size) {
          v.setBigUint64(p + 4, secs);
          v.setBigUint64(p + 12, secs);
          changed++;
        } else if (version === 0 && p + 12 <= off + size) {
          v.setUint32(p + 4, Number(secs & 0xffffffffn));
          v.setUint32(p + 8, Number(secs & 0xffffffffn));
          changed++;
        }
      }
      off += size;
    }
  };
  walk(0, data.byteLength);
  return changed;
}
