// Einfach-Modus zum Erleben: Sternenhimmel, eine gezeichnete Finsternis auf der Startseite, die Live-Ansicht der
// Verarbeitung (Foto mit gefundener Scheibe, Filmstreifen) und die Zeitleiste unter dem fertigen Film.
// Alles wird gezeichnet (Canvas) – keine Bilddateien. Für Handys: höchstens doppelte Pixeldichte, 30 Bilder je
// Sekunde, die Animation ruht, wenn sie nicht zu sehen ist; bei „Bewegung reduzieren“ steht sie still.

export type SkyKind = "solar" | "lunar";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** Reproduzierbare Zufallszahlen: Die Sterne stehen bei jedem Besuch gleich. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sternenhimmel über das ganze Fenster (steht still – einmal zeichnen, bei neuer Fenstergrösse wieder). */
export function drawSky(canvas: HTMLCanvasElement): void {
  const w = window.innerWidth, h = window.innerHeight, d = dpr();
  canvas.width = Math.round(w * d);
  canvas.height = Math.round(h * d);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(d, 0, 0, d, 0, 0);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#05080f");
  bg.addColorStop(0.55, "#0a0f1a");
  bg.addColorStop(1, "#0d1117");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const rnd = seeded(20270802);
  const n = Math.max(80, Math.min(420, Math.round((w * h) / 5200)));
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, big = rnd();
    const r = big > 0.97 ? 1.5 : big > 0.85 ? 1.0 : 0.6;
    const tint = rnd();
    g.globalAlpha = 0.25 + 0.65 * rnd() * (1 - 0.35 * (y / h));
    g.fillStyle = tint > 0.85 ? "#ffe2bd" : tint < 0.2 ? "#cfe0ff" : "#ffffff";
    g.beginPath();
    g.arc(x, y, r, 0, 2 * Math.PI);
    g.fill();
  }
  g.globalAlpha = 1;
}

/** Gezeichnete Finsternis für die Startseite: der Mond zieht vor der Sonne vorbei bzw. der Erdschatten über den Mond. */
export class Hero {
  private raf = 0;
  private kind: SkyKind = "solar";
  private shown = false;
  private last = 0;
  private readonly t0 = performance.now();
  private moonTex: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    document.addEventListener("visibilitychange", () => this.sync());
    window.addEventListener("resize", () => { if (this.shown) this.draw(this.time()); });
  }

  setKind(k: SkyKind): void {
    this.kind = k;
    if (this.shown) this.draw(this.time());
  }

  /** Animation nur, solange die Startseite zu sehen ist */
  show(on: boolean): void {
    this.shown = on;
    this.sync();
  }

  private time(): number {
    // ohne Bewegung: ein schöner Augenblick kurz vor der Totalität
    return reducedMotion() ? 7.1 : (performance.now() - this.t0) / 1000;
  }

  private sync(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.shown || document.hidden) return;
    this.draw(this.time());
    if (reducedMotion()) return;
    const loop = (now: number) => {
      if (now - this.last >= 33) {
        this.last = now;
        this.draw(this.time());
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private draw(t: number): void {
    const c = this.canvas, w = c.clientWidth, h = c.clientHeight, d = dpr();
    if (!w || !h) return;
    if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) {
      c.width = Math.round(w * d);
      c.height = Math.round(h * d);
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const R = Math.min(h * 0.24, w * 0.15);
    // ein Durchgang dauert 20 s; um die Mitte herum langsamer (dort ist am meisten zu sehen)
    const p = (t % 20) / 20, lin = 2 * p - 1;
    const s = Math.sign(lin) * Math.pow(Math.abs(lin), 1.7);
    if (this.kind === "solar") this.solar(g, w / 2, h / 2, R, s);
    else this.lunar(g, w / 2, h / 2, R, s);
  }

  private solar(g: CanvasRenderingContext2D, cx: number, cy: number, R: number, s: number): void {
    const mr = 1.035 * R;
    const ox = s * 2.6 * R, oy = -s * 0.32 * R;
    const dist = Math.hypot(ox, oy) / R;
    const covered = clamp01(1 - dist / 2.035);
    const total = smooth((0.13 - dist) / 0.09);
    // Lichtschein um die Sonne – nimmt ab, je mehr der Mond verdeckt
    const glow = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 3.4);
    const ga = 0.34 * (1 - 0.9 * covered * covered);
    glow.addColorStop(0, `rgba(255,196,110,${ga})`);
    glow.addColorStop(0.35, `rgba(255,150,60,${ga * 0.35})`);
    glow.addColorStop(1, "rgba(255,150,60,0)");
    g.fillStyle = glow;
    g.fillRect(cx - R * 3.4, cy - R * 3.4, R * 6.8, R * 6.8);
    if (total > 0) {
      // Korona: weicher Schein und ein paar Strahlen
      const mx = cx + ox, my = cy + oy;
      const cor = g.createRadialGradient(mx, my, R * 0.95, mx, my, R * 2.9);
      cor.addColorStop(0, `rgba(255,255,255,${0.75 * total})`);
      cor.addColorStop(0.18, `rgba(220,232,255,${0.3 * total})`);
      cor.addColorStop(1, "rgba(200,220,255,0)");
      g.fillStyle = cor;
      g.fillRect(mx - R * 3, my - R * 3, R * 6, R * 6);
      for (const [ang, len, a] of [[0.35, 3.3, 0.16], [2.2, 2.9, 0.13], [3.6, 3.5, 0.15], [5.3, 2.7, 0.12], [1.3, 2.4, 0.09]]) {
        g.save();
        g.translate(mx, my);
        g.rotate(ang);
        g.scale(len, 0.55);
        const ray = g.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
        ray.addColorStop(0, `rgba(235,242,255,${a * total})`);
        ray.addColorStop(1, "rgba(235,242,255,0)");
        g.fillStyle = ray;
        g.beginPath();
        g.arc(0, 0, R, 0, 2 * Math.PI);
        g.fill();
        g.restore();
      }
    }
    // Sonnenscheibe
    const sun = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    sun.addColorStop(0, "#fffbe9");
    sun.addColorStop(0.7, "#ffe9a8");
    sun.addColorStop(0.94, "#ffc152");
    sun.addColorStop(1, "#f28f24");
    g.fillStyle = sun;
    g.beginPath();
    g.arc(cx, cy, R, 0, 2 * Math.PI);
    g.fill();
    // Mond
    if (dist < 2.3) {
      g.fillStyle = "#04060b";
      g.beginPath();
      g.arc(cx + ox, cy + oy, mr, 0, 2 * Math.PI);
      g.fill();
      if (total > 0) {
        g.strokeStyle = `rgba(255,96,70,${0.55 * total})`;
        g.lineWidth = Math.max(1, R * 0.02);
        g.beginPath();
        g.arc(cx + ox, cy + oy, mr * 1.008, 0, 2 * Math.PI);
        g.stroke();
      }
    }
    // Diamantring: der letzte bzw. erste Sonnenstrahl am Mondrand
    const ring = smooth((dist - 0.035) / 0.03) * smooth((0.2 - dist) / 0.08);
    if (ring > 0 && dist > 1e-3) {
      const px = cx - (ox / (dist * R)) * R * 0.99, py = cy - (oy / (dist * R)) * R * 0.99;
      const dia = g.createRadialGradient(px, py, 0, px, py, R * 0.55);
      dia.addColorStop(0, `rgba(255,255,255,${ring})`);
      dia.addColorStop(0.12, `rgba(255,250,230,${0.75 * ring})`);
      dia.addColorStop(1, "rgba(255,240,200,0)");
      g.fillStyle = dia;
      g.fillRect(px - R * 0.55, py - R * 0.55, R * 1.1, R * 1.1);
    }
  }

  /** Vollmond mit ein paar Meeren – einmal gezeichnet, danach nur noch eingesetzt */
  private moonTexture(): HTMLCanvasElement {
    if (this.moonTex) return this.moonTex;
    const S = 256, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 1, 0, 2 * Math.PI);
    g.clip();
    const base = g.createRadialGradient(S * 0.42, S * 0.4, S * 0.05, S / 2, S / 2, S / 2);
    base.addColorStop(0, "#f6f3ea");
    base.addColorStop(0.8, "#d9d5c9");
    base.addColorStop(1, "#b9b5aa");
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    g.fillStyle = "rgba(92,96,108,0.32)";
    for (const [x, y, rx, ry, rot] of [[0.36, 0.3, 0.17, 0.13, 0.3], [0.6, 0.27, 0.12, 0.1, -0.4], [0.3, 0.52, 0.11, 0.16, 0.2], [0.66, 0.47, 0.13, 0.09, 0.5], [0.52, 0.62, 0.09, 0.07, 0], [0.42, 0.74, 0.06, 0.05, 0.2]]) {
      g.beginPath();
      g.ellipse(x * S, y * S, rx * S, ry * S, rot, 0, 2 * Math.PI);
      g.fill();
    }
    g.fillStyle = "rgba(255,255,255,0.35)";
    for (const [x, y, r] of [[0.58, 0.78, 0.03], [0.28, 0.68, 0.018], [0.74, 0.62, 0.014]]) {
      g.beginPath();
      g.arc(x * S, y * S, r * S, 0, 2 * Math.PI);
      g.fill();
    }
    this.moonTex = c;
    return c;
  }

  private lunar(g: CanvasRenderingContext2D, cx: number, cy: number, R: number, s: number): void {
    const U = 2.7 * R;
    const ux = cx + s * (U + R) * 1.12, uy = cy + s * 0.35 * R + 0.25 * R;
    const depth = clamp01((U + R - Math.hypot(ux - cx, uy - cy)) / (2 * R)); // 0 = frei, 1 = ganz im Kernschatten
    // Lichtschein des Vollmonds
    const ga = 0.22 * (1 - 0.92 * depth);
    const glow = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 3);
    glow.addColorStop(0, `rgba(226,232,255,${ga})`);
    glow.addColorStop(1, "rgba(226,232,255,0)");
    g.fillStyle = glow;
    g.fillRect(cx - R * 3, cy - R * 3, R * 6, R * 6);
    g.drawImage(this.moonTexture(), cx - R, cy - R, 2 * R, 2 * R);
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, 2 * Math.PI);
    g.clip();
    // Halbschatten: leichte Abdunklung, dann der kupferrote Kernschatten mit weichem Rand
    const pen = g.createRadialGradient(ux, uy, U, ux, uy, U * 1.45);
    pen.addColorStop(0, "rgba(10,8,14,0.5)");
    pen.addColorStop(1, "rgba(10,8,14,0)");
    g.fillStyle = pen;
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const um = g.createRadialGradient(ux, uy, U * 0.55, ux, uy, U * 1.03);
    um.addColorStop(0, "rgba(58,12,6,0.93)");
    um.addColorStop(0.8, "rgba(112,34,12,0.88)");
    um.addColorStop(0.95, "rgba(150,62,24,0.8)");
    um.addColorStop(1, "rgba(150,62,24,0)");
    g.fillStyle = um;
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    g.restore();
  }
}

export interface AnalysedPeek { bitmap: ImageBitmap | null; disc?: { x: number; y: number; r: number } | null; ok: boolean; label: string }
export interface FilmThumb { bitmap: ImageBitmap; clock: string; k: number }

/** Live-Ansicht während der Verarbeitung: grosses Bild, Hinweis darunter, Streifen mit allen bisherigen Bildern. */
export class LiveView {
  private thumbs: FilmThumb[] = [];
  private flipTimer = 0;
  private flipAt = 0;
  private stripPhase: "analyse" | "write" = "analyse";

  constructor(
    private readonly stage: HTMLCanvasElement,
    private readonly badge: HTMLElement,
    private readonly strip: HTMLElement,
  ) {}

  reset(): void {
    this.stopFlip();
    for (const t of this.thumbs) t.bitmap.close();
    this.thumbs = [];
    this.strip.replaceChildren();
    this.stripPhase = "analyse";
    this.badge.textContent = "";
    this.badge.className = "liveBadge";
    const g = this.stage.getContext("2d");
    g?.clearRect(0, 0, this.stage.width, this.stage.height);
  }

  /** Zeichenfläche in Gerätepunkten; liefert Kontext und Grösse in CSS-Punkten */
  private begin(): { g: CanvasRenderingContext2D; w: number; h: number } | null {
    const c = this.stage, w = c.clientWidth, h = c.clientHeight, d = dpr();
    if (!w || !h) return null;
    if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) {
      c.width = Math.round(w * d);
      c.height = Math.round(h * d);
    }
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  private chip(draw: (g: CanvasRenderingContext2D, size: number) => void, cls: string, title: string): void {
    const size = 56, d = dpr();
    const c = document.createElement("canvas");
    c.width = c.height = Math.round(size * d);
    c.className = `liveChip ${cls}`;
    c.title = title;
    const g = c.getContext("2d");
    if (g) {
      g.setTransform(d, 0, 0, d, 0, 0);
      draw(g, size);
    }
    this.strip.appendChild(c);
    // bei sehr langen Serien die ältesten Bildchen fallen lassen
    while (this.strip.childElementCount > 400) this.strip.firstElementChild?.remove();
    this.strip.scrollLeft = this.strip.scrollWidth;
  }

  /** Ein Foto wurde untersucht: zeigen, mit Kreis um die gefundene Scheibe */
  analysed(p: AnalysedPeek): void {
    this.badge.textContent = p.label;
    this.badge.className = `liveBadge ${p.ok ? "ok" : "bad"}`;
    const b = p.bitmap;
    if (!b) return;
    const s = this.begin();
    if (s) {
      const { g, w, h } = s;
      const k = Math.min(w / b.width, h / b.height), dw = b.width * k, dh = b.height * k, x0 = (w - dw) / 2, y0 = (h - dh) / 2;
      g.drawImage(b, x0, y0, dw, dh);
      if (p.disc) {
        const cx = x0 + p.disc.x * dw, cy = y0 + p.disc.y * dh, r = Math.max(6, p.disc.r * dw);
        g.lineWidth = 2;
        g.strokeStyle = p.ok ? "#58d68d" : "#ff7b6b";
        if (!p.ok) g.setLineDash([6, 5]);
        g.shadowColor = "rgba(0,0,0,0.8)";
        g.shadowBlur = 4;
        g.beginPath();
        g.arc(cx, cy, r + 4, 0, 2 * Math.PI);
        g.stroke();
        g.setLineDash([]);
        g.shadowBlur = 0;
      }
    }
    // Bildchen: die gefundene Scheibe herangeholt – oder das ganze Foto, wenn nichts gefunden wurde
    const disc = p.disc;
    this.chip((g, size) => {
      if (disc && disc.r * b.width >= 3) {
        const side = Math.min(b.width, b.height, 3 * disc.r * b.width);
        g.drawImage(b, disc.x * b.width - side / 2, disc.y * b.height - side / 2, side, side, 0, 0, size, size);
      } else {
        const side = Math.min(b.width, b.height);
        g.drawImage(b, (b.width - side) / 2, (b.height - side) / 2, side, side, 0, 0, size, size);
      }
    }, p.ok ? "ok" : "bad", p.label);
    b.close();
  }

  /** Ein zentriertes Bild für den Film ist fertig */
  written(t: { bitmap: ImageBitmap | null; clock: string; k: number }): void {
    if (this.stripPhase === "analyse") {
      // ab jetzt zeigt der Streifen den Film: die aussortierten Fotos sind nicht mehr dabei
      this.strip.replaceChildren();
      this.stripPhase = "write";
    }
    this.badge.textContent = t.clock;
    this.badge.className = "liveBadge";
    const b = t.bitmap;
    if (!b) return;
    this.thumbs.push({ bitmap: b, clock: t.clock, k: t.k });
    this.show(b);
    this.chip((g, size) => g.drawImage(b, 0, 0, size, size), "", t.clock);
  }

  private show(b: ImageBitmap): void {
    const s = this.begin();
    if (!s) return;
    const k = Math.min(s.w / b.width, s.h / b.height), dw = b.width * k, dh = b.height * k;
    s.g.drawImage(b, (s.w - dw) / 2, (s.h - dh) / 2, dw, dh);
  }

  /** Während der Film kodiert wird: die fertigen Bilder als Daumenkino */
  startFlip(): void {
    if (this.flipTimer || this.thumbs.length < 2 || reducedMotion()) return;
    this.flipAt = 0;
    this.flipTimer = window.setInterval(() => {
      const t = this.thumbs[this.flipAt % this.thumbs.length];
      this.flipAt++;
      this.show(t.bitmap);
      this.badge.textContent = t.clock;
    }, 110);
  }

  stopFlip(): void {
    clearInterval(this.flipTimer);
    this.flipTimer = 0;
  }

  /** Bilder für die Zeitleiste übergeben (die Live-Ansicht gibt sie ab) */
  take(): FilmThumb[] {
    this.stopFlip();
    const t = this.thumbs;
    this.thumbs = [];
    return t;
  }
}

/**
 * Zeitleiste unter dem Film: ein Bildchen je Foto; ein Tipp springt im Film dorthin, beim Abspielen wandert die
 * Markierung mit. marks[k] = Filmzeit des Fotos k in Sekunden (-1 = nicht einzeln zu sehen).
 */
export function buildTimeline(root: HTMLElement, video: HTMLVideoElement, thumbs: FilmThumb[], marks: number[]): void {
  root.replaceChildren();
  const items = thumbs.filter((t) => (marks[t.k] ?? -1) >= 0).sort((a, b) => marks[a.k] - marks[b.k]);
  root.hidden = items.length < 2;
  if (items.length < 2) return;
  const d = dpr(), size = 56;
  const buttons: HTMLButtonElement[] = [];
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tlItem";
    const c = document.createElement("canvas");
    c.width = c.height = Math.round(size * d);
    const g = c.getContext("2d");
    if (g) {
      g.setTransform(d, 0, 0, d, 0, 0);
      g.drawImage(it.bitmap, 0, 0, size, size);
    }
    const label = document.createElement("span");
    label.textContent = it.clock.slice(0, 5);
    b.title = it.clock;
    b.append(c, label);
    b.addEventListener("click", () => {
      video.currentTime = marks[it.k] + 0.02;
    });
    root.appendChild(b);
    buttons.push(b);
  }
  let current = -1;
  const follow = () => {
    let k = 0;
    for (let i = 0; i < items.length; i++) if (marks[items[i].k] <= video.currentTime + 0.05) k = i;
    if (k === current) return;
    buttons[current]?.classList.remove("on");
    buttons[k].classList.add("on");
    current = k;
    // Markierung im Blick halten, ohne die ganze Seite zu verschieben
    const el = buttons[k], left = el.offsetLeft - root.clientWidth / 2 + el.clientWidth / 2;
    root.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  video.addEventListener("timeupdate", follow);
  video.addEventListener("seeked", follow);
  follow();
}

/** Bildschirm wach halten, solange gerechnet wird (Handy) – liefert eine Funktion zum Freigeben */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen");
    return () => { void lock?.release().catch(() => {}); };
  } catch {
    return () => {};
  }
}
