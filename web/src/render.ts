// Frame → RGBA für die Anzeige (nur Darstellung, automatische Helligkeitsstreckung).
import type { Frame } from "./engine/ser";
import { SerColor } from "./engine/ser";

export function frameToRGBA(f: Frame): Uint8ClampedArray {
  const n = f.width * f.height;
  const out = new Uint8ClampedArray(n * 4);
  const d = f.data;
  let max = 1;
  for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
  const s = 255 / max;
  const bgr = f.colorId === SerColor.BGR;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (f.planes === 3) {
      const j = i * 3;
      out[o] = d[bgr ? j + 2 : j] * s;
      out[o + 1] = d[j + 1] * s;
      out[o + 2] = d[bgr ? j : j + 2] * s;
    } else {
      out[o] = out[o + 1] = out[o + 2] = d[i] * s;
    }
    out[o + 3] = 255;
  }
  return out;
}
