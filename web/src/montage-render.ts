// Phasenmontage zeichnen (läuft im Worker): gesammelte Ausschnitte auf schwarzem Grund, mit „Aufhellen“ überlagert,
// damit sich die schwarzen Ränder benachbarter Bilder nicht verdecken; Uhrzeit darunter, Titel oben.
import type { Frame } from "./engine/ser";
import { layoutMontage, selectMontage, type MontageOptions } from "./engine/montage";
import { ticksToClock } from "./engine/timelapse";
import { frameToRGBA8 } from "./timelapse-encode";

export interface MontageResult {
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
  frames: number;
}

interface Stored {
  blob: Blob;
  stamp?: bigint;
  totality: boolean;
  hdr: boolean;
}

/** Sammelt die fertigen Ausschnitte (verkleinert auf höchstens 720 px, als PNG) für die Montage. */
export class MontageRecorder {
  private items: Stored[] = [];
  private discs: number[] = [];
  private crop = 0;

  /** discDiameter: Durchmesser der Scheibe im Ausschnitt (Pixel), falls bekannt */
  async add(f: Frame, stamp: bigint | undefined, info: { totality: boolean; hdr: boolean; discDiameter?: number }): Promise<void> {
    const scale = Math.min(1, 720 / Math.max(f.width, f.height));
    const w = Math.max(1, Math.round(f.width * scale)), h = Math.max(1, Math.round(f.height * scale));
    const full = new OffscreenCanvas(f.width, f.height);
    full.getContext("2d")!.putImageData(new ImageData(frameToRGBA8(f), f.width, f.height), 0, 0);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(full, 0, 0, w, h);
    this.items.push({ blob: await c.convertToBlob({ type: "image/png" }), stamp, totality: info.totality, hdr: info.hdr });
    this.crop = Math.max(f.width, f.height);
    if (info.discDiameter && !info.totality) this.discs.push(info.discDiameter);
  }

  get count(): number {
    return this.items.length;
  }

  async render(o: MontageOptions, baseName: string): Promise<MontageResult> {
    const pick = selectMontage(this.items, o.count);
    // Anteil der Sonnenscheibe am Ausschnitt (Median der partiellen Phasen), sonst 90 %
    const sorted = [...this.discs].sort((a, b) => a - b);
    const frac = sorted.length && this.crop ? sorted[sorted.length >> 1] / this.crop : 0.9;
    const plan = layoutMontage(pick.length, o.layout, o.width, frac, !!o.title, o.showTime);
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, plan.width, plan.height);
    g.imageSmoothingQuality = "high";
    g.globalCompositeOperation = "lighten";
    const discFrac = plan.disc / plan.tiles[0].size;
    for (let k = 0; k < pick.length; k++) {
      const t = plan.tiles[k];
      const bmp = await createImageBitmap(this.items[pick[k]].blob);
      const tile = cleanTile(bmp, discFrac, this.items[pick[k]].totality);
      bmp.close();
      g.drawImage(tile, t.x - t.size / 2, t.y - t.size / 2, t.size, t.size);
    }
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#e8ecf2";
    g.textBaseline = "alphabetic";
    if (o.showTime) {
      g.font = `500 ${plan.font}px system-ui, "Segoe UI", sans-serif`;
      g.textAlign = "center";
      for (let k = 0; k < pick.length; k++) {
        const clock = ticksToClock(this.items[pick[k]].stamp);
        if (!clock) continue;
        const t = plan.tiles[k];
        g.fillText(clock.slice(0, 5), t.x, t.y + plan.disc / 2 + plan.font * 1.6);
      }
    }
    if (o.title) {
      g.font = `600 ${Math.round(plan.font * 1.5)}px system-ui, "Segoe UI", sans-serif`;
      g.textAlign = "left";
      g.fillText(o.title, plan.width * 0.03, plan.width * 0.03 + plan.font * 1.5);
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, fileName: `${baseName}_montage.png`, width: plan.width, height: plan.height, frames: pick.length };
  }
}

/**
 * Ausschnitt für die Montage aufbereiten: Himmel (Median der vier Ecken je Farbe) abziehen, damit er schwarz wird,
 * und den Rand weich ausblenden – sonst zeichnen sich beim Überlagern die Rechtecke der Ausschnitte ab.
 * discFrac: Anteil der Scheibe an der Kantenlänge. In der Totalität bleibt mehr Raum für die Korona.
 */
function cleanTile(bmp: ImageBitmap, discFrac: number, totality: boolean): OffscreenCanvas {
  const w = bmp.width, h = bmp.height;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const corner = Math.max(4, Math.round(Math.min(w, h) * 0.06));
  const bg = [0, 1, 2].map((ch) => {
    const v: number[] = [];
    for (const [x0, y0] of [[0, 0], [w - corner, 0], [0, h - corner], [w - corner, h - corner]])
      for (let y = y0; y < y0 + corner; y += 2) for (let x = x0; x < x0 + corner; x += 2) v.push(d[(y * w + x) * 4 + ch]);
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const cx = w / 2, cy = h / 2, rDisc = (discFrac * w) / 2;
  const r0 = rDisc * (totality ? 1.6 : 1.12), r1 = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = Math.hypot(x - cx, y - cy);
      const a = r <= r0 ? 1 : r >= r1 ? 0 : 1 - (r - r0) / Math.max(1, r1 - r0);
      for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.max(0, d[i + ch] - bg[ch]) * a;
    }
  // Partielle Phasen gleich hell: hellste Stellen der Scheibe (99.5 %) auf etwa 235 strecken, höchstens 8-fach.
  // So verschwinden dunkle Sicheln (Dunst, Wolken) nicht neben hellen. Die Totalität bleibt, wie sie ist.
  if (!totality) {
    const v: number[] = [];
    for (let i = 0; i < d.length; i += 4 * 3) v.push(Math.max(d[i], d[i + 1], d[i + 2]));
    v.sort((a, b) => a - b);
    const top = v[Math.floor(v.length * 0.995)];
    const gain = top > 0 ? Math.min(8, 235 / top) : 1;
    if (gain > 1.05) for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, d[i + ch] * gain);
  }
  g.putImageData(img, 0, 0);
  return c;
}

