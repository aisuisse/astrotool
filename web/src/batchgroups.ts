// Stapel: gewählte oder hineingezogene Dateien in Aufnahmen aufteilen.
// Jedes Video (SER, AVI, MP4 …) ist eine Aufnahme; Bilder bilden je Ordner eine Bildserie.

/** Eine Datei mit ihrem Pfad relativ zum gewählten Ordner ("Abend/Serie1/IMG_1.jpg"); ohne Ordner nur der Name */
export interface PickedFile<F = File> {
  file: F;
  path: string;
}

/** Eine Aufnahme im Stapel: ein Video oder alle Bilder eines Ordners */
export interface BatchItem<F = File> {
  /** Anzeige- und Ausgabename (Dateiname des Videos oder Ordnerpfad, mit "_" statt "/") */
  name: string;
  files: F[];
  kind: "video" | "images";
}

export const VIDEO_RE = /\.(ser|avi|mp4|m4v|mov|mkv|webm)$/i;
export const IMAGE_RE = /\.(jpe?g|png|tiff?|webp|bmp|hei[cf]|fits?|fts|fz|nef|nrw|cr2|cr3|arw|dng|raf|orf|rw2|pef|srw)$/i;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** versteckte Dateien und Ordner (".", Mac "._") überspringen */
const hidden = (p: string) => p.split("/").some((s) => s.startsWith("."));

/**
 * Dateien in Aufnahmen aufteilen. Ein Video ist eine Aufnahme; Bilder werden nach ihrem Ordner gruppiert.
 * Andere Dateien (Protokolle, .pof, Thumbs.db …) werden übergangen. Reihenfolge: nach Pfad, Zahlen der Grösse nach.
 */
export function groupBatch<F>(picked: PickedFile<F>[]): BatchItem<F>[] {
  const ok = picked
    .map((p) => ({ ...p, path: p.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((p) => !hidden(p.path) && (VIDEO_RE.test(p.path) || IMAGE_RE.test(p.path)));
  const dirs = ok.map((p) => p.path.split("/").slice(0, -1));
  // gemeinsamen Anfang aller Ordner weglassen (der gewählte Ordner selbst)
  let common = dirs.length ? dirs[0].length : 0;
  for (const d of dirs) {
    let i = 0;
    while (i < common && i < d.length && d[i] === dirs[0][i]) i++;
    common = i;
  }
  const rootName = common ? dirs[0][common - 1] : "";
  const videos: { key: string; item: BatchItem<F> }[] = [];
  const groups = new Map<string, { name: string; entries: { file: F; name: string }[] }>();
  ok.forEach((p, i) => {
    const rel = dirs[i].slice(common).join("/");
    if (VIDEO_RE.test(p.path)) {
      const key = rel ? `${rel}/${baseOf(p.path)}` : baseOf(p.path);
      videos.push({ key, item: { name: key.replace(/\//g, "_"), files: [p.file], kind: "video" } });
      return;
    }
    let g = groups.get(rel);
    if (!g) groups.set(rel, (g = { name: rel ? rel.replace(/\//g, "_") : rootName, entries: [] }));
    g.entries.push({ file: p.file, name: baseOf(p.path) });
  });
  const all = [
    ...videos,
    ...[...groups].map(([key, g]) => {
      g.entries.sort((a, b) => byName(a.name, b.name));
      // Bilder ohne Ordner (neben Unterordnern hineingezogen): nach dem ersten Bild benannt
      const name = g.name || g.entries[0].name.replace(/\.[^.]+$/, "");
      return { key, item: { name, files: g.entries.map((e) => e.file), kind: "images" as const } };
    }),
  ];
  return all.sort((a, b) => byName(a.key, b.key)).map((x) => x.item);
}
