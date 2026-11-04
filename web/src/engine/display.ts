// Anzeige-Bearbeitung für den Betrachter (SER Player): Debayer, Gain, Gamma, Farbbalance, Sättigung, Histogramm.
// Ändert nur die Darstellung; gespeichert wird roh oder – auf Wunsch – mit genau diesen Einstellungen.
import { debayer, patternFromColorId, type BayerPattern } from "./debayer";
import { maxValueFor } from "./image";
import type { Frame } from "./ser";

export interface DisplayOptions {
  /** "auto" = laut Datei-Header, "off" = Rohdaten grau, sonst festes Muster */
  debayer: "auto" | "off" | BayerPattern;
  /** Verstärkung (1 = unverändert) */
  gain: number;
  /** Gamma (1 = linear, < 1 hellt Schatten auf) */
  gamma: number;
  /** Farbbalance: Faktoren je Kanal; null = automatisch (Grauwelt) */
  balance: [number, number, number] | null;
  /** Sättigung (1 = unverändert, 0 = grau) */
  saturation: number;
}

export const defaultDisplay: DisplayOptions = { debayer: "auto", gain: 1, gamma: 1, balance: [1, 1, 1], saturation: 1 };

export interface Rendered {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Histogramme nach der Bearbeitung, je 256 Klassen: R, G, B, Helligkeit */
  histogram: [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
  /** verwendete Farbbalance (bei "automatisch" die berechnete) */
  balance: [number, number, number];
  colour: boolean;
}

/** Frame ggf. debayern – auch für das Speichern "mit Bearbeitung". */
export function toColour(f: Frame, mode: DisplayOptions["debayer"]): Frame {
  if (f.planes !== 1 || mode === "off") return f;
  const pattern = mode === "auto" ? patternFromColorId(f.colorId) : mode;
  return pattern ? debayer(f, pattern) : f;
}

/** Grauwelt-Annahme: im Mittel sind helle Bildteile neutral. Grün bleibt 1. */
export function autoBalance(f: Frame): [number, number, number] {
  if (f.planes !== 3) return [1, 1, 1];
  const d = f.data, n = f.width * f.height;
  const lim = maxValueFor(f.bitDepth) * 0.98;
  const step = Math.max(1, Math.floor(n / 200_000));
  // Nur das helle Objekt zählt – dunkler Himmel besteht aus Rauschen und Restlicht und verfälscht die Farbe.
  let peak = 0;
  for (let i = 0; i < n; i += step) {
    const j = i * 3;
    const s = d[j] + d[j + 1] + d[j + 2];
    if (s > peak) peak = s;
  }
  const floor = peak * 0.25;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i += step) {
    const j = i * 3;
    const rr = d[f.colorId === 101 ? j + 2 : j], gg = d[j + 1], bb = d[f.colorId === 101 ? j : j + 2];
    if (rr + gg + bb < floor) continue;
    if (rr >= lim || gg >= lim || bb >= lim) continue; // gesättigte Pixel verfälschen die Farbe
    r += rr; g += gg; b += bb;
  }
  if (!r || !g || !b) return [1, 1, 1];
  const clamp = (v: number) => Math.min(4, Math.max(0.25, v));
  return [clamp(g / r), 1, clamp(g / b)];
}

export function renderDisplay(raw: Frame, o: DisplayOptions): Rendered {
  const f = toColour(raw, o.debayer);
  const n = f.width * f.height;
  const colour = f.planes === 3;
  const bal = colour ? (o.balance ?? autoBalance(f)) : [1, 1, 1] as [number, number, number];
  // Tabelle: Rohwert → 0..255 mit Gain und Gamma (schnell auch für 16 bit)
  const maxIn = maxValueFor(f.bitDepth);
  const lut = new Uint8ClampedArray(maxIn + 1);
  const invG = 1 / Math.max(0.05, o.gamma);
  for (let v = 0; v <= maxIn; v++) lut[v] = 255 * Math.pow(Math.min(1, (v / maxIn) * o.gain), invG);
  const rgba = new Uint8ClampedArray(n * 4);
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
  const d = f.data;
  const bgr = f.colorId === 101;
  const sat = o.saturation;
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number;
    if (colour) {
      const j = i * 3;
      r = lut[Math.min(maxIn, Math.round(d[bgr ? j + 2 : j] * bal[0]))];
      g = lut[Math.min(maxIn, Math.round(d[j + 1] * bal[1]))];
      b = lut[Math.min(maxIn, Math.round(d[bgr ? j : j + 2] * bal[2]))];
      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
        r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    } else {
      r = g = b = lut[d[i]];
    }
    const o4 = i * 4;
    rgba[o4] = r; rgba[o4 + 1] = g; rgba[o4 + 2] = b; rgba[o4 + 3] = 255;
    hr[r | 0]++; hg[g | 0]++; hb[b | 0]++; hl[Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b))]++;
  }
  return { width: f.width, height: f.height, rgba, histogram: [hr, hg, hb, hl], balance: bal as [number, number, number], colour };
}

/** Frame mit Bearbeitung als 8-bit-RGB-Frame (zum Speichern "wie angezeigt"). */
export function processedFrame(raw: Frame, o: DisplayOptions): Frame {
  const r = renderDisplay(raw, o);
  const n = r.width * r.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = r.rgba[i * 4]; out[i * 3 + 1] = r.rgba[i * 4 + 1]; out[i * 3 + 2] = r.rgba[i * 4 + 2]; }
  return { width: r.width, height: r.height, planes: 3, bitDepth: 8, colorId: 100, data: out };
}
