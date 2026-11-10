// HEIC-Foto dekodieren: Die HEVC-Kacheln (engine/heif.ts) gehen an den Video-Dekoder des Systems (WebCodecs),
// das Bild wird auf einer Zeichenfläche zusammengesetzt und nach der Angabe der Datei gedreht.
import { heifBytes, readHeif, type HeifLayout } from "./engine/heif";
import { msg } from "./i18n";

/** Kacheldaten in einem Zug lesen, wenn sie (wie üblich) dicht hintereinander liegen */
async function tileData(file: Blob, l: HeifLayout): Promise<Uint8Array[]> {
  if (l.tiles.every((t) => t.extents.length === 1)) {
    const lo = Math.min(...l.tiles.map((t) => t.extents[0][0]));
    const hi = Math.max(...l.tiles.map((t) => t.extents[0][0] + t.extents[0][1]));
    const total = l.tiles.reduce((a, t) => a + t.extents[0][1], 0);
    if (hi - lo <= total * 1.5 + 65536) {
      const all = new Uint8Array(await file.slice(lo, hi).arrayBuffer());
      return l.tiles.map((t) => all.subarray(t.extents[0][0] - lo, t.extents[0][0] - lo + t.extents[0][1]));
    }
  }
  return Promise.all(l.tiles.map((t) => heifBytes(file, t.extents)));
}

export async function decodeHeif(file: Blob): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const l = await readHeif(file);
  if (!l) throw new Error(msg("heicUnsupported"));
  if (typeof VideoDecoder === "undefined") throw new Error(msg("heicNoDecoder"));
  for (const c of l.configs) {
    const ok = await VideoDecoder.isConfigSupported({ codec: c.codec, description: c.description }).then((r) => !!r.supported, () => false);
    if (!ok) throw new Error(msg("heicNoDecoder"));
  }
  const data = await tileData(file, l);
  let canvas = new OffscreenCanvas(l.width, l.height);
  let g = canvas.getContext("2d", { willReadFrequently: true })!;
  let failed: unknown = null;
  const dec = new VideoDecoder({
    output: (f) => {
      const t = l.tiles[f.timestamp];
      if (t) g.drawImage(f, t.x, t.y);
      f.close();
    },
    error: (e) => { failed = e; },
  });
  try {
    let cur = -1;
    for (let i = 0; i < l.tiles.length && !failed; i++) {
      const t = l.tiles[i];
      if (t.config !== cur) {
        if (cur >= 0) await dec.flush();
        dec.configure({ codec: l.configs[t.config].codec, description: l.configs[t.config].description });
        cur = t.config;
      }
      // jede Kachel ist ein eigenständiges Schlüsselbild
      dec.decode(new EncodedVideoChunk({ type: "key", timestamp: i, data: data[i] }));
    }
    if (!failed) await dec.flush();
  } catch (e) {
    failed = failed ?? e;
  } finally {
    if (dec.state !== "closed") dec.close();
  }
  if (failed) throw new Error(msg("heicNoDecoder"));

  // drehen/spiegeln in der Reihenfolge der Datei
  for (const t of l.transforms) {
    const w = canvas.width, h = canvas.height;
    const turn = "rot" in t && t.rot % 2 === 1;
    const next = new OffscreenCanvas(turn ? h : w, turn ? w : h);
    const n = next.getContext("2d", { willReadFrequently: true })!;
    if ("rot" in t) {
      // rot × 90° gegen den Uhrzeigersinn
      if (t.rot === 1) n.setTransform(0, -1, 1, 0, 0, w);
      else if (t.rot === 2) n.setTransform(-1, 0, 0, -1, w, h);
      else n.setTransform(0, 1, -1, 0, h, 0);
    } else if (t.mirror === 0) n.setTransform(-1, 0, 0, 1, w, 0);
    else n.setTransform(1, 0, 0, -1, 0, h);
    n.drawImage(canvas, 0, 0);
    canvas = next;
    g = n;
  }
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, rgba: img.data };
}
