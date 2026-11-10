// Finsternis-Film: Schärfe am Sonnenrand, zeittreue Zeitachse mit Zwischenbildern.
// Eigenständige Implementierung.
import { fitCircle, sample } from "./limb";
import type { Lum } from "./image";
import type { FrameResult } from "./pipeline";

/**
 * Breite des Sonnenrands in Pixel (Anstieg von 20 % auf 80 % zwischen Himmel und Scheibe), gemessen auf Strahlen
 * vom Mittelpunkt. Verwackeln oder Unschärfe machen den Rand breit. Vom Mond verdeckte Stellen zählen nicht.
 * Ergebnis: 75 %-Wert über die Strahlen (Verwackeln wirkt nur in einer Richtung) – oder null, wenn zu wenig Rand
 * sichtbar ist.
 */
export function limbWidth(l: Lum, disc: { cx: number; cy: number; r: number }, moon?: { cx: number; cy: number; r: number }): number | null {
  const L = Math.max(6, 0.05 * disc.r);
  const step = 0.5;
  const n = Math.round((2 * L) / step) + 1;
  const prof = new Float32Array(n);
  const widths: number[] = [];
  const RAYS = 120;
  for (let k = 0; k < RAYS; k++) {
    const a = (2 * Math.PI * k) / RAYS, c = Math.cos(a), s = Math.sin(a);
    const ex = disc.cx + c * disc.r, ey = disc.cy + s * disc.r;
    // Stelle vom Mond verdeckt (mit Abstand, damit sein Rand nicht mitzählt)
    if (moon && Math.hypot(ex - moon.cx, ey - moon.cy) < moon.r + 2 * L) continue;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const rr = disc.r - L + j * step;
      const v = sample(l, disc.cx + c * rr, disc.cy + s * rr);
      if (v < 0) { ok = false; break; }
      prof[j] = v;
    }
    if (!ok) continue;
    const m = Math.max(2, Math.round(n * 0.2));
    let a0 = 0, b0 = 0;
    for (let j = 0; j < m; j++) { a0 += prof[j]; b0 += prof[n - 1 - j]; }
    a0 /= m; b0 /= m;
    const contrast = a0 - b0;
    if (contrast < 0.08) continue;
    // von aussen nach innen: erste Stelle über 20 % bzw. 80 %
    const cross = (level: number) => {
      for (let j = n - 1; j > 0; j--) {
        if (prof[j - 1] >= level && prof[j] < level) return j - 1 + (prof[j - 1] - level) / Math.max(1e-6, prof[j - 1] - prof[j]);
      }
      return null;
    };
    const p20 = cross(b0 + 0.2 * contrast), p80 = cross(b0 + 0.8 * contrast);
    if (p20 === null || p80 === null || p20 < p80) continue;
    widths.push((p20 - p80) * step);
  }
  if (widths.length < 12) return null;
  widths.sort((x, y) => x - y);
  return widths[Math.floor(widths.length * 0.75)];
}

// ---------- Zeittreuer Film ----------

/** Ein fertiges Bild des Films (Ausschnitt) mit Aufnahmezeit und Lage von Sonne und Mond darin. */
export interface MovieFrame {
  /** Aufnahmezeit in Sekunden (beliebiger Nullpunkt) */
  t: number;
  /** "sun" = partielle Phase (Sonnenrand), "moon" = Totalität (Mondrand), "none" = ohne Scheibe */
  kind: "sun" | "moon" | "none";
  /** Sonne im Ausschnitt */
  sun?: { cx: number; cy: number; r: number };
  /** Mond vor der Sonne im Ausschnitt (partielle Phase) */
  moon?: { cx: number; cy: number; r: number };
  /** Breite des Sonnenrands in Pixel (für den weichen Rand gerechneter Monde) */
  limbWidth?: number;
}

export interface MovieOptions {
  /** Länge des Films ohne Halten am Anfang und Ende (Sekunden) */
  seconds: number;
  /** davon höchstens für die Totalität */
  totalitySeconds: number;
  /** Videobilder pro Sekunde */
  fps: number;
  holdStart: number;
  holdEnd: number;
}

export const defaultMovie: MovieOptions = { seconds: 24, totalitySeconds: 8, fps: 30, holdStart: 0.5, holdEnd: 2.5 };

/**
 * Ein Videobild: ein echtes Aufnahmebild ("real"), eine Überblendung zweier Bilder ("blend") oder ein gerechnetes
 * Zwischenbild ("synth": Mond an der Stelle, an der er zur Zeit t stand). t: Zeit wie in MovieFrame.
 */
export type MovieStep =
  | { mode: "real"; a: number; t: number }
  | { mode: "blend" | "synth"; a: number; b: number; w: number; t: number };

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Zeitachse des Films: Die Aufnahmezeit läuft gleichmässig (unregelmässig fotografierte Serien laufen trotzdem
 * ruhig), die Totalität langsamer. Fehlen Aufnahmen, entstehen Zwischenbilder; liegen Aufnahmen dichter als die
 * Videobilder, wird jeweils die zeitlich nächste gezeigt.
 * frames: nach Zeit sortiert.
 */
export function planMovie(frames: MovieFrame[], o: MovieOptions = defaultMovie): MovieStep[] {
  const n = frames.length;
  if (!n) return [];
  const steps: MovieStep[] = [];
  const hold = (a: number, sec: number) => {
    for (let k = Math.max(1, Math.round(sec * o.fps)); k > 0; k--) steps.push({ mode: "real", a, t: frames[a].t });
  };
  const t0 = frames[0].t, t1 = frames[n - 1].t, span = t1 - t0;
  if (!(span > 0)) {
    hold(0, o.holdStart + o.holdEnd + 1);
    return steps;
  }
  // Wie viele Sekunden Aufnahmezeit pro Sekunde Film?
  const tot = frames.filter((f) => f.kind === "moon").map((f) => f.t);
  let speed: (t: number) => number;
  if (tot.length) {
    // Totalität samt Diamantring (20 s davor und danach) langsam; Übergang über 5 min
    const T0 = Math.min(...tot) - 20, T1 = Math.max(...tot) + 20, R = 300;
    const totSec = Math.min(o.totalitySeconds, Math.max(3, 0.8 * tot.length));
    const vt = Math.max(1, (T1 - T0) / totSec);
    const make = (vp: number) => (t: number) => {
      const d = t < T0 ? T0 - t : t > T1 ? t - T1 : 0;
      return vt * (vp / vt) ** smooth(d / R);
    };
    const dur = (f: (t: number) => number) => {
      let s = 0;
      const G = 2000;
      for (let k = 0; k < G; k++) s += span / G / f(t0 + ((k + 0.5) * span) / G);
      return s;
    };
    if (dur(make(vt)) <= o.seconds) speed = make(vt);
    else {
      let lo = Math.log(vt), hi = Math.log(Math.max(vt, span) * 1000);
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (dur(make(Math.exp(mid))) > o.seconds) lo = mid;
        else hi = mid;
      }
      speed = make(Math.exp(hi));
    }
  } else {
    const v = Math.max(1, span / o.seconds);
    speed = () => v;
  }
  // Filmzeit als Funktion der Aufnahmezeit (Tabelle), dann umkehren
  const G = 4000;
  const tau = new Float64Array(G + 1);
  for (let k = 0; k < G; k++) tau[k + 1] = tau[k] + span / G / speed(t0 + ((k + 0.5) * span) / G);
  const total = tau[G];
  const K = Math.max(1, Math.round(total * o.fps));
  hold(0, o.holdStart);
  let seg = 0, g = 0;
  for (let k = 1; k <= K; k++) {
    const want = (k / K) * total;
    while (g < G - 1 && tau[g + 1] < want) g++;
    const t = t0 + ((g + clamp01((want - tau[g]) / Math.max(1e-12, tau[g + 1] - tau[g]))) * span) / G;
    while (seg < n - 2 && frames[seg + 1].t <= t) seg++;
    const a = seg, b = Math.min(n - 1, seg + 1);
    const half = speed(t) / (2 * o.fps);
    const near = Math.abs(frames[a].t - t) <= Math.abs(frames[b].t - t) ? a : b;
    if (a === b || Math.abs(frames[near].t - t) <= half) {
      steps.push({ mode: "real", a: near, t: frames[near].t });
      continue;
    }
    const w = clamp01((t - frames[a].t) / (frames[b].t - frames[a].t));
    const A = frames[a], B = frames[b];
    if (canSynth(A, B)) steps.push({ mode: "synth", a, b, w, t });
    else if (A.kind !== "moon" && B.kind !== "moon" && !A.moon && !B.moon) steps.push({ mode: "blend", a, b, w, t });
    else {
      // Totalität oder Wechsel der Phase: Bild stehen lassen, erst kurz vor dem nächsten überblenden
      const ws = smooth((w - 0.7) / 0.3);
      steps.push(ws <= 0 ? { mode: "real", a, t: A.t } : ws >= 1 ? { mode: "real", a: b, t: B.t } : { mode: "blend", a, b, w: ws, t });
    }
  }
  hold(n - 1, o.holdEnd);
  return steps;
}

/**
 * Zwischenbild rechnen nur, wenn beide Bilder Sonne und Mond enthalten und der Mond plausibel weitergezogen ist
 * (er wandert in rund einer Stunde um einen Sonnendurchmesser; grosszügig, die Kamera kann sich gedreht haben).
 */
export function canSynth(A: MovieFrame, B: MovieFrame): boolean {
  if (A.kind !== "sun" || B.kind !== "sun" || !A.sun || !B.sun || !A.moon || !B.moon) return false;
  const r = (A.sun.r + B.sun.r) / 2;
  if (Math.abs(A.sun.r - B.sun.r) > 0.08 * r || Math.abs(A.moon.r - B.moon.r) > 0.1 * r) return false;
  const d = Math.hypot(A.moon.cx - A.sun.cx - (B.moon.cx - B.sun.cx), A.moon.cy - A.sun.cy - (B.moon.cy - B.sun.cy));
  return d <= 0.15 * r + (3 * 2 * r * Math.abs(B.t - A.t)) / 3600;
}

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Überblendung zweier gleich grosser Bilder */
export function blendFrames(A: Rgba, B: Rgba, w: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(A.data.length);
  const a = A.data, b = B.data, v = 1 - w;
  for (let i = 0; i < out.length; i++) out[i] = a[i] * v + b[i] * w;
  return out;
}

function bilinear(im: Rgba, x: number, y: number, c: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= im.width - 1 || y0 >= im.height - 1) {
    const xi = Math.min(im.width - 1, Math.max(0, Math.round(x))), yi = Math.min(im.height - 1, Math.max(0, Math.round(y)));
    return im.data[(yi * im.width + xi) * 4 + c];
  }
  const fx = x - x0, fy = y - y0, i = (y0 * im.width + x0) * 4 + c, s = im.width * 4, d = im.data;
  return (d[i] * (1 - fx) + d[i + 4] * fx) * (1 - fy) + (d[i + s] * (1 - fx) + d[i + s + 4] * fx) * fy;
}

/**
 * Gerechnetes Zwischenbild der partiellen Phase zwischen A (w = 0) und B (w = 1).
 * Der Mond steht dort, wo er zu dieser Zeit war (Lage relativ zur Sonne linear zwischen A und B). Gerechnet wird
 * aus dem zeitlich näheren Bild, in der Mitte der Lücke kurz überblendet; bei w = 0 bzw. 1 kommt genau das
 * Aufnahmebild heraus. Aus einem Grundbild heraus: Wo der Mond zu dieser Zeit weniger verdeckt, kommt die
 * Sonne aus dem anderen Bild (dort ist sie frei, weil der Mond auf seiner Bahn weiterzieht); wo er mehr verdeckt,
 * wird es dunkel wie der Mond im anderen Bild. Ausserhalb der Sonnenscheibe bleibt das Grundbild.
 */
export function synthFrame(A: Rgba, B: Rgba, fa: MovieFrame, fb: MovieFrame, w: number): Uint8ClampedArray<ArrayBuffer> {
  // Mond zu dieser Zeit relativ zur Sonnenmitte
  const off = {
    x: (1 - w) * (fa.moon!.cx - fa.sun!.cx) + w * (fb.moon!.cx - fb.sun!.cx),
    y: (1 - w) * (fa.moon!.cy - fa.sun!.cy) + w * (fb.moon!.cy - fb.sun!.cy),
    r: (1 - w) * fa.moon!.r + w * fb.moon!.r,
  };
  if (w <= 0) return new Uint8ClampedArray(A.data);
  if (w >= 1) return new Uint8ClampedArray(B.data);
  // Zwei Verfahren. Kurzer Weg des Mondes zwischen den beiden Fotos (die meisten Lücken): den Mond samt Rand
  // verschieben – das braucht nur den Weg, nicht die genaue Lage des Mondrands, und ist darum auch bei überstrahlten
  // Fotos sicher. Langer Weg (ab einem Viertel des Sonnenradius, etwa 8 Minuten): Dort entstünden beim Verschieben
  // dunkle Flecken und Reste des alten Rands; gerechnet wird dann mit einem Modell des Fotos – wenn es zu beiden
  // Fotos passt.
  const way = Math.hypot(fa.moon!.cx - fa.sun!.cx - (fb.moon!.cx - fb.sun!.cx), fa.moon!.cy - fa.sun!.cy - (fb.moon!.cy - fb.sun!.cy));
  const synthFrom = way > 0.25 * fa.sun!.r && sunModel(A, fa.sun!, fa.moon!).ok && sunModel(B, fb.sun!, fb.moon!).ok ? modelFrom : warpFrom;
  // aus dem näheren Bild; nur um die Mitte herum überblenden (bei grossen Lücken sehen Dunst und Mondrand in den
  // beiden Bildern verschieden aus – gleichmässig gemischt ergäbe das doppelte Ränder)
  const wb = smooth((w - 0.42) / 0.16);
  if (wb <= 0) return synthFrom(A, B, fa, fb, off);
  if (wb >= 1) return synthFrom(B, A, fb, fa, off);
  const fromA = synthFrom(A, B, fa, fb, off);
  const fromB = synthFrom(B, A, fb, fa, off);
  const out = new Uint8ClampedArray(A.data.length);
  for (let i = 0; i < out.length; i++) out[i] = fromA[i] * (1 - wb) + fromB[i] * wb;
  return out;
}

type Circle = { cx: number; cy: number; r: number };

/** Spitzen der Sichel: Schnittpunkte von Sonnen- und Mondrand [x1, y1, x2, y2] – oder null (kein Schnitt) */
function hornTips(s: Circle, m: Circle): number[] | null {
  const dx = m.cx - s.cx, dy = m.cy - s.cy, d = Math.hypot(dx, dy);
  if (d < 1e-6 || d >= s.r + m.r || d <= Math.abs(s.r - m.r)) return null;
  const a = (s.r * s.r - m.r * m.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, s.r * s.r - a * a));
  const bx = s.cx + (a * dx) / d, by = s.cy + (a * dy) / d;
  return [bx - (h * dy) / d, by + (h * dx) / d, bx + (h * dy) / d, by - (h * dx) / d];
}

/**
 * Lage eines Bildpunkts zur sichtbaren Sonne (Sonnenscheibe ohne Mondscheibe). Rückgabe: Abstand zu ihrem Rand in
 * Pixel – innen positiv, aussen (Himmel und Mond vor der Sonne) negativ. Dazu in `fieldMix` (0…1), welcher Rand
 * innen näher liegt: 0 = Sonnenrand, 1 = Mondrand; der Übergang ist weich (Breite tau), damit im gerechneten Bild
 * keine Naht entsteht.
 */
let fieldMix = 0;
function crescentField(x: number, y: number, s: Circle, m: Circle, tips: number[] | null, tau: number): number {
  const dxs = x - s.cx, dys = y - s.cy, ds = Math.sqrt(dxs * dxs + dys * dys);
  const dxm = x - m.cx, dym = y - m.cy, dm = Math.sqrt(dxm * dxm + dym * dym);
  const inS = ds < s.r, inM = dm < m.r;
  if (inS && !inM) {
    const a = s.r - ds, b = dm - m.r;
    fieldMix = smooth(0.5 + (a - b) / (2 * tau));
    return a < b ? a : b;
  }
  let best = Infinity;
  if (!inS && ds > 1e-6) {
    // nächster Punkt des Sonnenrands – wenn ihn der Mond nicht verdeckt
    const qx = s.cx + (dxs * s.r) / ds - m.cx, qy = s.cy + (dys * s.r) / ds - m.cy;
    if (qx * qx + qy * qy >= m.r * m.r) best = ds - s.r;
  }
  if (inM && dm > 1e-6) {
    // nächster Punkt des Mondrands – wenn er vor der Sonne liegt
    const qx = m.cx + (dxm * m.r) / dm - s.cx, qy = m.cy + (dym * m.r) / dm - s.cy;
    if (qx * qx + qy * qy <= s.r * s.r) best = Math.min(best, m.r - dm);
  }
  if (tips) {
    best = Math.min(best, Math.hypot(x - tips[0], y - tips[1]), Math.hypot(x - tips[2], y - tips[3]));
  }
  if (best === Infinity) best = Math.max(0, ds - s.r, m.r - dm);
  // Aussen gibt es nur eine Art: Der Lichtschein fällt vor dem Mond so ab wie am Himmel neben der Sonne. Getrennte
  // Tabellen ergäben eine Stufe entlang des Sonnenrands, den der Mond verdeckt – dort ist im Foto nichts zu sehen.
  fieldMix = 0;
  return -best;
}

/**
 * Mondrand am Foto nachmessen. Die Lage des Mondes kommt aus der Serie (Messung am Originalfoto oder ergänzte
 * Bahn); in überstrahlten Fotos sitzt der sichtbare Rand aber je nach Belichtung um viele Pixel daneben (der
 * Lichtschein frisst den Mond an). Für das Modell zählt der Rand, wie er in diesem Foto aussieht.
 * Entlang von Strahlen vom Mondmittelpunkt – nur wo der Rand vor der Sonne liegt – wird die Stelle gesucht, an der
 * die Helligkeit die Mitte zwischen Mond und Sonne kreuzt; durch diese Punkte kommt ein Kreis. Ohne klares Ergebnis
 * (zu wenig Rand, Kreis weit weg von der Vorgabe) bleibt die Vorgabe.
 */
export function refineMoon(N: Rgba, s: Circle, m: Circle): Circle {
  const W = N.width, H = N.height, D = N.data;
  const lumAt = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
    const i = (yi * W + xi) * 4;
    return (D[i] + D[i + 1] + D[i + 2]) / 3;
  };
  const search = Math.max(8, 0.25 * m.r), margin = Math.max(4, 0.06 * s.r);
  // Helligkeit der freien Sonne (Median über die Scheibe abseits des Mondes) – der Rand liegt auf halbem Weg dorthin.
  // Aus dem Strahl allein ginge das nicht: Nahe der Sichelspitzen endet er im Lichtschein, bevor er die Sonne erreicht.
  const free: number[] = [];
  const stepS = Math.max(1, Math.round(s.r / 40));
  for (let y = Math.max(0, Math.ceil(s.cy - s.r)); y <= Math.min(H - 1, s.cy + s.r); y += stepS)
    for (let x = Math.max(0, Math.ceil(s.cx - s.r)); x <= Math.min(W - 1, s.cx + s.r); x += stepS) {
      if (Math.hypot(x - s.cx, y - s.cy) > s.r - 2 * margin || Math.hypot(x - m.cx, y - m.cy) < m.r + search) continue;
      const i = (y * W + x) * 4;
      free.push((D[i] + D[i + 1] + D[i + 2]) / 3);
    }
  if (free.length < 20) return m;
  const sunLevel = free.sort((a, b) => a - b)[free.length >> 1];
  const xs: number[] = [], ys: number[] = [];
  const prof: number[] = [];
  const rays = 240;
  for (let k = 0; k < rays; k++) {
    const ang = (2 * Math.PI * k) / rays, ca = Math.cos(ang), sa = Math.sin(ang);
    // Profil von innen (Mond) nach aussen (Sonne), nur innerhalb der Sonnenscheibe
    prof.length = 0;
    let t0 = -1;
    for (let t = m.r - search; t <= m.r + search; t++) {
      const x = m.cx + ca * t, y = m.cy + sa * t;
      if (Math.hypot(x - s.cx, y - s.cy) > s.r - margin) {
        if (prof.length) break;
        continue;
      }
      const v = lumAt(x, y);
      if (v < 0) {
        if (prof.length) break;
        continue;
      }
      if (!prof.length) t0 = t;
      prof.push(v);
    }
    if (prof.length < 12) continue;
    const sorted = [...prof].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sunLevel;
    if (hi - lo < 30) continue;
    const mid = (lo + hi) / 2;
    // erster Durchgang nach oben, der oben bleibt
    for (let i = 1; i < prof.length - 3; i++) {
      if (prof[i - 1] < mid && prof[i] >= mid && prof[i + 1] >= mid && prof[i + 2] >= mid) {
        // innen muss es vorher wirklich dunkel gewesen sein (sonst begann das Profil schon in der Sonne)
        if (Math.min(...prof.slice(0, i)) > lo + 0.25 * (hi - lo)) break;
        const t = t0 + i - 1 + (mid - prof[i - 1]) / Math.max(1e-6, prof[i] - prof[i - 1]);
        xs.push(m.cx + ca * t);
        ys.push(m.cy + sa * t);
        break;
      }
    }
  }
  if (xs.length < 16) return m;
  let keep = xs.map((_, i) => i);
  let c = fitCircle(xs, ys);
  for (let round = 0; round < 3 && c; round++) {
    const res = keep.map((i) => Math.hypot(xs[i] - c!.cx, ys[i] - c!.cy) - c!.r);
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    const mad = [...res.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(1.5, 3 * 1.4826 * mad);
    const next = keep.filter((_, j) => Math.abs(res[j] - med) <= lim);
    if (next.length === keep.length || next.length < 16) break;
    keep = next;
    c = fitCircle(keep.map((i) => xs[i]), keep.map((i) => ys[i]));
  }
  if (!c || keep.length < 16) return m;
  // genug Rand (ein Sechstel des Kreises) und nicht weit von der Vorgabe
  if (keep.length < rays / 6 || Math.abs(c.r - m.r) > 0.15 * m.r || Math.hypot(c.cx - m.cx, c.cy - m.cy) > 0.25 * m.r) return m;
  return { cx: c.cx, cy: c.cy, r: c.r };
}

/** Schrittweite der Helligkeitstabelle in Pixel Abstand */
const LUT_STEP = 0.5;

/**
 * Modell eines Fotos der partiellen Phase: Wie hell ist es in welchem Abstand vom Rand der sichtbaren Sonne?
 * Tabellen für die Sonne am Sonnenrand, die Sonne am Mondrand und für aussen (Himmel, Mond vor der Sonne), je Farbe
 * gemittelt über das ganze Bild. Die Tabellen enthalten damit den weichen Rand und den Lichtschein genau so, wie sie im Foto sind.
 */
interface SunModel {
  key: string;
  /** Mond, wie er in diesem Foto aussieht (refineMoon) – darauf beziehen sich Abstände und Tabellen */
  moon: Circle;
  /** je Bildpunkt: Abstand und Rand-Art (siehe crescentField) */
  d: Float32Array;
  mix: Uint8Array;
  /** [Tabelle][Abstandsstufe][Farbe] */
  lut: Float32Array;
  dMin: number;
  bins: number;
  tau: number;
  /**
   * Passt das Modell zum Foto? Nein, wenn der Mondrand nicht dort liegt, wo er gemessen wurde (dünne Sichel tief
   * am Horizont, Bäume, Wolken): Dann ist am angenommenen Rand kein Hell-Dunkel-Übergang, oder das Foto weicht dort
   * stark vom Modell ab.
   */
  ok: boolean;
}
const models = new WeakMap<Rgba, SunModel>();

export function sunModel(N: Rgba, s: Circle, m0: Circle): SunModel {
  const key = [s.cx, s.cy, s.r, m0.cx, m0.cy, m0.r].join(",");
  const hit = models.get(N);
  if (hit && hit.key === key) return hit;
  const m = refineMoon(N, s, m0);
  const W = N.width, H = N.height, tau = 0.08 * s.r;
  const dMin = -0.9 * s.r, bins = Math.ceil((s.r - dMin) / LUT_STEP) + 2;
  const d = new Float32Array(W * H), mix = new Uint8Array(W * H);
  const sum = new Float64Array(4 * bins * 3), cnt = new Uint32Array(4 * bins);
  const tips = hornTips(s, m);
  for (let y = 0, i = 0; y < H; y++)
    for (let x = 0; x < W; x++, i++) {
      const v = crescentField(x, y, s, m, tips, tau);
      d[i] = v;
      mix[i] = Math.round(fieldMix * 255);
      if (v < dMin) continue;
      // nur eindeutige Punkte in die Tabellen (nicht aus dem Übergang zwischen zwei Rand-Arten)
      if (fieldMix > 0.2 && fieldMix < 0.8) continue;
      const t = (v > 0 ? 0 : 2) + (fieldMix >= 0.5 ? 1 : 0);
      const b = t * bins + Math.min(bins - 1, Math.round((v - dMin) / LUT_STEP));
      cnt[b]++;
      sum[b * 3] += N.data[i * 4];
      sum[b * 3 + 1] += N.data[i * 4 + 1];
      sum[b * 3 + 2] += N.data[i * 4 + 2];
    }
  const lut = new Float32Array(4 * bins * 3);
  // belegter Bereich je Tabelle (Stufen mit genug Bildpunkten)
  const first = [-1, -1, -1, -1], last = [-1, -1, -1, -1];
  for (let t = 0; t < 4; t++) {
    // Mittelwerte; Lücken im Inneren linear füllen
    for (let b = 0; b < bins; b++) {
      const k = t * bins + b;
      if (cnt[k] < 3) continue;
      for (let c = 0; c < 3; c++) lut[k * 3 + c] = sum[k * 3 + c] / cnt[k];
      if (first[t] < 0) first[t] = b;
      else
        for (let j = last[t] + 1; j < b; j++) {
          const f = (j - last[t]) / (b - last[t]);
          for (let c = 0; c < 3; c++) lut[(t * bins + j) * 3 + c] = lut[(t * bins + last[t]) * 3 + c] * (1 - f) + lut[k * 3 + c] * f;
        }
      last[t] = b;
    }
  }
  // Über den belegten Bereich hinaus: die Form der verwandten Tabelle, an der Grenze angepasst. Beispiel: Der Mond
  // schneidet die Sonne erst wenig an – „Mond vor der Sonne“ ist dann nur bis zu einer geringen Tiefe belegt; tiefer
  // im Mond fällt der Lichtschein so ab wie am Himmel neben der Sonne.
  for (const [t, u] of [[1, 0], [0, 1], [3, 2], [2, 3]]) {
    const T = t * bins * 3, U = u * bins * 3;
    if (first[t] < 0) {
      if (first[u] >= 0) lut.copyWithin(T, U, U + bins * 3);
      continue;
    }
    const extend = (edge: number, from: number, to: number) => {
      for (let c = 0; c < 3; c++) {
        const own = lut[T + edge * 3 + c];
        // Verhältnis an der Grenze (verwandte Tabelle dort belegt und nicht null), sonst gleichbleibend fortsetzen
        const ref = first[u] >= 0 && edge >= first[u] && edge <= last[u] ? lut[U + edge * 3 + c] : 0;
        for (let j = from; j <= to; j++) {
          const sib = first[u] >= 0 && j >= first[u] && j <= last[u] ? lut[U + j * 3 + c] : -1;
          lut[T + j * 3 + c] = ref > 1 && sib >= 0 ? Math.min(255, (own * sib) / ref) : own;
        }
      }
    };
    extend(first[t], 0, first[t] - 1);
    extend(last[t], last[t] + 1, bins - 1);
  }
  // was dann noch fehlt (auch die verwandte Tabelle endet): gleichbleibend fortsetzen; danach leicht glätten
  for (let t = 0; t < 4; t++) {
    if (first[t] < 0 && first[t ^ 1] < 0) continue;
    for (let c = 0; c < 3; c++) {
      let prev = lut[t * bins * 3 + c];
      for (let b = 1; b < bins - 1; b++) {
        const k = (t * bins + b) * 3 + c, cur = lut[k];
        lut[k] = 0.25 * prev + 0.5 * cur + 0.25 * lut[k + 3];
        prev = cur;
      }
    }
  }
  const model: SunModel = { key, moon: m, d, mix, lut, dMin, bins, tau, ok: true };
  // Probe am angenommenen Mondrand (vor der Sonne): Übergang vorhanden, und das Foto folgt dem Modell?
  {
    const band = Math.max(6, 0.04 * s.r), v = new Float32Array(3);
    modelValue(model, band, 1, v);
    const bright = v[0] + v[1] + v[2];
    modelValue(model, -band, 0, v);
    const contrast = (bright - (v[0] + v[1] + v[2])) / 3;
    let err = 0, n = 0;
    for (let y = 1; y < H; y += 2)
      for (let x = 1; x < W; x += 2) {
        if (Math.abs(Math.hypot(x - m.cx, y - m.cy) - m.r) > band || Math.hypot(x - s.cx, y - s.cy) > s.r - band) continue;
        const i = y * W + x;
        modelValue(model, d[i], mix[i] / 255, v);
        err += Math.abs(N.data[i * 4] - v[0]) + Math.abs(N.data[i * 4 + 1] - v[1]) + Math.abs(N.data[i * 4 + 2] - v[2]);
        n += 3;
      }
    model.ok = n < 30 || (contrast >= 12 && err / n <= 0.55 * contrast);
  }
  models.set(N, model);
  return model;
}

/** Helligkeit laut Modell für Abstand d und Rand-Art mix (0…1) – in out[0..2] */
function modelValue(M: SunModel, d: number, mix: number, out: Float32Array): void {
  const f = Math.min(M.bins - 1.001, Math.max(0, (d - M.dMin) / LUT_STEP));
  const b = Math.floor(f), g = f - b;
  const t0 = ((d > 0 ? 0 : 2) * M.bins + b) * 3, t1 = t0 + M.bins * 3, L = M.lut;
  for (let c = 0; c < 3; c++) {
    const v0 = L[t0 + c] * (1 - g) + L[t0 + 3 + c] * g, v1 = L[t1 + c] * (1 - g) + L[t1 + 3 + c] * g;
    out[c] = v0 * (1 - mix) + v1 * mix;
  }
}

/**
 * Zwischenbild aus einem Grundbild N für kurze Wege des Mondes: Der Mond wird mitsamt seinem Rand und dem Lichtschein darin um die Strecke
 * verschoben, die er bis zu dieser Zeit wandert (Bild an der verschobenen Stelle abgetastet) – so bleibt der Rand
 * so weich und so hell wie im Foto. Ausserhalb des Mondes bleibt das Grundbild; wo der Mond im Grundbild noch
 * davor stand, jetzt aber nicht mehr, kommt die Sonne aus dem anderen Bild O (dort ist sie frei, weil der Mond auf
 * seiner Bahn weiterzieht), in der Helligkeit angeglichen.
 */
function warpFrom(N: Rgba, O: Rgba, fN: MovieFrame, fO: MovieFrame, off: { x: number; y: number; r: number }): Uint8ClampedArray<ArrayBuffer> {
  const sN = fN.sun!, sO = fO.sun!, mN = fN.moon!, mO = fO.moon!;
  const W = N.width, H = N.height;
  const out = new Uint8ClampedArray(N.data);
  // Mond zu dieser Zeit im Grundbild und Verschiebung gegenüber dem Grundbild
  const mx = sN.cx + off.x, my = sN.cy + off.y, mr = off.r;
  const scale = mN.r / Math.max(1, mr);
  // Punkt im Grundbild → Punkt im anderen Bild (dieselbe Stelle der Sonnenscheibe)
  const sx = sO.cx - sN.cx, sy = sO.cy - sN.cy;
  const omx = mO.cx - sx, omy = mO.cy - sy; // Mond des anderen Bildes in Koordinaten des Grundbilds
  // weicher Rand wie der Sonnenrand im Bild (20–80 % über limbWidth → linearer Übergang über limbWidth / 0.6)
  const ramp = Math.max(1, (fN.limbWidth ?? fO.limbWidth ?? 1.2) / 0.6);
  const cov = (d: number, r: number) => clamp01((r - d) / ramp + 0.5);
  // Helligkeit der Sonne angleichen (freie Sonne in beiden Bildern)
  const rS = sN.r;
  const sunN = [0, 0, 0], sunO = [0, 0, 0];
  const bx0 = Math.max(0, Math.floor(sN.cx - rS)), bx1 = Math.min(W - 1, Math.ceil(sN.cx + rS));
  const by0 = Math.max(0, Math.floor(sN.cy - rS)), by1 = Math.min(H - 1, Math.ceil(sN.cy + rS));
  for (let y = by0; y <= by1; y += 3)
    for (let x = bx0; x <= bx1; x += 3) {
      if (Math.hypot(x - sN.cx, y - sN.cy) > rS - 2 * ramp) continue;
      if (cov(Math.hypot(x - mN.cx, y - mN.cy), mN.r + ramp) > 0 || cov(Math.hypot(x - omx, y - omy), mO.r + ramp) > 0) continue;
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) { sunN[c] += N.data[i + c]; sunO[c] += bilinear(O, x + sx, y + sy, c); }
    }
  const gain = [0, 1, 2].map((c) => (sunO[c] > 0 ? Math.min(2, Math.max(0.5, sunN[c] / sunO[c])) : 1));
  // betroffen: der Mond jetzt und im Grundbild, mit Rand
  const R = Math.max(mr, mN.r) + 3 * ramp;
  const x0 = Math.max(0, Math.floor(Math.min(mx, mN.cx) - R)), x1 = Math.min(W - 1, Math.ceil(Math.max(mx, mN.cx) + R));
  const y0 = Math.max(0, Math.floor(Math.min(my, mN.cy) - R)), y1 = Math.min(H - 1, Math.ceil(Math.max(my, mN.cy) + R));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dT = Math.hypot(x - mx, y - my);
      // Anteil verschobener Mond: im Mond und in seinem Randbereich, nur vor der Sonne (vor dem Himmel ist der
      // Mond nicht zu sehen – dort bleibt der Lichtschein um die Sonne)
      const k = cov(dT, mr + ramp) * cov(Math.hypot(x - sN.cx, y - sN.cy), rS + ramp);
      // (nur vor der Sonne – daneben ist der Mond nicht zu sehen, dort bleibt der Lichtschein des Grundbilds)
      const nCov = cov(Math.hypot(x - mN.cx, y - mN.cy), mN.r + 0.5 * ramp) * cov(Math.hypot(x - sN.cx, y - sN.cy), rS + ramp);
      if (k === 0 && nCov === 0) continue;
      const i = (y * W + x) * 4;
      // verschobene Stelle im Grundbild (Radius leicht angepasst, falls er sich ändert)
      const qx = mN.cx + (x - mx) * scale, qy = mN.cy + (y - my) * scale;
      const oCov = cov(Math.hypot(x - omx, y - omy), mO.r + 0.5 * ramp);
      for (let c = 0; c < 3; c++) {
        const n = N.data[i + c];
        // Grund: wo der Mond im Grundbild stand und hier jetzt Sonne sein soll, die Sonne aus dem anderen Bild
        const base = nCov > 0 && oCov < nCov ? n + nCov * (bilinear(O, x + sx, y + sy, c) * gain[c] - n) : n;
        out[i + c] = k > 0 ? k * bilinear(N, qx, qy, c) + (1 - k) * base : base;
      }
    }
  return out;
}

/**
 * Zwischenbild aus einem Grundbild N für lange Wege des Mondes (grosse Lücken): Das Foto bleibt, wie es ist; geändert wird nur, was sich durch den Weg des
 * Mondes ändert. Dafür sagt ein Modell des Fotos (sunModel), wie hell es in welchem Abstand vom Rand der sichtbaren
 * Sonne ist – jeder Bildpunkt bekommt den Unterschied zwischen seiner Lage jetzt und seiner Lage im Foto dazu.
 * So wandern der weiche Mondrand, der Lichtschein neben der Sichel und ihre Spitzen mit, auch über grosse Lücken.
 * Wo der Mond die Sonne freigibt, kommt die Sonnenoberfläche aus dem anderen Bild O (dort ist sie frei, weil der
 * Mond auf seiner Bahn weiterzieht – so erscheinen auch Sonnenflecken an der richtigen Stelle), in der Helligkeit
 * angeglichen.
 */
function modelFrom(N: Rgba, O: Rgba, fN: MovieFrame, fO: MovieFrame, off: { x: number; y: number; r: number }): Uint8ClampedArray<ArrayBuffer> {
  const sN = fN.sun!, sO = fO.sun!;
  const W = N.width, H = N.height;
  const out = new Uint8ClampedArray(N.data);
  const MN = sunModel(N, sN, fN.moon!), MO = sunModel(O, sO, fO.moon!);
  // Mond, wie er in den Fotos aussieht. Zu dieser Zeit steht er um den Weg weiter, den die Bahn angibt – in der
  // Grösse des Grundbilds (wie stark der Lichtschein den Mond anfrisst, hängt von der Belichtung des Fotos ab).
  const mN = MN.moon, mO = MO.moon;
  const mT = { cx: mN.cx + off.x - (fN.moon!.cx - sN.cx), cy: mN.cy + off.y - (fN.moon!.cy - sN.cy), r: mN.r };
  // Punkt im Grundbild → Punkt im anderen Bild (dieselbe Stelle der Sonnenscheibe)
  const sx = sO.cx - sN.cx, sy = sO.cy - sN.cy;
  const omx = mO.cx - sx, omy = mO.cy - sy; // Mond des anderen Bildes in Koordinaten des Grundbilds
  // weicher Rand wie der Sonnenrand im Bild (20–80 % über limbWidth → linearer Übergang über limbWidth / 0.6)
  const ramp = Math.max(1, (fN.limbWidth ?? fO.limbWidth ?? 1.2) / 0.6);
  const cov = (d: number, r: number) => clamp01((r - d) / ramp + 0.5);
  // Helligkeit der Sonne angleichen (freie Sonne in beiden Bildern)
  const rS = sN.r;
  const sunN = [0, 0, 0], sunO = [0, 0, 0];
  const bx0 = Math.max(0, Math.floor(sN.cx - rS)), bx1 = Math.min(W - 1, Math.ceil(sN.cx + rS));
  const by0 = Math.max(0, Math.floor(sN.cy - rS)), by1 = Math.min(H - 1, Math.ceil(sN.cy + rS));
  for (let y = by0; y <= by1; y += 3)
    for (let x = bx0; x <= bx1; x += 3) {
      if (Math.hypot(x - sN.cx, y - sN.cy) > rS - 2 * ramp) continue;
      if (cov(Math.hypot(x - mN.cx, y - mN.cy), mN.r + ramp) > 0 || cov(Math.hypot(x - omx, y - omy), mO.r + ramp) > 0) continue;
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) { sunN[c] += N.data[i + c]; sunO[c] += bilinear(O, x + sx, y + sy, c); }
    }
  const gain = [0, 1, 2].map((c) => (sunO[c] > 0 ? Math.min(2, Math.max(0.5, sunN[c] / sunO[c])) : 1));

  const tipsT = hornTips(sN, mT);
  const sOc = { cx: sO.cx, cy: sO.cy, r: sO.r }, tipsO = hornTips(sO, mO);
  // betroffen: der Mond jetzt und im Grundbild samt Lichtschein in ihrer Nähe; nach aussen läuft die Änderung aus
  const reach = 0.7 * rS, fadeFrom = 0.45 * rS;
  const zone = Math.max(3 * ramp, 6);
  const rSafe = Math.min(sN.r, sO.r) - 3 * ramp;
  const R = Math.max(mT.r, mN.r) + reach;
  const x0 = Math.max(0, Math.floor(Math.min(mT.cx, mN.cx) - R)), x1 = Math.min(W - 1, Math.ceil(Math.max(mT.cx, mN.cx) + R));
  const y0 = Math.max(0, Math.floor(Math.min(mT.cy, mN.cy) - R)), y1 = Math.min(H - 1, Math.ceil(Math.max(mT.cy, mN.cy) + R));
  const vT = new Float32Array(3), vN = new Float32Array(3), vOt = new Float32Array(3), vOo = new Float32Array(3);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dmN = Math.hypot(x - mN.cx, y - mN.cy), dmT = Math.hypot(x - mT.cx, y - mT.cy);
      const far = Math.min(dmN - mN.r, dmT - mT.r);
      if (far >= reach) continue;
      const fade = far <= fadeFrom ? 1 : 1 - smooth((far - fadeFrom) / (reach - fadeFrom));
      const p = y * W + x, i = p * 4;
      const dT = crescentField(x, y, sN, mT, tipsT, MN.tau), mixT = fieldMix;
      const dN = MN.d[p], mixN = MN.mix[p] / 255;
      if (Math.abs(dT - dN) < 0.02 && Math.abs(mixT - mixN) < 0.01) continue;
      modelValue(MN, dT, mixT, vT);
      modelValue(MN, dN, mixN, vN);
      const dS = Math.hypot(x - sN.cx, y - sN.cy);
      // Am früheren Mondrand (und am Sonnenrand, den jetzt der Mond verdeckt) passt das Modell nie auf den Bildpunkt
      // genau – der Rest bliebe als feine Linie stehen. Dort gilt, wenn sich die Lage geändert hat, nur das Modell.
      const changed = smooth(Math.abs(dT - dN) / (2 * ramp));
      const atOldMoon = clamp01(1.5 - Math.abs(dmN - mN.r) / zone) * cov(dS, rS + ramp);
      const atOldLimb = clamp01(1.5 - Math.abs(dS - rS) / zone) * cov(dmT, mT.r + ramp) * (1 - cov(dmN, mN.r + ramp));
      // Ebenso, wo sich die Helligkeit stark ändert (Sonne wird Mond oder umgekehrt): Was der Bildpunkt im Foto vom
      // Modell abwich (Farbsaum, Körnung des Lichtscheins), gehört zur alten Lage und würde sonst mitgenommen.
      // Nur in und an der sichtbaren Sonne – im Lichtschein weiter draussen bleibt das Foto mit seiner Körnung.
      const big = smooth((Math.max(Math.abs(vT[0] - vN[0]), Math.abs(vT[1] - vN[1]), Math.abs(vT[2] - vN[2])) - 30) / 60) * smooth((dT + zone) / zone);
      const kappa = fade * Math.max(changed * Math.max(atOldMoon, atOldLimb), big);
      // frei gewordene Sonne: im Grundbild stand der Mond davor, jetzt nicht mehr – und im anderen Bild auch nicht.
      // Nur sicher innerhalb beider Sonnenscheiben (überstrahlt ist die Sonne in einem der Bilder oft grösser).
      const rho = fade * clamp01(cov(dmN, mN.r) - cov(dmT, mT.r)) * cov(dS, rSafe) * (1 - cov(Math.hypot(x - omx, y - omy), mO.r + ramp));
      if (rho > 0) {
        const dO = crescentField(x + sx, y + sy, sOc, mO, tipsO, MO.tau), mixO = fieldMix;
        modelValue(MO, dT, mixT, vOt);
        modelValue(MO, dO, mixO, vOo);
      }
      for (let c = 0; c < 3; c++) {
        // heller: Unterschied dazuzählen; dunkler: im Verhältnis abdunkeln (der Lichtschein ist selten ringsum
        // gleich hell – abgezogen würde er an schwachen Stellen schwarz, an hellen bliebe ein Rest)
        const n = N.data[i + c];
        let v = n + fade * ((vT[c] >= vN[c] ? n + vT[c] - vN[c] : (n * vT[c]) / Math.max(1, vN[c])) - n);
        if (kappa > 0) v += kappa * (vT[c] - v);
        if (rho > 0) v = (1 - rho) * v + rho * gain[c] * (bilinear(O, x + sx, y + sy, c) + vOt[c] - vOo[c]);
        out[i + c] = v;
      }
    }
  return out;
}

/**
 * Mond in Bildern ergänzen, in denen er nicht gemessen wurde (überstrahlte Sichel, Dunst) – und offensichtlich
 * falsche Messungen ersetzen. Seine Lage relativ zur Sonne ändert sich gleichmässig mit der Zeit: linear zwischen
 * den nächsten gemessenen Bildern davor und danach (höchstens 40 min auseinander). Am Anfang und Ende der Serie
 * wird nicht verlängert. Radius: Median der Messungen. frames: nach Zeit sortiert; wird verändert.
 */
export function fillMoonTrack(frames: MovieFrame[], maxGapSeconds = 2400): void {
  const meas = frames.map((f, i) => ({ f, i })).filter((x) => x.f.kind === "sun" && x.f.sun && x.f.moon);
  if (meas.length < 2) return;
  const radii = meas.map((x) => x.f.moon!.r).sort((a, b) => a - b);
  const moonR = radii[radii.length >> 1];
  const offOf = (f: MovieFrame) => ({ x: f.moon!.cx - f.sun!.cx, y: f.moon!.cy - f.sun!.cy });
  const interp = (k: number, t: number, skip?: number) => {
    let a = -1, b = -1;
    for (let j = k; j >= 0; j--) if (j !== skip && meas[j].f.t <= t) { a = j; break; }
    for (let j = Math.max(0, k); j < meas.length; j++) if (j !== skip && meas[j].f.t >= t) { b = j; break; }
    if (a < 0 || b < 0 || meas[b].f.t - meas[a].f.t > maxGapSeconds) return null;
    const A = meas[a].f, B = meas[b].f, oa = offOf(A), ob = offOf(B);
    const w = B.t > A.t ? (t - A.t) / (B.t - A.t) : 0;
    return { x: oa.x + w * (ob.x - oa.x), y: oa.y + w * (ob.y - oa.y) };
  };
  // offensichtlich falsche Messungen: weit weg von der Geraden durch die Nachbarn. Die schlimmste zuerst
  // entfernen, dann neu prüfen – sonst verdächtigt ein Ausreisser auch seine richtigen Nachbarn.
  const bad = new Set<number>();
  for (const m of meas) if (Math.abs(m.f.moon!.r - moonR) > 0.08 * moonR) bad.add(m.i);
  for (;;) {
    const cur = meas.filter((m) => !bad.has(m.i));
    let worst = -1, worstD = 0;
    cur.forEach((m, k) => {
      if (k === 0 || k === cur.length - 1) return;
      const a = cur[k - 1].f, b = cur[k + 1].f;
      if (b.t - a.t > maxGapSeconds) return;
      const oa = offOf(a), ob = offOf(b), w = b.t > a.t ? (m.f.t - a.t) / (b.t - a.t) : 0.5;
      const o = offOf(m.f);
      const d = Math.hypot(o.x - (oa.x + w * (ob.x - oa.x)), o.y - (oa.y + w * (ob.y - oa.y)));
      if (d > Math.max(3, 0.05 * m.f.sun!.r) && d > worstD) { worst = m.i; worstD = d; }
    });
    if (worst < 0) break;
    bad.add(worst);
  }
  const good = meas.filter((m) => !bad.has(m.i));
  meas.length = 0;
  meas.push(...good);
  if (meas.length < 2) return;
  frames.forEach((f, i) => {
    if (f.kind !== "sun" || !f.sun || (f.moon && !bad.has(i))) return;
    let k = 0;
    while (k < meas.length - 1 && meas[k + 1].f.t <= f.t) k++;
    const p = interp(k, f.t);
    if (!p) { if (bad.has(i)) f.moon = undefined; return; }
    // Mond muss die Sonne berühren, sonst ist er nicht zu sehen
    if (Math.hypot(p.x, p.y) >= f.sun.r + moonR) { f.moon = undefined; return; }
    f.moon = { cx: f.sun.cx + p.x, cy: f.sun.cy + p.y, r: moonR };
  });
}

/** Lage von Sonne und Mond im Ausschnitt aus dem Ergebnis der Verarbeitung (ohne Drehen/Spiegeln/Grösse). */
export function movieMeta(res: Pick<FrameResult, "det" | "origin" | "zoom">): Omit<MovieFrame, "t"> {
  const d = res.det.disc;
  if (!d || !res.origin) return { kind: "none" };
  const [x0, y0] = res.origin;
  const z = res.zoom ?? 1;
  const at = (c: { cx: number; cy: number }, r: number) => ({ cx: (c.cx - x0) * z, cy: (c.cy - y0) * z, r: r * z });
  if (d.kind === "moon") return { kind: "moon", sun: at(d.sun ?? d, d.r) };
  const m = d.moon ?? d.moonLoose;
  return { kind: "sun", sun: at(d, d.r), moon: m ? at(m, m.r) : undefined, limbWidth: d.limbWidth !== undefined ? d.limbWidth * z : undefined };
}
