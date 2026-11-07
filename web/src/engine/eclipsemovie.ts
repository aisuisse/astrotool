// Finsternis-Film: Schärfe am Sonnenrand, zeittreue Zeitachse mit Zwischenbildern.
// Eigenständige Implementierung.
import { sample } from "./limb";
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

/**
 * Zwischenbild aus einem Grundbild N: Der Mond wird mitsamt seinem Rand und dem Lichtschein darin um die Strecke
 * verschoben, die er bis zu dieser Zeit wandert (Bild an der verschobenen Stelle abgetastet) – so bleibt der Rand
 * so weich und so hell wie im Foto. Ausserhalb des Mondes bleibt das Grundbild; wo der Mond im Grundbild noch
 * davor stand, jetzt aber nicht mehr, kommt die Sonne aus dem anderen Bild O (dort ist sie frei, weil der Mond auf
 * seiner Bahn weiterzieht), in der Helligkeit angeglichen.
 */
function synthFrom(N: Rgba, O: Rgba, fN: MovieFrame, fO: MovieFrame, off: { x: number; y: number; r: number }): Uint8ClampedArray<ArrayBuffer> {
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
      const nCov = cov(Math.hypot(x - mN.cx, y - mN.cy), mN.r + 0.5 * ramp);
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
