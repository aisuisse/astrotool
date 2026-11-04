// Debayer: aus Rohdaten einer Farbkamera (ein Wert pro Pixel, Farbfilter-Mosaik) ein RGB-Bild machen.
// Bilineare Interpolation – schnell und für Vorschau, Zeitraffer und Stacking-Vorbereitung gut genug.
// Eigenständige Implementierung.
import { SerColor, type Frame } from "./ser";

/** Bayer-Muster als Farbe (0 = R, 1 = G, 2 = B) für die vier Positionen [y%2][x%2]. */
export type BayerPattern = "RGGB" | "GRBG" | "GBRG" | "BGGR";

const LAYOUT: Record<BayerPattern, number[][]> = {
  RGGB: [[0, 1], [1, 2]],
  GRBG: [[1, 0], [2, 1]],
  GBRG: [[1, 2], [0, 1]],
  BGGR: [[2, 1], [1, 0]],
};

export function patternFromColorId(id: number): BayerPattern | null {
  return ({ [SerColor.BAYER_RGGB]: "RGGB", [SerColor.BAYER_GRBG]: "GRBG", [SerColor.BAYER_GBRG]: "GBRG", [SerColor.BAYER_BGGR]: "BGGR" } as Record<number, BayerPattern>)[id] ?? null;
}

/**
 * Bilineares Debayer. Ergebnis hat dieselbe Bittiefe, 3 Kanäle (RGB, interleaved).
 * An jedem Pixel wird die fehlende Farbe aus den nächsten Nachbarn gleicher Farbe gemittelt.
 */
export function debayer(f: Frame, pattern: BayerPattern): Frame {
  const { width: w, height: h, data } = f;
  const lay = LAYOUT[pattern];
  const out = data instanceof Uint16Array ? new Uint16Array(w * h * 3) : new Uint8Array(w * h * 3);
  const at = (x: number, y: number) => {
    // Rand spiegeln (gleiche Farbe liegt 2 Pixel weiter)
    if (x < 0) x = -x; else if (x >= w) x = 2 * w - 2 - x;
    if (y < 0) y = -y; else if (y >= h) y = 2 * h - 2 - y;
    return data[y * w + x];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = lay[y & 1][x & 1];
      const o = (y * w + x) * 3;
      const v = data[y * w + x];
      const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
      const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
      const horiz = (at(x - 1, y) + at(x + 1, y)) / 2;
      const vert = (at(x, y - 1) + at(x, y + 1)) / 2;
      if (c === 1) {
        // Grün-Pixel: R und B liegen waagrecht bzw. senkrecht daneben – je nach Zeile
        const rowColour = lay[y & 1][(x + 1) & 1]; // Farbe des waagrechten Nachbarn
        out[o + 1] = v;
        if (rowColour === 0) { out[o] = horiz; out[o + 2] = vert; }
        else { out[o + 2] = horiz; out[o] = vert; }
      } else {
        out[o + c] = v;
        out[o + 1] = cross;
        out[o + (c === 0 ? 2 : 0)] = diag;
      }
    }
  }
  return { width: w, height: h, planes: 3, bitDepth: f.bitDepth, colorId: SerColor.RGB, data: out };
}
