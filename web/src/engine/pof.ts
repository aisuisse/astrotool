// Import von PIPP-Optionsdateien (*.pof). Aufbau aus der Analyse von PIPP.exe:
// erste Zeile "[PIPP OPTIONS FILE]", danach je Zeile "SCHLÜSSEL Wert".
// Die Werte-Schreibweise (True/False vs. 1/0) ist noch nicht an echten Dateien bestätigt – daher tolerant.
import type { ProcessOptions } from "./pipeline";
import { msg } from "../i18n";

export function parsePof(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.trim().startsWith("[PIPP OPTIONS FILE]")) throw new Error(msg("notPof"));
  const m = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    if (sp < 0) m.set(t, "");
    else m.set(t.slice(0, sp), t.slice(sp + 1).trim());
  }
  return m;
}

const bool = (v: string | undefined) => v !== undefined && /^(true|1|yes|on)$/i.test(v);
const num = (v: string | undefined) => (v === undefined || v === "" || isNaN(Number(v)) ? undefined : Number(v));

/** Übernimmt die bekannten Einstellungen. Gibt die nicht unterstützten Schlüssel zurück. */
export function applyPof(base: ProcessOptions, pof: Map<string, string>): { options: ProcessOptions; ignored: string[] } {
  const o: ProcessOptions = structuredClone(base);
  const used = new Set<string>();
  const get = (k: string) => {
    used.add(k);
    return pof.get(k);
  };
  if (pof.has("CHECK_PLANET")) o.checkObject = bool(get("CHECK_PLANET"));
  o.minObjectSize = num(get("MIN_PLANET_SIZE")) ?? o.minObjectSize;
  if (pof.has("AUTO_THRESHOLD") && bool(get("AUTO_THRESHOLD"))) o.threshold = null;
  else if (num(pof.get("THRESHOLD")) !== undefined) o.threshold = num(get("THRESHOLD"))! / 255;
  if (pof.has("CENTRE_PLANET")) o.centre = bool(get("CENTRE_PLANET"));
  if (pof.has("ENABLE_CROP")) o.cropEnabled = bool(get("ENABLE_CROP"));
  o.cropWidth = num(get("CROP_WIDTH")) ?? o.cropWidth;
  o.cropHeight = num(get("CROP_HEIGHT")) ?? o.cropHeight;
  o.offsetX = num(get("X_OFFSET")) ?? o.offsetX;
  o.offsetY = num(get("Y_OFFSET")) ?? o.offsetY;
  if (pof.has("ENABLE_QUALITY")) o.qualityEnabled = bool(get("ENABLE_QUALITY"));
  if (pof.has("QUALITY_REORDER")) o.reorder = bool(get("QUALITY_REORDER"));
  o.quality.qmin = num(get("QMIN")) ?? o.quality.qmin;
  o.quality.qmax = num(get("QMAX")) ?? o.quality.qmax;
  o.quality.qinc = num(get("QINC")) ?? o.quality.qinc;
  if (bool(get("HISTO_QUALITY"))) o.quality.method = "histogram";
  if (bool(get("TOTALPIXEL_QUALITY"))) o.quality.method = "brightness";
  get("DEFAULT_QUALITY");
  get("NINOX_QUALITY");
  if (pof.has("QUALITY_LIMITING")) {
    const limit = bool(get("QUALITY_LIMITING"));
    const type = num(get("QUALITY__LIMITING_TYPE")) ?? 0;
    o.keepMode = !limit ? "all" : type === 1 ? "percent" : "count";
    o.keepValue = num(get("QUALITY_FRAMES")) ?? o.keepValue;
  }
  // Debayer. Zahlencodes wie beim Schalter -db= (0 GBRG, 1 BGGR, 2 RGGB, 3 GRBG) – an echten .pof-Dateien noch unbestätigt.
  if (pof.has("DEBAYER_ENABLED")) {
    const on = bool(get("DEBAYER_ENABLED"));
    const pat = (["GBRG", "BGGR", "RGGB", "GRBG"] as const)[num(get("DEBAYER_PATTERN")) ?? -1];
    o.debayer = on ? pat ?? "auto" : "off";
    o.debayerSer = on;
  }
  if (bool(get("PROTECT_BAYER"))) { o.debayer = "off"; o.debayerSer = false; }
  get("DEBAYER_TYPE"); // bilinear / Smooth Hue – Astrotool rechnet bilinear
  const ignored = [...pof.keys()].filter((k) => !used.has(k));
  return { options: o, ignored };
}
