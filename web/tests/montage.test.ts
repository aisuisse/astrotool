import { describe, expect, it } from "vitest";
import { layoutMontage, selectMontage, type MontageItem } from "../src/engine/montage";

const T0 = 638_000_000_000_000_000n;
const at = (sec: number, totality = false, hdr = false): MontageItem => ({ stamp: T0 + BigInt(Math.round(sec * 1e7)), totality, hdr });

describe("Phasenmontage: Auswahl", () => {
  it("verteilt partielle Phasen gleichmässig und setzt die Totalität in die Mitte", () => {
    // 60 partielle Bilder vor, 10 Totalitätsbilder (davon 2 HDR), 60 danach
    const items: MontageItem[] = [];
    for (let i = 0; i < 60; i++) items.push(at(i * 60));
    for (let i = 0; i < 10; i++) items.push(at(3700 + i * 10, true, i === 3 || i === 6));
    for (let i = 0; i < 60; i++) items.push(at(3900 + i * 60));
    const pick = selectMontage(items, 11);
    expect(pick.length).toBe(11);
    expect(pick[5]).toBeGreaterThanOrEqual(60);
    expect(pick[5]).toBeLessThan(70);
    expect(items[pick[5]].hdr).toBe(true); // HDR-Bild bevorzugt
    expect(pick.slice(0, 5).every((i) => i < 60)).toBe(true);
    expect(pick.slice(6).every((i) => i >= 70)).toBe(true);
    expect(pick[0]).toBe(0); // Anfang und Ende der Serie
    expect(pick[10]).toBe(129);
    for (let k = 1; k < pick.length; k++) expect(pick[k]).toBeGreaterThan(pick[k - 1]); // zeitlich geordnet
  });

  it("ohne Totalität: gleichmässig über die ganze Serie; nie mehr Bilder als vorhanden", () => {
    const items = Array.from({ length: 77 }, (_, i) => at(i * 42));
    const pick = selectMontage(items, 9);
    expect(pick).toEqual([0, 10, 19, 28, 38, 47, 57, 66, 76]);
    expect(selectMontage(items.slice(0, 4), 9).length).toBe(4);
  });

  it("eine Seite der Totalität zu kurz: die andere bekommt mehr Bilder", () => {
    const items = [at(0), at(100), at(500, true), at(600), at(700), at(800), at(900), at(1000), at(1100)];
    const pick = selectMontage(items, 7);
    expect(pick.length).toBe(7);
    expect(pick).toContain(2);
  });
});

describe("Phasenmontage: Anordnung", () => {
  it("Bogen: Mitte am höchsten, Scheiben berühren sich nicht", () => {
    const p = layoutMontage(11, "arc", 3840, 518 / 1080, true, true);
    expect(p.width).toBe(3840);
    const ys = p.tiles.map((t) => t.y);
    expect(Math.min(...ys)).toBe(ys[5]);
    expect(ys[0]).toBeCloseTo(ys[10], 6);
    for (let k = 1; k < 11; k++) expect(Math.hypot(p.tiles[k].x - p.tiles[k - 1].x, p.tiles[k].y - p.tiles[k - 1].y)).toBeGreaterThanOrEqual(p.disc);
    // Ausschnitt so skaliert, dass die Scheibe den vorgesehenen Durchmesser hat
    expect(p.tiles[0].size * (518 / 1080)).toBeCloseTo(p.disc, 6);
    for (const t of p.tiles) { expect(t.x - p.disc / 2).toBeGreaterThanOrEqual(0); expect(t.y + p.disc / 2).toBeLessThanOrEqual(p.height); }
  });
  it("Reihe und Raster passen in die Breite", () => {
    for (const layout of ["row", "grid"] as const) {
      const p = layoutMontage(13, layout, 2000, 0.5, false, true);
      for (const t of p.tiles) { expect(t.x + p.disc / 2).toBeLessThanOrEqual(2000); expect(t.y + p.disc / 2).toBeLessThanOrEqual(p.height); }
    }
  });
});

describe("Phasenmontage: Lücken in der Serie", () => {
  it("wählt bei einer Aufnahmepause keine Bilder doppelt aus derselben Minute", () => {
    // wie 12.08.2026: 3 Bilder um 19:33, dann 21 Minuten Pause, danach dichte Folge
    const items = [at(0), at(20), at(40), ...Array.from({ length: 74 }, (_, i) => at(1260 + i * 30))];
    const pick = selectMontage(items, 11);
    const firstThree = pick.filter((i) => i < 3).length;
    expect(firstThree).toBeLessThanOrEqual(2);
    expect(new Set(pick).size).toBe(11);
  });
});
