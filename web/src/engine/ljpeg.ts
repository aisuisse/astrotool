// Verlustfreies JPEG (ITU-T T.81, Prozess 14, „Lossless JPEG“ / LJ92) – so speichern DNG, Canon CR2 und
// neuere Sony-ARW ihre Rohdaten. Eigene Umsetzung nach der Norm: Huffman-kodierte Differenzen zu einem
// Vorhersagewert aus den Nachbarn (Prädiktor 1–7), Punkt-Transformation, Restart-Marker.

export interface LjpegImage {
  /** Bildbreite in Abtastwerten je Komponente (Kopf SOF3) */
  width: number;
  height: number;
  components: number;
  precision: number;
  /** Abtastwerte zeilenweise, Komponenten verschachtelt: Zeile = width × components Werte */
  data: Uint16Array;
}

interface Huff {
  /** Nachschlagetabelle für 16-Bit-Vorschau: (Länge << 8) | Wert, 0 = länger als 16 Bit */
  lut: Uint32Array;
}

function buildHuff(counts: Uint8Array, symbols: Uint8Array): Huff {
  const lut = new Uint32Array(1 << 16);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const sym = symbols[k++];
      const shift = 16 - len;
      const start = code << shift, end = (code + 1) << shift;
      for (let c = start; c < end; c++) lut[c] = (len << 8) | sym;
      code++;
    }
    code <<= 1;
  }
  return { lut };
}

export function decodeLjpeg(buf: Uint8Array): LjpegImage {
  let p = 0;
  const u16 = (o: number) => (buf[o] << 8) | buf[o + 1];
  if (u16(0) !== 0xffd8) throw new Error("ljpeg: kein SOI");
  p = 2;
  const huff: (Huff | undefined)[] = [];
  let width = 0, height = 0, precision = 0, nc = 0;
  const compIds: number[] = [];
  let restart = 0;
  let tables: number[] = [];
  let predictor = 1, pt = 0;
  for (;;) {
    if (p + 4 > buf.length) throw new Error("ljpeg: Ende ohne SOS");
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff || m === 0x00) { p++; continue; }
    const len = u16(p + 2);
    const seg = p + 4;
    if (m === 0xc3) {
      precision = buf[seg]; height = u16(seg + 1); width = u16(seg + 3); nc = buf[seg + 5];
      for (let i = 0; i < nc; i++) compIds.push(buf[seg + 6 + 3 * i]);
    } else if (m === 0xc4) {
      let q = seg;
      while (q < seg + len - 2) {
        const id = buf[q] & 0x0f;
        const counts = buf.subarray(q + 1, q + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        huff[id] = buildHuff(counts, buf.subarray(q + 17, q + 17 + total));
        q += 17 + total;
      }
    } else if (m === 0xdd) {
      restart = u16(seg);
    } else if (m === 0xda) {
      const ns = buf[seg];
      tables = [];
      for (let i = 0; i < ns; i++) {
        const cid = buf[seg + 1 + 2 * i];
        const idx = compIds.indexOf(cid);
        tables[idx >= 0 ? idx : i] = buf[seg + 2 + 2 * i] >> 4;
      }
      predictor = buf[seg + 1 + 2 * ns];
      pt = buf[seg + 3 + 2 * ns] & 0x0f;
      p = seg + len - 2;
      break;
    } else if (m === 0xd9) throw new Error("ljpeg: EOI vor SOS");
    p += 2 + len;
  }
  if (!width || !height || !nc) throw new Error("ljpeg: kein SOF3");
  const rowLen = width * nc;
  const data = new Uint16Array(rowLen * height);
  const luts = tables.map((t) => huff[t]?.lut);
  if (luts.some((l) => !l)) throw new Error("ljpeg: Huffman-Tabelle fehlt");

  // Bitleser mit Byte-Stuffing (FF 00) und Erkennung von Markern
  let bitBuf = 0, bitCnt = 0, pos = p, marker = false;
  const fill = () => {
    while (bitCnt <= 24) {
      let byte = 0;
      if (!marker && pos < buf.length) {
        byte = buf[pos];
        if (byte === 0xff) {
          const nx = buf[pos + 1];
          if (nx === 0x00) pos += 2;
          else { marker = true; byte = 0; }
        } else pos++;
      }
      bitBuf = ((bitBuf << 8) | byte) >>> 0;
      bitCnt += 8;
    }
  };
  const peek16 = () => { fill(); return (bitBuf >>> (bitCnt - 16)) & 0xffff; };
  const skip = (n: number) => { bitCnt -= n; bitBuf &= bitCnt >= 32 ? 0xffffffff : (1 << bitCnt) - 1; };
  const bits = (n: number) => {
    if (n === 0) return 0;
    if (n === 16) return 32768; // Sonderfall der Norm (Differenz 32768)
    fill();
    const v = (bitBuf >>> (bitCnt - n)) & ((1 << n) - 1);
    skip(n);
    return v;
  };
  const resetBits = () => {
    // Restart: Bitpuffer leeren, Marker überspringen
    bitBuf = 0; bitCnt = 0;
    while (pos < buf.length - 1 && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++;
    pos += 2;
    marker = false;
  };

  const init = 1 << (precision - pt - 1);
  // Erste Zeile (und erste Zeile nach einem Restart): links als Vorhersage, ganz vorne der Startwert
  let firstRow = true;
  for (let y = 0; y < height; y++) {
    const row = y * rowLen;
    if (restart && y > 0 && (y * width) % restart === 0) { resetBits(); firstRow = true; }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < nc; c++) {
        const lut = luts[c]!;
        const e = lut[peek16()];
        const len = e >>> 8;
        if (!len) throw new Error("ljpeg: ungültiger Huffman-Code");
        skip(len);
        const s = e & 0xff;
        let diff = 0;
        if (s) {
          diff = bits(s);
          if (s < 16 && diff < 1 << (s - 1)) diff -= (1 << s) - 1;
        }
        const i = row + x * nc + c;
        let pred: number;
        if (firstRow) pred = x === 0 ? init : data[i - nc];
        else if (x === 0) pred = data[i - rowLen];
        else {
          const a = data[i - nc], b = data[i - rowLen], cc = data[i - rowLen - nc];
          switch (predictor) {
            case 1: pred = a; break;
            case 2: pred = b; break;
            case 3: pred = cc; break;
            case 4: pred = a + b - cc; break;
            case 5: pred = a + ((b - cc) >> 1); break;
            case 6: pred = b + ((a - cc) >> 1); break;
            case 7: pred = (a + b) >> 1; break;
            default: pred = a;
          }
        }
        data[i] = (pred + diff) & 0xffff;
      }
    }
    firstRow = false;
  }
  if (pt) for (let i = 0; i < data.length; i++) data[i] <<= pt;
  return { width, height, components: nc, precision, data };
}
