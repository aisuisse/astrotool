import { describe, expect, it } from "vitest";
import { dictionaries, isLang, LANG_NAMES, LANGS, LOCALES, pickLang, t, tr, type I18nKey } from "../src/i18n";

const keys = Object.keys(dictionaries.en) as I18nKey[];
const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (s: string) => [...s.matchAll(/<[^>]+>|&[a-z]+;/g)].map((m) => m[0]).sort().join(" ");

describe("Sprachen", () => {
  it("sechs Sprachen, jede mit Namen und Schreibweise für Zahlen", () => {
    expect(LANGS).toEqual(["en", "de", "es", "pt", "it", "bg"]);
    for (const l of LANGS) {
      expect(LANG_NAMES[l].length).toBeGreaterThan(3);
      expect(() => (1234.5).toLocaleString(LOCALES[l])).not.toThrow();
      expect(isLang(l)).toBe(true);
    }
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
  });

  it("jede Sprache hat dieselben Texte wie Englisch – keiner leer", () => {
    for (const l of LANGS) {
      expect(Object.keys(dictionaries[l]), l).toEqual(keys);
      for (const k of keys) expect(dictionaries[l][k].trim().length, `${l} ${k}`).toBeGreaterThan(0);
    }
  });

  it("Platzhalter und HTML-Marken stimmen in jeder Sprache mit Englisch überein", () => {
    const wrong: string[] = [];
    for (const l of LANGS)
      for (const k of keys) {
        if (placeholders(dictionaries[l][k]) !== placeholders(dictionaries.en[k])) wrong.push(`${l} ${k}: Platzhalter`);
        if (tags(dictionaries[l][k]) !== tags(dictionaries.en[k])) wrong.push(`${l} ${k}: Marken`);
      }
    expect(wrong).toEqual([]);
  });

  it("die neuen Sprachen sind wirklich übersetzt (nicht der englische Text)", () => {
    for (const l of ["es", "pt", "it", "bg"] as const) {
      const same = keys.filter((k) => dictionaries[l][k] === dictionaries.en[k] && /[a-z]{4}/i.test(dictionaries.en[k]));
      // gleich bleiben nur Namen und Fachwörter (Formate, „Bias“, „Gamma“ …)
      expect(same.length, `${l}: ${same.join(", ")}`).toBeLessThan(keys.length * 0.06);
    }
    // Bulgarisch steht in kyrillischer Schrift
    const cyr = keys.filter((k) => /[а-я]/i.test(dictionaries.bg[k]));
    expect(cyr.length).toBeGreaterThan(keys.length * 0.9);
  });

  it("Meldungen des Rechenteils werden in jeder Sprache eingesetzt", () => {
    for (const l of LANGS) {
      const text = tr(l, "@bloom|812|640");
      expect(text, l).toContain("812");
      expect(text, l).toContain("640");
      expect(text, l).not.toContain("@");
      expect(t(l, "easy.filmInfo", 24, 73, 77), l).toMatch(/24.*73.*77/);
    }
  });

  it("erster Besuch: die erste Sprache des Browsers, die es gibt – sonst Englisch", () => {
    expect(pickLang(["de-CH", "en"])).toBe("de");
    expect(pickLang(["pt-BR", "en-US"])).toBe("pt");
    expect(pickLang(["es-CL"])).toBe("es");
    expect(pickLang(["it"])).toBe("it");
    expect(pickLang(["bg-BG", "ru"])).toBe("bg");
    // Französisch gibt es nicht: die nächste Sprache der Liste gilt
    expect(pickLang(["fr-FR", "it-IT", "en"])).toBe("it");
    expect(pickLang(["fr", "ja"])).toBe("en");
    expect(pickLang([])).toBe("en");
    expect(pickLang(["", "EN_us"])).toBe("en");
  });
});
