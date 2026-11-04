// Totale Sonnenfinsternis: Die Sonnenscheibe ist verdeckt, zu sehen ist der dunkle Mond in der hellen Korona.
//
// 1. Mondrand finden: Der Mond ist ein dunkles Loch, das ringsum von Korona umgeben ist. Das Loch wird bei
//    mehreren Schwellen gesucht (kurze Belichtung: nur innere Korona; lange: alles überbelichtet), ein Kreis
//    angepasst und dann an der steilsten Helligkeitszunahme nach aussen subpixelgenau verfeinert.
//    In partiellen Phasen gibt es kein solches Loch (die Sichel umschliesst den Mond nicht) → nicht gefunden.
// 2. Belichtungsreihen erkennen: aufeinanderfolgende Bilder mit verschiedener Belichtungszeit (EXIF), kurz
//    nacheinander aufgenommen. Wiederholt sich eine Belichtungszeit, beginnt die nächste Reihe.
// 3. HDR: Jede Reihe wird am Mondrand ausgerichtet und zu einem Bild zusammengeführt (linear gewichtet,
//    überbelichtete und sehr dunkle Werte zählen nicht) und logarithmisch auf 8 bit abgebildet. So sind innere
//    Korona, Protuberanzen und äussere Korona in einem Bild sichtbar – und der Zeitraffer flackert nicht.
import { downsample, type Lum } from "./image";
import { fitCircle, percentile, sample, type DiscFit } from "./limb";
import type { Frame } from "./ser";

export interface MoonOptions {
  /** Arbeitsauflösung für die Grobsuche (längere Seite) */
  workSize?: number;
  /** Mindestanteil des Mondrands mit Korona-Kante, damit das Bild als Totalität gilt */
  minVisible?: number;
}

interface Hole {
  count: number;
  xs: number[];
  ys: number[];
  x0: number; y0: number; x1: number; y1: number;
}

/** Grösstes dunkles Gebiet (≤ thr), das den Bildrand nicht berührt – also ringsum von Hellem umschlossen ist. */
function largestHole(s: Lum, thr: number): Hole | null {
  const { width: w, height: h, data } = s;
  const label = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: Hole | null = null;
  for (let i = 0; i < w * h; i++) {
    if (data[i] > thr || label[i]) continue;
    let sp = 0, count = 0, border = false;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    const xs: number[] = [], ys: number[] = [];
    stack[sp++] = i;
    label[i] = 1;
    while (sp) {
      const p = stack[--sp];
      count++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      let edge = false;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (data[q] > thr) edge = true;
        else if (!label[q]) {
          label[q] = 1;
          stack[sp++] = q;
        }
      }
      if (edge && !border) { xs.push(x + 0.5); ys.push(y + 0.5); }
    }
    if (!border && count > (best?.count ?? 0)) best = { count, xs, ys, x0, y0, x1, y1 };
  }
  return best;
}

/** Kreis nach kleinsten Quadraten, Ausreisser (Blendung beim Diamantring, Rauschen) schrittweise entfernt. */
function robustCircle(xs: number[], ys: number[]) {
  let px = xs, py = ys;
  let c = fitCircle(px, py);
  for (let it = 0; it < 4 && c; it++) {
    const res = px.map((x, i) => Math.hypot(x - c!.cx, py[i] - c!.cy) - c!.r);
    const mad = [...res.map(Math.abs)].sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(1, 2.5 * 1.4826 * mad);
    const keep = res.map((r) => Math.abs(r) <= lim);
    const nx = px.filter((_, i) => keep[i]), ny = py.filter((_, i) => keep[i]);
    if (nx.length < 12 || nx.length === px.length) break;
    px = nx; py = ny;
    c = fitCircle(px, py);
  }
  return c;
}

const notFound = (thr: number): DiscFit => ({ found: false, cx: 0, cy: 0, r: 0, visibleLimb: 0, rms: 0, threshold: thr, x0: 0, y0: 0, x1: 0, y1: 0 });

/**
 * Rand einer dunklen Scheibe (Mond) subpixelgenau: Strahlen vom Mittelpunkt, steilster Anstieg nach aussen,
 * innen dunkel, aussen hell. rayOk schränkt ein, welche Randstellen zählen (partielle Phase: nur vor der Sonne).
 */
function refineDarkLimb(l: Lum, cx: number, cy: number, r: number, dark: number, rayOk?: (x: number, y: number) => boolean, minCand = 24) {
  let visible = 0, rms = 0, found = false;
  const step = 0.5, rays = 720;
  for (const winFactor of [0.12, 0.05, 0.025]) {
    const win = Math.max(5, winFactor * r);
    const cand: { x: number; y: number; g: number }[] = [];
    const prof: number[] = [];
    for (let k = 0; k < rays; k++) {
      const ang = (2 * Math.PI * k) / rays, ca = Math.cos(ang), sa = Math.sin(ang);
      prof.length = 0;
      let ok = true;
      for (let t = r - win; t <= r + win; t += step) {
        const v = sample(l, cx + ca * t, cy + sa * t);
        if (v < 0) { ok = false; break; }
        prof.push(v);
      }
      if (!ok || prof.length < 8) continue;
      let best = -1, bestG = 0;
      for (let i = 1; i < prof.length - 2; i++) {
        const g = (prof[i + 2] - prof[i - 1]) / 3;
        if (g > bestG) { bestG = g; best = i; }
      }
      if (best < 2 || best > prof.length - 4) continue;
      const gm = (prof[best + 1] - prof[best - 2]) / 3, gp = (prof[best + 3] - prof[best]) / 3;
      const den = gm - 2 * bestG + gp;
      const sub = den < 0 ? (0.5 * (gm - gp)) / den : 0;
      const t = r - win + (best + 0.5 + Math.max(-0.5, Math.min(0.5, sub))) * step;
      // innen dunkel (Mond), aussen hell – mit Abstand, denn der Rand ist durch Seeing und Optik weich
      const di = Math.max(4, 0.08 * r), da = Math.max(3, 0.03 * r);
      const inner = sample(l, cx + ca * (t - di), cy + sa * (t - di));
      const outer = sample(l, cx + ca * (t + da), cy + sa * (t + da));
      if (inner < 0 || inner > dark || outer < dark) continue;
      if (rayOk && !rayOk(cx + ca * (t + da), cy + sa * (t + da))) continue;
      cand.push({ x: cx + ca * t, y: cy + sa * t, g: bestG });
    }
    if (cand.length < minCand) break;
    const gSorted = cand.map((c) => c.g).sort((a, b) => a - b);
    const gRef = gSorted[Math.floor(gSorted.length * 0.9)];
    const strong = cand.filter((c) => c.g >= 0.2 * gRef);
    const res = strong.map((c) => Math.hypot(c.x - cx, c.y - cy) - r);
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    const mad = [...res.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(1, 3 * 1.4826 * mad);
    const keep = strong.filter((_, i) => Math.abs(res[i] - med) <= lim);
    const c = fitCircle(keep.map((p) => p.x), keep.map((p) => p.y));
    if (!c) break;
    ({ cx, cy, r } = c);
    found = true;
    visible = keep.length / rays;
    rms = Math.sqrt(keep.reduce((acc, p) => acc + (Math.hypot(p.x - cx, p.y - cy) - r) ** 2, 0) / keep.length);
  }
  return { cx, cy, r, visible, rms, found };
}

/**
 * Mondrand in einer partiellen Phase: die innere, hohle Kante der Sichel (Mond vor der Sonne).
 * Liefert die Mondmitte oder null (zu wenig Mondrand vor der Sonne, z. B. ganz am Anfang der Finsternis).
 * Zusammen mit der Sonnenmitte desselben Bildes ergibt das den Abstand Sonne–Mond, unabhängig vom Nachführfehler.
 */
export function fitMoonInPartial(l: Lum, sun: { cx: number; cy: number; r: number }, thr: number, opts: { workSize?: number } = {}): { cx: number; cy: number; r: number; rms: number; arc: number } | null {
  const f = Math.max(1, Math.ceil(Math.max(l.width, l.height) / (opts.workSize ?? 900)));
  const s = downsample(l, f);
  const { width: w, height: h, data } = s;
  const scx = (sun.cx + 0.5) / f, scy = (sun.cy + 0.5) / f, sr = sun.r / f;
  // dunkle Randpunkte innerhalb der Sonnenscheibe = Mondrand
  const xs: number[] = [], ys: number[] = [];
  const x0 = Math.max(1, Math.floor(scx - sr)), x1 = Math.min(w - 2, Math.ceil(scx + sr));
  const y0 = Math.max(1, Math.floor(scy - sr)), y1 = Math.min(h - 2, Math.ceil(scy + sr));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (data[i] > thr) continue;
      if (Math.hypot(x + 0.5 - scx, y + 0.5 - scy) > 0.94 * sr) continue;
      if (data[i - 1] > thr || data[i + 1] > thr || data[i - w] > thr || data[i + w] > thr) { xs.push(x + 0.5); ys.push(y + 0.5); }
    }
  if (xs.length < 20) return null;
  const c = robustCircle(xs, ys);
  if (!c || c.r < 0.85 * sr || c.r > 1.25 * sr) return null;
  const inSun = (x: number, y: number) => Math.hypot(x - sun.cx, y - sun.cy) < 0.96 * sun.r;
  const fine = refineDarkLimb(l, c.cx * f - 0.5, c.cy * f - 0.5, c.r * f, thr, inSun, 20);
  if (!fine.found || fine.r < 0.85 * sun.r || fine.r > 1.25 * sun.r || fine.rms > Math.max(1.5, 0.01 * sun.r)) return null;
  return { cx: fine.cx, cy: fine.cy, r: fine.r, rms: fine.rms, arc: fine.visible };
}

/** Mondscheibe in der Totalität (dunkle Scheibe in heller Korona). */
export function fitMoonDisc(l: Lum, opts: MoonOptions = {}): DiscFit {
  const f = Math.max(1, Math.ceil(Math.max(l.width, l.height) / (opts.workSize ?? 900)));
  const s = downsample(l, f);
  const bg = percentile(s.data, 0.05);
  // Sehr hoch ansetzen: Bei Perlschnur und Chromosphäre ist nur ein dünner Ring hell (< 0.1 % der Fläche).
  const peak = percentile(s.data, 0.9995);
  if (peak - bg < 0.02) return notFound(0);

  // Grobsuche: bei welcher Schwelle ergibt sich ein rundes, geschlossenes Loch?
  let start: { cx: number; cy: number; r: number; thr: number; hole: Hole } | null = null;
  for (const q of [0.5, 0.25, 0.12, 0.06, 0.03]) {
    const thr = bg + q * (peak - bg);
    const hole = largestHole(s, thr);
    if (!hole || hole.count < 40) continue;
    const bw = hole.x1 - hole.x0 + 1, bh = hole.y1 - hole.y0 + 1;
    if (bw / bh < 0.75 || bw / bh > 1.33) continue;
    if (hole.count / ((Math.PI * bw * bh) / 4) < 0.75) continue; // nicht rund
    const c = robustCircle(hole.xs, hole.ys);
    if (!c || c.r < 4) continue;
    // Bei tieferer Schwelle liegt das Loch enger am Mond. Weiter suchen, solange es rund bleibt und nicht
    // kleiner wird – sonst zählt schon das Mondinnere (vom Himmel aufgehellt) oder Rauschen als hell.
    if (start && c.r < 0.97 * start.r) break;
    start = { ...c, thr, hole };
  }
  if (!start) return notFound(bg + 0.25 * (peak - bg));

  // Fein: Strahlen im Originalbild, steilster Anstieg vom Mond nach aussen
  const fine = refineDarkLimb(l, start.cx * f - 0.5, start.cy * f - 0.5, start.r * f, start.thr);
  const dark = start.thr;
  const { cx, cy, r, visible, rms, found } = fine;
  if (!found || visible < (opts.minVisible ?? 0.5)) return notFound(dark);
  const h = start.hole;
  return {
    found: true, cx, cy, r, visibleLimb: visible, rms, threshold: dark,
    x0: h.x0 * f, y0: h.y0 * f, x1: (h.x1 + 1) * f - 1, y1: (h.y1 + 1) * f - 1,
  };
}

// ---------- Belichtungsreihen ----------

export interface BracketItem {
  index: number;
  /** Aufnahmezeit in ms (null = unbekannt) */
  timeMs: number | null;
  /** Relative Belichtung (Zeit × ISO / Blende²), undefined = unbekannt */
  exposure: number | undefined;
  /** Bild aus der Totalität (am Mondrand ausgerichtet) */
  totality: boolean;
}

/**
 * Teilt Totalitäts-Bilder (in Aufnahme-Reihenfolge) in Belichtungsreihen. Eine Reihe endet, wenn eine
 * Belichtung schon vorkam, die Pause zu lang ist oder ein Bild nicht aus der Totalität stammt.
 * Liefert nur Reihen mit mindestens zwei Bildern.
 */
export function bracketGroups(items: BracketItem[], maxGapSeconds = 3): number[][] {
  const groups: number[][] = [];
  let cur: BracketItem[] = [];
  const flush = () => {
    if (cur.length >= 2) groups.push(cur.map((c) => c.index));
    cur = [];
  };
  for (const it of items) {
    if (!it.totality || it.exposure === undefined || !(it.exposure > 0) || it.timeMs === null) {
      flush();
      continue;
    }
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = (it.timeMs - prev.timeMs!) / 1000;
      // EXIF-Zeiten sind oft nur auf die Sekunde genau → 1 s Spielraum zusätzlich
      const tooLate = gap < -1 || gap > prev.exposure! + maxGapSeconds + 1;
      const repeat = cur.some((c) => Math.abs(c.exposure! / it.exposure! - 1) < 0.03);
      if (tooLate || repeat) flush();
    }
    cur.push(it);
  }
  flush();
  return groups;
}

// ---------- HDR ----------

export interface BracketFrame {
  /** Zugeschnittenes Bild, nicht Bayer (bei Bayer vorher farbig machen) */
  frame: Frame;
  /** Relative Belichtung */
  exposure: number;
  /** Subpixel-Versatz: Ausgabepixel (x, y) liegt in diesem Bild bei (x + dx, y + dy) */
  dx: number;
  dy: number;
}

export interface HdrOptions {
  /** Daten sind sRGB-kodiert (JPEG/PNG aus der Kamera) statt linear (SER-Rohdaten) */
  srgb: boolean;
  /** Dynamik, die die Abbildung zusammendrückt (Verhältnis hellste : schwächste sichtbare Korona) */
  compression?: number;
  /**
   * Lage des Mondes im Ausgabebild. Das Himmelslicht (Streulicht der Atmosphäre) liegt vor Mond und Korona
   * gleichermassen; die Helligkeit im Mondinneren ist also genau dieser Schleier und wird je Farbe abgezogen.
   */
  moon?: { cx: number; cy: number; r: number };
}

const SAT = 0.97;

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Gewicht eines Messwerts (0..1, kodiert): dunkel = verrauscht, fast weiss = überbelichtet. */
function weight(m: number): number {
  if (m >= SAT) return 0;
  return Math.min(1, m / 0.08) * Math.min(1, (SAT - m) / 0.12) + 1e-4;
}

/** Wert mit bilinearer Interpolation, am Rand festgehalten. */
function sampleClamped(d: ArrayLike<number>, w: number, h: number, p: number, c: number, x: number, y: number): number {
  x = Math.max(0, Math.min(w - 1, x));
  y = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y));
  const fx = x - x0, fy = y - y0;
  const i = (y0 * w + x0) * p + c, row = w * p;
  return (d[i] * (1 - fx) + d[i + p] * fx) * (1 - fy) + (d[i + row] * (1 - fx) + d[i + row + p] * fx) * fy;
}

/** Führt eine Belichtungsreihe zu einem Bild zusammen (gleiche Grösse, Farbe und Bittiefe wie die Eingabe). */
export function mergeHdr(items: BracketFrame[], o: HdrOptions): Frame {
  if (!items.length) throw new Error("empty bracket");
  const ref = items[0].frame;
  const { width: w, height: h, planes: p, bitDepth } = ref;
  const maxV = (1 << bitDepth) - 1;
  const n = w * h;
  const lut = new Float32Array(maxV + 1);
  for (let v = 0; v <= maxV; v++) lut[v] = o.srgb ? srgbToLinear(v / maxV) : v / maxV;
  const byExp = items.map((_, i) => i).sort((a, b) => items[a].exposure - items[b].exposure);
  const shortest = byExp[0], longest = byExp[byExp.length - 1];
  const integer = items.every((it) => Math.abs(it.dx) < 1e-6 && Math.abs(it.dy) < 1e-6);

  const rad = new Float32Array(n * p);
  const enc = new Float32Array(p);
  const sumC = new Float64Array(p);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = y * w + x;
      let sumW = 0;
      sumC.fill(0);
      let allSat = true;
      const fallback = (k: number) => {
        const it = items[k];
        for (let c = 0; c < p; c++) {
          const v = integer ? it.frame.data[px * p + c] : sampleClamped(it.frame.data, w, h, p, c, x + it.dx, y + it.dy);
          rad[px * p + c] = lut[Math.round(v)] / it.exposure;
        }
      };
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        let m = 0;
        for (let c = 0; c < p; c++) {
          const v = integer ? it.frame.data[px * p + c] : sampleClamped(it.frame.data, w, h, p, c, x + it.dx, y + it.dy);
          enc[c] = v;
          if (v > m) m = v;
        }
        m /= maxV;
        if (m < SAT) allSat = false;
        const wt = weight(m);
        if (wt <= 1e-4) continue;
        sumW += wt;
        for (let c = 0; c < p; c++) sumC[c] += (wt * lut[Math.round(enc[c])]) / it.exposure;
      }
      if (sumW > 0) for (let c = 0; c < p; c++) rad[px * p + c] = sumC[c] / sumW;
      else fallback(allSat ? shortest : longest);
    }
  const noise = o.moon ? subtractSky(rad, w, h, p, o.moon) : 0;
  return toneMap(rad, ref, o.compression ?? 2000, noise);
}

/** Himmelslicht an einer Stelle (je Farbe), aus {@link fitSkyModel}. */
export type SkyModel = (x: number, y: number, c: number) => number;

/** Lineares Gleichungssystem (symmetrisch, positiv definit) mit Gauss-Elimination lösen; null bei Entartung. */
function solve(A: Float64Array, b: Float64Array, m: number): Float64Array | null {
  const M = Float64Array.from(A), x = Float64Array.from(b);
  for (let k = 0; k < m; k++) {
    let piv = k;
    for (let i = k + 1; i < m; i++) if (Math.abs(M[i * m + k]) > Math.abs(M[piv * m + k])) piv = i;
    if (Math.abs(M[piv * m + k]) < 1e-300) return null;
    if (piv !== k) {
      for (let j = 0; j < m; j++) [M[k * m + j], M[piv * m + j]] = [M[piv * m + j], M[k * m + j]];
      [x[k], x[piv]] = [x[piv], x[k]];
    }
    for (let i = k + 1; i < m; i++) {
      const f = M[i * m + k] / M[k * m + k];
      if (!f) continue;
      for (let j = k; j < m; j++) M[i * m + j] -= f * M[k * m + j];
      x[i] -= f * x[k];
    }
  }
  for (let k = m - 1; k >= 0; k--) {
    let s = x[k];
    for (let j = k + 1; j < m; j++) s -= M[k * m + j] * x[j];
    x[k] = s / M[k * m + k];
  }
  return x;
}

/**
 * Himmelslicht mit Verlauf schätzen. Das Streulicht der Atmosphäre liegt vor Mond und Korona gleichermassen; hinter
 * dem Mond gibt es keine Korona, dort ist also nur Himmel zu sehen. Aus dem Mondinneren (75 % des Radius, weg vom
 * Rand mit Protuberanzen und Blendlicht) wird je Farbe eine Ebene a + b·u + c·v bestimmt (robust gegen Ausreisser)
 * und über das ganze Bild fortgesetzt – ein heller Himmel kurz nach dem 2. Kontakt oder nahe dem Horizont nimmt
 * über einige Grad recht gleichmässig zu. Ein Anstieg zählt nur, wenn er deutlich über dem Rauschen liegt (bei
 * kleinem Mond im grossen Bild wird ein unsicherer Anstieg sonst weit hochgerechnet).
 * Der Aussenbereich hilft nicht: dort überdecken Korona-Strahlen jeden Verlauf. Ohne genug Mondfläche: null.
 */
export function fitSkyModel(rad: Float32Array, w: number, h: number, p: number, moon: { cx: number; cy: number; r: number }): SkyModel | null {
  const rr = 0.75 * moon.r, S = moon.r;
  const step = Math.max(1, Math.floor(rr / 60));
  const us: number[] = [], vs: number[] = [], idx: number[] = [];
  for (let y = Math.max(0, Math.ceil(moon.cy - rr)); y <= Math.min(h - 1, moon.cy + rr); y += step)
    for (let x = Math.max(0, Math.ceil(moon.cx - rr)); x <= Math.min(w - 1, moon.cx + rr); x += step) {
      if (Math.hypot(x - moon.cx, y - moon.cy) > rr) continue;
      us.push((x - moon.cx) / S); vs.push((y - moon.cy) / S); idx.push(y * w + x);
    }
  const n = us.length;
  if (n < 20) return null;
  const coef: number[][] = [];
  for (let c = 0; c < p; c++) {
    const val = idx.map((i) => rad[i * p + c]);
    const wt = new Float64Array(n).fill(1);
    let k = [0, 0, 0], sigma = 0, suu = 0, svv = 0;
    for (let it = 0; it < 6; it++) {
      const A = new Float64Array(9), b = new Float64Array(3);
      for (let j = 0; j < n; j++) {
        const row = [1, us[j], vs[j]], wj = wt[j];
        for (let a = 0; a < 3; a++) {
          b[a] += wj * row[a] * val[j];
          for (let q = 0; q < 3; q++) A[a * 3 + q] += wj * row[a] * row[q];
        }
      }
      const x = solve(A, b, 3);
      if (!x) return null;
      k = Array.from(x);
      const res = val.map((v, j) => v - (k[0] + k[1] * us[j] + k[2] * vs[j]));
      const abs = res.map(Math.abs).sort((a, b) => a - b);
      sigma = Math.max(1e-12, 1.4826 * abs[n >> 1]);
      for (let j = 0; j < n; j++) wt[j] = 1 / (1 + (res[j] / (3 * sigma)) ** 2);
      suu = A[4]; svv = A[8];
    }
    // Anstieg nur, wenn er mehr als dreimal so gross ist wie seine Unsicherheit
    if (Math.abs(k[1]) < 3 * sigma / Math.sqrt(Math.max(1e-12, suu))) k[1] = 0;
    if (Math.abs(k[2]) < 3 * sigma / Math.sqrt(Math.max(1e-12, svv))) k[2] = 0;
    coef.push(k);
  }
  return (x, y, c) => {
    const k = coef[c];
    return k[0] + k[1] * ((x - moon.cx) / S) + k[2] * ((y - moon.cy) / S);
  };
}

/**
 * Himmelsschleier je Farbe abziehen (Modell mit Verlauf, siehe {@link fitSkyModel}). Danach dürfen höchstens 2 %
 * des Bildes unter null fallen – sonst würde ein zu hoch geschätzter Himmel dunkle Bildteile schwarz machen.
 * Ergebnis: Rauschen der Helligkeit im Mondinneren nach dem Abzug (0, wenn nichts abgezogen wurde).
 */
function subtractSky(rad: Float32Array, w: number, h: number, p: number, moon: { cx: number; cy: number; r: number }): number {
  const sky = fitSkyModel(rad, w, h, p, moon);
  if (!sky) return 0;
  const n = w * h;
  const st = Math.max(1, Math.floor(n / 100000));
  for (let c = 0; c < p; c++) {
    const sk = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sk[y * w + x] = Math.max(0, sky(x, y, c));
    const smp: number[] = [];
    for (let i = 0; i < n; i += st) smp.push(rad[i * p + c] - sk[i]);
    smp.sort((a, b) => a - b);
    const lift = Math.max(0, -smp[Math.floor(smp.length * 0.02)]);
    for (let i = 0; i < n; i++) rad[i * p + c] = Math.max(0, rad[i * p + c] - Math.max(0, sk[i] - lift));
  }
  // Rauschen (robust) der mittleren Helligkeit im Mondinneren
  const rr = 0.75 * moon.r, step = Math.max(1, Math.floor(rr / 60)), Y: number[] = [];
  for (let y = Math.max(0, Math.ceil(moon.cy - rr)); y <= Math.min(h - 1, moon.cy + rr); y += step)
    for (let x = Math.max(0, Math.ceil(moon.cx - rr)); x <= Math.min(w - 1, moon.cx + rr); x += step) {
      if (Math.hypot(x - moon.cx, y - moon.cy) > rr) continue;
      let s = 0;
      for (let c = 0; c < p; c++) s += rad[(y * w + x) * p + c];
      Y.push(s / p);
    }
  Y.sort((a, b) => a - b);
  const med = Y[Y.length >> 1];
  const dev = Y.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * dev[dev.length >> 1];
}

/**
 * Logarithmische Abbildung der Leuchtdichte auf den Ausgabebereich; Farbe bleibt erhalten. Der Knick der Kurve
 * liegt mindestens beim Doppelten des Rauschens – sonst wird nach dem Abzug eines hellen Himmels das Rauschen im
 * dunklen Mond zu grobem Korn verstärkt.
 */
function toneMap(rad: Float32Array, ref: Frame, compression: number, noise = 0): Frame {
  const { width: w, height: h, planes: p, bitDepth } = ref;
  const maxV = (1 << bitDepth) - 1;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < p; c++) s += rad[i * p + c];
    Y[i] = s / p;
  }
  // Schwarz- und Weisspunkt aus einer Stichprobe
  const stepS = Math.max(1, Math.floor(n / 200000));
  const smp: number[] = [];
  for (let i = 0; i < n; i += stepS) smp.push(Y[i]);
  smp.sort((a, b) => a - b);
  const lo = smp[Math.floor(smp.length * 0.02)];
  const hi = smp[Math.min(smp.length - 1, Math.floor(smp.length * 0.9995))];
  const span = Math.max(1e-12, hi - lo);
  const s = Math.max(span / compression, 2 * noise);
  const norm = 1 / Math.log1p(span / s);
  const data = bitDepth > 8 ? new Uint16Array(n * p) : new Uint8Array(n * p);
  for (let i = 0; i < n; i++) {
    const y = Y[i];
    const m = Math.min(1, Math.log1p(Math.max(0, y - lo) / s) * norm);
    const k = y > 0 ? m / y : 0;
    for (let c = 0; c < p; c++) data[i * p + c] = Math.round(Math.min(1, rad[i * p + c] * k) * maxV);
  }
  return { ...ref, data };
}
