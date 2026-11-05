// Bearbeitung der fertigen Ausschnitte vor dem Speichern: Tonwerte, Graustufen, Spiegeln, Drehen, Grösse ändern.
// Wie die Registerkarte „Processing“ bei PIPP (Schalter -input_gain, -hs, -gamma, -convmono, -flip_x, -flip_y,
// -rotate90/180/270, -resize_en/-resize_width/-resize_height) – eigenständige Implementierung.
// Reihenfolge: Verstärkung → Histogramm strecken → Gamma → Graustufen → Spiegeln → Drehen → Grösse.
// Tonwerte ändern Bayer-Rohdaten direkt (je Pixel), sie bleiben dabei roh.
import { SerColor, isBayer, type Frame } from "./ser";
import { debayer, patternFromColorId, type BayerPattern } from "./debayer";

export type Rotation = 0 | 90 | 180 | 270;

export interface TransformOptions {
  /** In Graustufen umwandeln (Farbbilder; Bayer-Rohdaten werden dafür erst farbig gemacht). */
  mono: boolean;
  /** Links ↔ rechts spiegeln */
  flipH: boolean;
  /** Oben ↔ unten spiegeln */
  flipV: boolean;
  /** Drehen im Uhrzeigersinn (Grad). Aus Formularen kann der Wert als Text kommen. */
  rotate: Rotation | `${Rotation}`;
  /** Grösse in Prozent, 100 = unverändert (10–400) – bei resizeMode "percent" */
  resizePercent: number;
  /** Grösse in Prozent oder als Breite × Höhe in Pixeln (wie PIPP) */
  resizeMode: "percent" | "size";
  /** Zielbreite/-höhe nach dem Drehen; 0 = aus der anderen Angabe mit gleichem Seitenverhältnis */
  resizeWidth: number;
  resizeHeight: number;
  /** Verstärkung (Faktor, 1 = unverändert; 0.1–10). Werte über dem Maximum werden abgeschnitten. */
  gain: number;
  /** Histogramm jedes Bildes strecken: hellste Werte auf stretchTarget % der Skala */
  stretch: boolean;
  /** Ziel für die hellsten Werte in % (10–100) */
  stretchTarget: number;
  /** Auch den Schwarzpunkt strecken (dunkelste Werte → 0) */
  stretchBlack: boolean;
  /** Jede Farbe einzeln strecken (gleicht zugleich die Farben ab) */
  stretchPerChannel: boolean;
  /** Gamma (1 = unverändert, > 1 hellt die Mitteltöne auf; 0.2–5). Für Stacking-Programme besser 1 lassen. */
  gamma: number;
}

export const defaultTransform: TransformOptions = {
  mono: false, flipH: false, flipV: false, rotate: 0, resizePercent: 100, resizeMode: "percent", resizeWidth: 0, resizeHeight: 0,
  gain: 1, stretch: false, stretchTarget: 100, stretchBlack: false, stretchPerChannel: false, gamma: 1,
};

const MIN_PERCENT = 10, MAX_PERCENT = 400;

function rotation(t: TransformOptions): Rotation {
  const r = ((Number(t.rotate) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

const MAX_SIZE = 16384;

function scaleOf(t: TransformOptions): number {
  const p = Number(t.resizePercent);
  if (!isFinite(p) || p <= 0 || p === 100) return 1;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, p)) / 100;
}

const px = (v: unknown) => {
  const n = Math.round(Number(v));
  return isFinite(n) && n > 0 ? Math.min(MAX_SIZE, n) : 0;
};

/** Zielgrösse für ein (schon gedrehtes) Bild w × h */
function resizedSize(t: TransformOptions, w: number, h: number): [number, number] {
  if (t.resizeMode === "size") {
    const tw = px(t.resizeWidth), th = px(t.resizeHeight);
    if (tw && th) return [tw, th];
    if (tw) return [tw, Math.max(1, Math.round((h * tw) / w))];
    if (th) return [Math.max(1, Math.round((w * th) / h)), th];
    return [w, h];
  }
  const s = scaleOf(t);
  return s === 1 ? [w, h] : [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Wird die Grösse geändert? (Breite × Höhe zählt, sobald eine Angabe gesetzt ist) */
function resizes(t: TransformOptions): boolean {
  return t.resizeMode === "size" ? px(t.resizeWidth) > 0 || px(t.resizeHeight) > 0 : scaleOf(t) !== 1;
}

const num = (v: unknown, def: number, lo: number, hi: number) => {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
};
const gainOf = (t: Partial<TransformOptions>) => num(t.gain ?? 1, 1, 0.1, 10);
const gammaOf = (t: Partial<TransformOptions>) => num(t.gamma ?? 1, 1, 0.2, 5);

/** Werden Tonwerte geändert? */
export function hasTone(t: Partial<TransformOptions>): boolean {
  return gainOf(t) !== 1 || gammaOf(t) !== 1 || !!t.stretch;
}

/** Ist überhaupt eine Bearbeitung eingestellt? */
export function hasTransform(t: TransformOptions): boolean {
  return t.mono || t.flipH || t.flipV || rotation(t) !== 0 || resizes(t) || hasTone(t);
}

/** Nur Spiegeln/Drehen/Tonwerte (dabei bleiben Bayer-Rohdaten erhalten, siehe transformFrame). */
function geometricOnly(t: TransformOptions): boolean {
  return !t.mono && !resizes(t);
}

/** Grösse nach der Bearbeitung. */
export function transformedSize(t: TransformOptions, w: number, h: number): [number, number] {
  const r = rotation(t);
  const [ow, oh] = r === 90 || r === 270 ? [h, w] : [w, h];
  return resizedSize(t, ow, oh);
}

/**
 * Bayer-Rohdaten können gespiegelt und gedreht werden, ohne sie farbig zu machen – bei gerader Breite und Höhe
 * ändert sich nur das Muster (z. B. RGGB links/rechts gespiegelt → GRBG). Das ist besser für AutoStakkert! & Co.
 * Gibt die neue Farbkennung zurück oder null, wenn das nicht geht.
 */
export function bayerAfterTransform(t: TransformOptions, colorId: number, w: number, h: number): number | null {
  const p = patternFromColorId(colorId);
  if (!p || !geometricOnly(t) || w % 2 || h % 2) return null;
  // ein 2×2-Bild mit den Farben bearbeiten – das ergibt genau das neue Muster
  const tile: Frame = { width: 2, height: 2, planes: 1, bitDepth: 8, colorId: SerColor.MONO, data: Uint8Array.from(p, (c) => "RGB".indexOf(c)) };
  const out = geometry(tile, t);
  const name = Array.from(out.data, (v) => "RGB"[v]).join("") as BayerPattern;
  return ({ RGGB: SerColor.BAYER_RGGB, GRBG: SerColor.BAYER_GRBG, GBRG: SerColor.BAYER_GBRG, BGGR: SerColor.BAYER_BGGR } as Record<string, number>)[name] ?? null;
}

/**
 * Bearbeitet einen fertigen Ausschnitt. `pattern` ist das Bayer-Muster, das für Rohdaten gilt (oder null).
 * Bayer-Rohdaten bleiben roh, wenn nur gespiegelt/gedreht wird und das Muster aus der Datei stammt
 * (`keepBayer`); sonst werden sie vorher farbig gemacht.
 */
export function transformFrame(f: Frame, t: TransformOptions, pattern: BayerPattern | null, keepBayer = true): Frame {
  if (!hasTransform(t)) return f;
  if (f.planes === 1 && pattern) {
    const id = keepBayer && isBayer(f.colorId) ? bayerAfterTransform(t, f.colorId, f.width, f.height) : null;
    if (id !== null) return { ...geometry(tone(f, t, pattern), t), colorId: id };
    f = debayer(f, pattern);
  }
  f = tone(f, t, null);
  if (t.mono && f.planes === 3) f = toMono(f);
  f = geometry(f, t);
  return resizes(t) ? resize(f, ...resizedSize(t, f.width, f.height)) : f;
}

/**
 * Tonwerte: Verstärkung → Histogramm strecken → Gamma, als Tabelle je Farbe. `pattern`: Bayer-Muster, wenn das Bild
 * Rohdaten enthält (dann gilt beim Strecken je Farbe die Farbe der Bayer-Zelle).
 * Strecken: Schwarz- und Weisspunkt sind die dunkelsten 0.1 % bzw. hellsten 0.01 % der Pixel – einzelne heisse
 * Pixel verschieben sie so nicht.
 */
export function tone(f: Frame, t: Partial<TransformOptions>, pattern: BayerPattern | null): Frame {
  if (!hasTone(t)) return f;
  const { width: w, planes: p, data: d } = f;
  const max = (1 << f.bitDepth) - 1;
  const gain = gainOf(t), invG = 1 / gammaOf(t);
  const perChannel = !!t.stretch && !!t.stretchPerChannel && (p === 3 || !!pattern);
  const channels = perChannel ? 3 : 1;
  const bgr = f.colorId === SerColor.BGR;
  // Farbe je Wert: bei RGB-Bildern Kanal i % 3, bei Bayer aus der Lage im Muster
  const cfa = pattern ? Array.from(pattern, (c) => "RGB".indexOf(c)) : null;
  const chan = (i: number): number => {
    if (!perChannel) return 0;
    if (p === 3) return bgr ? 2 - (i % 3) : i % 3;
    const x = i % w, y = (i / w) | 0;
    return cfa![((y & 1) << 1) | (x & 1)];
  };
  const range: [number, number][] = [];
  for (let c = 0; c < channels; c++) range.push([0, max]);
  if (t.stretch) {
    const hist = Array.from({ length: channels }, () => new Uint32Array(max + 1));
    const total = new Float64Array(channels);
    for (let i = 0; i < d.length; i++) {
      const c = chan(i);
      hist[c][Math.min(max, d[i])]++;
      total[c]++;
    }
    for (let c = 0; c < channels; c++) {
      const hs = hist[c], lowCount = total[c] * 0.001, highCount = total[c] * 0.0001;
      let lo = 0, hi = max;
      if (t.stretchBlack) for (let v = 0, s = 0; v <= max; v++) { s += hs[v]; if (s > lowCount) { lo = v; break; } }
      for (let v = max, s = 0; v >= 0; v--) { s += hs[v]; if (s > highCount) { hi = v; break; } }
      range[c] = hi > lo ? [lo, hi] : [0, max];
    }
  }
  const target = t.stretch ? num(t.stretchTarget ?? 100, 100, 10, 100) / 100 : 1;
  const luts = range.map(([lo, hi]) => {
    const lut = d instanceof Uint16Array ? new Uint16Array(max + 1) : new Uint8Array(max + 1);
    // die Streckung bezieht sich auf die verstärkten Werte
    const glo = Math.min(max, lo * gain), ghi = Math.min(max, hi * gain);
    for (let v = 0; v <= max; v++) {
      const g = Math.min(max, v * gain);
      let x = t.stretch && ghi > glo ? ((g - glo) / (ghi - glo)) * target : g / max;
      x = Math.min(1, Math.max(0, x));
      lut[v] = Math.round(Math.pow(x, invG) * max);
    }
    return lut;
  });
  const out = d instanceof Uint16Array ? new Uint16Array(d.length) : new Uint8Array(d.length);
  if (channels === 1) {
    const lut = luts[0];
    for (let i = 0; i < d.length; i++) out[i] = lut[Math.min(max, d[i])];
  } else for (let i = 0; i < d.length; i++) out[i] = luts[chan(i)][Math.min(max, d[i])];
  return { ...f, data: out };
}

/** Graustufen nach Rec. 601 (0.299 R + 0.587 G + 0.114 B) – wie die meisten Kameras und Bildprogramme. */
export function toMono(f: Frame): Frame {
  if (f.planes !== 3) return f;
  const n = f.width * f.height;
  const bgr = f.colorId === SerColor.BGR;
  const [wr, wg, wb] = [0.299, 0.587, 0.114];
  const out = f.data instanceof Uint16Array ? new Uint16Array(n) : new Uint8Array(n);
  const d = f.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = bgr ? d[j + 2] : d[j], b = bgr ? d[j] : d[j + 2];
    out[i] = Math.round(wr * r + wg * d[j + 1] + wb * b);
  }
  return { ...f, planes: 1, colorId: SerColor.MONO, data: out };
}

/** Spiegeln und Drehen (verlustfrei, nur Umsortieren). */
function geometry(f: Frame, t: TransformOptions): Frame {
  const r = rotation(t);
  if (!t.flipH && !t.flipV && r === 0) return f;
  const { width: w, height: h, planes: p, data: d } = f;
  const [ow, oh] = r === 90 || r === 270 ? [h, w] : [w, h];
  const out = d instanceof Uint16Array ? new Uint16Array(d.length) : new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    const sy = t.flipV ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const sx = t.flipH ? w - 1 - x : x;
      // (x, y) im gespiegelten Bild → Lage nach Drehung im Uhrzeigersinn
      let nx = x, ny = y;
      if (r === 90) { nx = h - 1 - y; ny = x; }
      else if (r === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else if (r === 270) { nx = y; ny = w - 1 - x; }
      const si = (sy * w + sx) * p, di = (ny * ow + nx) * p;
      for (let c = 0; c < p; c++) out[di + c] = d[si + c];
    }
  }
  return { ...f, width: ow, height: oh, data: out };
}

/**
 * Gewichte für eine Achse. Verkleinern: Flächenmittel (jedes Zielpixel mittelt genau die überdeckte Fläche –
 * kein Flimmern, Rauschen wird gemittelt). Vergrössern: bilinear.
 */
function axisWeights(src: number, dst: number): { start: Int32Array; count: Int32Array; w: Float32Array; stride: number } {
  const s = dst / src;
  if (s < 1) {
    const span = 1 / s;
    const stride = Math.ceil(span) + 1;
    const start = new Int32Array(dst), count = new Int32Array(dst), w = new Float32Array(dst * stride);
    for (let i = 0; i < dst; i++) {
      const a = i * span, b = Math.min(src, a + span);
      const i0 = Math.floor(a), i1 = Math.min(src - 1, Math.ceil(b) - 1);
      start[i] = i0;
      count[i] = i1 - i0 + 1;
      let sum = 0;
      for (let k = i0; k <= i1; k++) {
        const cover = Math.min(b, k + 1) - Math.max(a, k);
        w[i * stride + k - i0] = cover;
        sum += cover;
      }
      for (let k = 0; k < count[i]; k++) w[i * stride + k] /= sum;
    }
    return { start, count, w, stride };
  }
  const stride = 2;
  const start = new Int32Array(dst), count = new Int32Array(dst), w = new Float32Array(dst * 2);
  for (let i = 0; i < dst; i++) {
    // Pixelmitten aufeinander abbilden
    const x = Math.min(src - 1, Math.max(0, (i + 0.5) / s - 0.5));
    const x0 = Math.floor(x), x1 = Math.min(src - 1, x0 + 1), f = x - x0;
    start[i] = x0;
    count[i] = x1 > x0 ? 2 : 1;
    w[i * 2] = x1 > x0 ? 1 - f : 1;
    w[i * 2 + 1] = x1 > x0 ? f : 0;
  }
  return { start, count, w, stride };
}

/** Grösse ändern (getrennt waagrecht und senkrecht). */
export function resize(f: Frame, ow: number, oh: number): Frame {
  const { width: w, height: h, planes: p, data: d } = f;
  if (ow === w && oh === h) return f;
  const ax = axisWeights(w, ow), ay = axisWeights(h, oh);
  const tmp = new Float32Array(ow * h * p);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < p; c++) {
        let s = 0;
        for (let k = 0; k < ax.count[x]; k++) s += ax.w[x * ax.stride + k] * d[(y * w + ax.start[x] + k) * p + c];
        tmp[(y * ow + x) * p + c] = s;
      }
    }
  }
  const max = (1 << f.bitDepth) - 1;
  const out = d instanceof Uint16Array ? new Uint16Array(ow * oh * p) : new Uint8Array(ow * oh * p);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < p; c++) {
        let s = 0;
        for (let k = 0; k < ay.count[y]; k++) s += ay.w[y * ay.stride + k] * tmp[((ay.start[y] + k) * ow + x) * p + c];
        out[(y * ow + x) * p + c] = Math.min(max, Math.max(0, Math.round(s)));
      }
    }
  }
  return { ...f, width: ow, height: oh, data: out };
}

/**
 * Ausschnitt cw × ch, dessen Mitte bei (cx, cy) im Bild liegt, um angle gedreht entnommen (bilinear): Punkt v
 * relativ zur Ausschnittmitte kommt von (cx, cy) + R(angle)·v. So wird eine gemessene Drehung des Bildinhalts
 * ausgeglichen. Das Bild muss farbig oder grau sein (keine Bayer-Rohdaten).
 */
export function rotatedCrop(f: Frame, cx: number, cy: number, angle: number, cw: number, ch: number): Frame {
  const { width: w, height: h, planes: p, data: d } = f;
  const out = d instanceof Uint16Array ? new Uint16Array(cw * ch * p) : new Uint8Array(cw * ch * p);
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let y = 0; y < ch; y++) {
    const vy = y + 0.5 - ch / 2;
    for (let x = 0; x < cw; x++) {
      const vx = x + 0.5 - cw / 2;
      const sx = cx + c * vx - s * vy - 0.5, sy = cy + s * vx + c * vy - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue; // ausserhalb: schwarz
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * p, i10 = i00 + p, i01 = i00 + w * p, i11 = i01 + p;
      const o = (y * cw + x) * p;
      for (let k = 0; k < p; k++) {
        const top = d[i00 + k] + (d[i10 + k] - d[i00 + k]) * fx;
        const bot = d[i01 + k] + (d[i11 + k] - d[i01 + k]) * fx;
        out[o + k] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return { ...f, width: cw, height: ch, data: out };
}
