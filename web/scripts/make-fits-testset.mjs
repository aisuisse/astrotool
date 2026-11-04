// FITS-Bildserie aus einer SER-Aufnahme (8 oder 16 bit, grau oder Bayer) – für den App-Volltest.
// Je Bild eine Datei, 16 bit (BZERO 32768), unterste Zeile zuerst (FITS-Norm, ohne ROWORDER), BAYERPAT in
// Dateireihenfolge, DATE-OBS aus den SER-Zeitstempeln, EXPTIME fest 0.01 s.
// Endet das Ziel auf .fits/.fit: ein Würfel in einer Datei (NAXIS3 = Anzahl, DATE-OBS/DATE-END).
// Aufruf: node scripts/make-fits-testset.mjs <aufnahme.ser> <zielordner | würfel.fits> [anzahl=30]
import { mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [serPath, outDir, countArg] = process.argv.slice(2);
if (!serPath || !outDir) {
  console.error("Aufruf: node scripts/make-fits-testset.mjs <aufnahme.ser> <zielordner> [anzahl=30]");
  process.exit(2);
}
const fd = openSync(serPath, "r");
const head = Buffer.alloc(178);
readSync(fd, head, 0, 178, 0);
const colorId = head.readInt32LE(18), W = head.readInt32LE(26), H = head.readInt32LE(30), bitDepth = head.readInt32LE(34), frames = head.readInt32LE(38);
if (colorId >= 100) throw new Error("nur grau oder Bayer");
const bytes = bitDepth > 8 ? 2 : 1, frameLen = W * H * bytes;
const n = Math.min(frames, Number(countArg) || 30);
// Zeitstempel hinter den Bildern (100-ns-Ticks seit 0001-01-01)
const stamps = statSync(serPath).size >= 178 + frames * frameLen + frames * 8 ? Buffer.alloc(frames * 8) : null;
if (stamps) readSync(fd, stamps, 0, frames * 8, 178 + frames * frameLen);
const tickMs = (i) => Number((stamps.readBigInt64LE(i * 8) - 621_355_968_000_000_000n) / 10_000n);

// Bayer-Muster nach dem Spiegeln (gerade Höhe: Zeilen des Musters getauscht)
const PAT = { 8: "RGGB", 9: "GRBG", 10: "GBRG", 11: "BGGR" }[colorId];
const filePat = PAT && H % 2 === 0 ? PAT.slice(2) + PAT.slice(0, 2) : PAT;

const card = (k, v, c) => {
  let s = k.padEnd(8);
  if (v !== undefined) s += "= " + (typeof v === "string" ? `'${v.padEnd(8)}'`.padEnd(20) : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20));
  if (c) s += " / " + c;
  return s.slice(0, 80).padEnd(80);
};

const frame = Buffer.alloc(frameLen);
/** Bild k (16 bit, BZERO 32768, unterste Zeile zuerst) an die Stelle off in out schreiben */
function putFrame(k, out, off) {
  readSync(fd, frame, 0, frameLen, 178 + k * frameLen);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const src = (H - 1 - y) * W + x; // unterste Zeile zuerst
      const v = bytes === 2 ? frame.readUInt16LE(src * 2) << (16 - bitDepth) : frame[src] * 257;
      out.writeInt16BE(v - 32768, off + (y * W + x) * 2);
    }
}

if (/\.fits?$/i.test(outDir)) {
  // Würfel: alle Bilder in einer Datei
  const cards = [card("SIMPLE", true), card("BITPIX", 16), card("NAXIS", 3), card("NAXIS1", W), card("NAXIS2", H), card("NAXIS3", n), card("BZERO", 32768), card("BSCALE", 1)];
  if (filePat) cards.push(card("BAYERPAT", filePat, "file row order"));
  // Ende = Beginn des letzten Bildes + mittlerer Abstand (Zeiten im Würfel gleichmässig verteilt)
  if (stamps && n > 1) cards.push(card("DATE-OBS", new Date(tickMs(0)).toISOString().replace("Z", ""), "UTC"), card("DATE-END", new Date(tickMs(n - 1) + (tickMs(n - 1) - tickMs(0)) / (n - 1)).toISOString().replace("Z", ""), "UTC"));
  cards.push(card("EXPTIME", 0.01, "seconds"), card("INSTRUME", "Astrotool test cube"), card("END"));
  const h = Buffer.from(cards.join(""), "latin1");
  const hl = Math.ceil(h.length / 2880) * 2880, dl = Math.ceil((W * H * 2 * n) / 2880) * 2880;
  const out = Buffer.alloc(hl + dl);
  out.fill(32, 0, hl);
  h.copy(out);
  for (let k = 0; k < n; k++) putFrame(k, out, hl + k * W * H * 2);
  mkdirSync(dirname(outDir), { recursive: true });
  writeFileSync(outDir, out);
  console.log(`FITS-Würfel: ${n} Bilder ${W} × ${H}, 16 bit, ${PAT ?? "grau"} → ${outDir}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const digits = String(n).length;
for (let k = 0; k < n; k++) {
  const cards = [card("SIMPLE", true), card("BITPIX", 16), card("NAXIS", 2), card("NAXIS1", W), card("NAXIS2", H), card("BZERO", 32768), card("BSCALE", 1)];
  if (filePat) cards.push(card("BAYERPAT", filePat, "file row order"));
  if (stamps) cards.push(card("DATE-OBS", new Date(tickMs(k)).toISOString().replace("Z", ""), "UTC"));
  cards.push(card("EXPTIME", 0.01, "seconds"), card("INSTRUME", "Astrotool test set"), card("END"));
  const h = Buffer.from(cards.join(""), "latin1");
  const hl = Math.ceil(h.length / 2880) * 2880, dl = Math.ceil((W * H * 2) / 2880) * 2880;
  const out = Buffer.alloc(hl + dl);
  out.fill(32, 0, hl);
  h.copy(out);
  putFrame(k, out, hl);
  writeFileSync(join(outDir, `frame_${String(k + 1).padStart(digits, "0")}.fits`), out);
}
console.log(`${n} FITS-Bilder ${W} × ${H}, 16 bit, ${PAT ?? "grau"}${stamps ? ", mit DATE-OBS" : ""} in ${outDir}`);
