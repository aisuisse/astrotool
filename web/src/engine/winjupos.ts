// Dateinamen, die WinJUPOS direkt versteht (für die Derotation von Jupiter, Saturn, Mars).
// WinJUPOS liest Datum und Uhrzeit (UT) am Anfang des Namens: "JJJJ-MM-TT-HHMM_Z", Z = Zehntelminute
// (6 Sekunden). Danach folgen frei wählbare Teile, üblich sind Beobachterkürzel und Filter/Objekt,
// je mit "-" getrennt – z. B. "2022-10-25-0055_2-JS-Jup-RGB.ser" (wie FireCapture).
// Eigenständige Umsetzung; PIPP hat dafür die Schalter -wjpos_* (Option „WinJUPOS Compatible Filenames“).

export interface WinJuposOptions {
  /** Ausgabedateien nach WinJUPOS benennen */
  winjupos: boolean;
  /** Beobachterkürzel, z. B. "JS" (leer = weglassen) */
  wjObserver: string;
  /** Weitere Angabe, z. B. "Jup-RGB" (leer = weglassen) */
  wjInfo: string;
  /** Welche Zeit ein Video (SER) im Namen trägt: Beginn, Mitte oder Ende der Aufnahme */
  wjTime: "start" | "mid" | "end";
  /** Zeit verschieben (Minuten), z. B. falsch gestellte Kamerauhr oder Ortszeit im Dateinamen */
  wjShiftMinutes: number;
}

export const defaultWinJupos: WinJuposOptions = { winjupos: false, wjObserver: "", wjInfo: "", wjTime: "mid", wjShiftMinutes: 0 };

const TENTH = 6000; // Zehntelminute in ms

/** "JJJJ-MM-TT-HHMM_Z" in UT; auf die nächste Zehntelminute gerundet (auch über Stunden- und Tagesgrenzen). */
export function winjuposStamp(ms: number): string {
  const d = new Date(Math.round(ms / TENTH) * TENTH);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const tenth = Math.floor(d.getUTCSeconds() / 6);
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}_${tenth}`;
}

/** Für Dateinamen ungeeignete Zeichen entfernen; "-" bleibt (trennt die Teile, z. B. "Jup-RGB"). */
function clean(s: string): string {
  return (s ?? "").trim().replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^[-_.]+|[-_.]+$/g, "");
}

/** Name ohne Endung: Zeit, dann Beobachter und Angabe (je nur, wenn gesetzt). */
export function winjuposName(ms: number, o: Pick<WinJuposOptions, "wjObserver" | "wjInfo">): string {
  return [winjuposStamp(ms), clean(o.wjObserver), clean(o.wjInfo)].filter(Boolean).join("-");
}

/** Zeit für ein Video aus Beginn und Ende (ms, UT) – ohne Verschiebung. */
export function seriesTime(start: number, end: number, mode: WinJuposOptions["wjTime"]): number {
  if (mode === "start") return start;
  if (mode === "end") return end;
  return start + (end - start) / 2;
}

/** Verschiebung in ms */
export function shiftMs(o: Pick<WinJuposOptions, "wjShiftMinutes">): number {
  const m = Number(o.wjShiftMinutes);
  return isFinite(m) ? m * 60_000 : 0;
}

/**
 * Aufnahmezeit aus einem Dateinamen (ms seit 1970, als UT gelesen), sonst null. Erkannt werden:
 * - WinJUPOS/FireCapture: 2022-10-25-0055_2 (Zehntelminute), auch 2022-10-25-005512
 * - 2022-10-25T00:55:12, 2022-10-25_00-55-12, 2022-10-25 00_55_12 (SharpCap, Siril …)
 * - 20221025_005512, 20221025-005512 (Kameras, Handys)
 */
export function timeFromName(name: string): number | null {
  const n = name.replace(/\.[^.]+$/, "");
  const mk = (y: string, mo: string, d: string, h: string, mi: string, s: number) => {
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, 0) + s * 1000;
    const dt = new Date(t);
    // ungültige Angaben (Monat 13, 25 Uhr …) verwerfen
    if (dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d || +h > 23 || +mi > 59 || s >= 60 || +y < 1900) return null;
    return t;
  };
  let m = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})_(\d)(?![0-9])/.exec(n);
  if (m) return mk(m[1], m[2], m[3], m[4], m[5], +m[6] * 6);
  m = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?![0-9])/.exec(n);
  if (m) return mk(m[1], m[2], m[3], m[4], m[5], +m[6]);
  m = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})[T _-](\d{2})[:_.-](\d{2})[:_.-](\d{2})(?:[.,](\d{1,3}))?(?![0-9])/.exec(n);
  if (m) {
    const t = mk(m[1], m[2], m[3], m[4], m[5], +m[6]);
    return t === null ? null : t + (m[7] ? Math.round(+`0.${m[7]}` * 1000) : 0);
  }
  m = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?![0-9])/.exec(n);
  if (m) return mk(m[1], m[2], m[3], m[4], m[5], +m[6]);
  return null;
}
