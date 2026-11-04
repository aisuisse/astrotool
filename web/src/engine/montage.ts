// Phasenmontage einer Sonnenfinsternis: ausgewählte Bilder in einem Bild, als Bogen (wie der Weg der Sonne
// über den Himmel), als Reihe oder als Raster. Hier nur Auswahl und Anordnung (ohne DOM, testbar);
// gezeichnet wird im Worker (montage-render.ts).

export type MontageLayout = "arc" | "row" | "grid";

export interface MontageOptions {
  enabled: boolean;
  layout: MontageLayout;
  /** Anzahl der Bilder in der Montage */
  count: number;
  /** Uhrzeit unter jedem Bild */
  showTime: boolean;
  title: string;
  /** Breite des Montagebilds in Pixel */
  width: number;
}

export const defaultMontage: MontageOptions = { enabled: false, layout: "arc", count: 11, showTime: true, title: "", width: 3840 };

export interface MontageItem {
  /** Aufnahmezeit (100-ns-Ticks) oder undefined */
  stamp?: bigint;
  /** Bild aus der Totalität */
  totality: boolean;
  /** zusammengefasste HDR-Belichtungsreihe */
  hdr: boolean;
}

/**
 * Achse für die Verteilung: halb Aufnahmezeit, halb Bildnummer (beide auf 0…1). Bei gleichmässig aufgenommenen
 * Serien ist das genau die Zeit; hat die Serie eine Lücke, wählt die reine Zeit sonst mehrmals die Bilder direkt
 * vor und nach der Lücke.
 */
function times(items: MontageItem[]): number[] {
  const n = items.length;
  const all = items.every((i) => i.stamp !== undefined && i.stamp > 0n);
  if (!all || n < 2) return items.map((_, k) => k);
  const sec = items.map((i) => Number(i.stamp! - items[0].stamp!) / 1e7);
  const order = sec.map((_, k) => k).sort((a, b) => sec[a] - sec[b]);
  const rank = new Array<number>(n);
  order.forEach((k, r) => (rank[k] = r / (n - 1)));
  const lo = Math.min(...sec), span = Math.max(...sec) - lo || 1;
  return sec.map((v, k) => 0.5 * ((v - lo) / span) + 0.5 * rank[k]);
}

/** Je Zielzeit das nächstgelegene noch freie Bild. */
function pickEven(cands: number[], t: number[], n: number, from: number, to: number, used: Set<number>): number[] {
  const out: number[] = [];
  if (n <= 0 || !cands.length) return out;
  for (let k = 0; k < n; k++) {
    const target = n === 1 ? (from + to) / 2 : from + ((to - from) * k) / (n - 1);
    let best = -1, bd = Infinity;
    for (const i of cands) {
      if (used.has(i)) continue;
      const d = Math.abs(t[i] - target);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) break;
    used.add(best);
    out.push(best);
  }
  return out;
}

/**
 * Bilder für die Montage (Indizes, zeitlich geordnet). Mit Totalität: ein Totalitätsbild in der Mitte (bevorzugt
 * ein HDR-Bild aus der Mitte der Totalität), davor und danach gleichmässig verteilte partielle Phasen.
 */
export function selectMontage(items: MontageItem[], count: number): number[] {
  const n = Math.max(1, Math.min(count, items.length));
  const t = times(items);
  const idx = items.map((_, k) => k).sort((a, b) => t[a] - t[b]);
  const used = new Set<number>();
  const tot = idx.filter((i) => items[i].totality);
  if (tot.length && n >= 3) {
    const tMid = (t[tot[0]] + t[tot[tot.length - 1]]) / 2;
    const pool = tot.some((i) => items[i].hdr) ? tot.filter((i) => items[i].hdr) : tot;
    const centre = pool.reduce((a, b) => (Math.abs(t[b] - tMid) < Math.abs(t[a] - tMid) ? b : a));
    used.add(centre);
    const before = idx.filter((i) => !items[i].totality && t[i] < t[tot[0]]);
    const after = idx.filter((i) => !items[i].totality && t[i] > t[tot[tot.length - 1]]);
    let nb = Math.floor((n - 1) / 2), na = n - 1 - nb;
    // eine Seite hat zu wenige Bilder: der anderen geben
    if (before.length < nb) { na += nb - before.length; nb = before.length; }
    if (after.length < na) { nb = Math.min(before.length, nb + na - after.length); na = after.length; }
    const b = before.length ? pickEven(before, t, nb, t[before[0]], t[before[before.length - 1]], used) : [];
    const a = after.length ? pickEven(after, t, na, t[after[0]], t[after[after.length - 1]], used) : [];
    return [...b, centre, ...a].sort((x, y) => t[x] - t[y]);
  }
  return pickEven(idx, t, n, t[idx[0]], t[idx[idx.length - 1]], used).sort((x, y) => t[x] - t[y]);
}

export interface MontageTile {
  /** Mitte der Scheibe im Montagebild */
  x: number;
  y: number;
  /** Kantenlänge, auf die der quadratische Ausschnitt skaliert wird */
  size: number;
}

export interface MontagePlan {
  width: number;
  height: number;
  /** Durchmesser der Sonnenscheibe im Montagebild */
  disc: number;
  tiles: MontageTile[];
  /** Schriftgrösse für Uhrzeit und Titel */
  font: number;
}

/**
 * Anordnung. discFraction = Durchmesser der Scheibe / Kantenlänge des Ausschnitts (z. B. 518 / 1080):
 * Die Scheiben werden so gross, dass sie sich knapp nicht berühren.
 */
export function layoutMontage(n: number, layout: MontageLayout, width: number, discFraction: number, titled: boolean, timed: boolean): MontagePlan {
  const W = Math.max(400, Math.round(width));
  const m = Math.round(W * 0.03);
  const frac = Math.min(1, Math.max(0.05, discFraction));
  const font = Math.round(W * 0.012);
  const top = m + (titled ? font * 2.4 : 0);
  const label = timed ? font * 2 : 0;
  const tiles: MontageTile[] = [];
  if (layout === "grid") {
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
    const rows = Math.ceil(n / cols);
    const cell = (W - 2 * m) / cols;
    const disc = cell * 0.86;
    const rowH = disc + label + cell * 0.1;
    for (let k = 0; k < n; k++) {
      const c = k % cols, r = Math.floor(k / cols);
      tiles.push({ x: m + cell * (c + 0.5), y: top + r * rowH + disc / 2, size: disc / frac });
    }
    return { width: W, height: Math.round(top + rows * rowH + m), disc, tiles, font };
  }
  const step = (W - 2 * m) / n;
  const disc = step * 0.9;
  if (layout === "row") {
    for (let k = 0; k < n; k++) tiles.push({ x: m + step * (k + 0.5), y: top + disc / 2, size: disc / frac });
    return { width: W, height: Math.round(top + disc + label + m), disc, tiles, font };
  }
  // Bogen: Parabel, Mitte am höchsten (wie die Sonne am Himmel)
  const rise = Math.max(disc * 1.2, W * 0.16);
  const H = Math.round(top + rise + disc + label + m);
  const yTop = top + disc / 2, yEnd = yTop + rise;
  for (let k = 0; k < n; k++) {
    const u = n === 1 ? 0.5 : k / (n - 1);
    tiles.push({ x: m + step * (k + 0.5), y: yEnd - (yEnd - yTop) * (1 - (2 * u - 1) ** 2), size: disc / frac });
  }
  return { width: W, height: H, disc, tiles, font };
}
