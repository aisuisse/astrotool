import { describe, expect, it } from "vitest";
import { groupBatch } from "../src/batchgroups";

const pick = (...paths: string[]) => paths.map((path) => ({ file: path, path }));
const names = (paths: string[]) => groupBatch(pick(...paths)).map((i) => ({ name: i.name, kind: i.kind, files: i.files }));

describe("Stapel aus Ordnern", () => {
  it("Unterordner mit Bildern werden je eine Bildserie, nach Namen sortiert (Zahlen der Grösse nach)", () => {
    expect(names(["Abend/Serie10/b.jpg", "Abend/Serie2/IMG_10.jpg", "Abend/Serie2/IMG_9.jpg", "Abend/Serie10/a.jpg"])).toEqual([
      { name: "Serie2", kind: "images", files: ["Abend/Serie2/IMG_9.jpg", "Abend/Serie2/IMG_10.jpg"] },
      { name: "Serie10", kind: "images", files: ["Abend/Serie10/a.jpg", "Abend/Serie10/b.jpg"] },
    ]);
  });

  it("Videos sind je eine Aufnahme, auch neben Bildserien", () => {
    expect(names(["Nacht/Jupiter_1.ser", "Nacht/Mond/m1.png", "Nacht/Mond/m2.png", "Nacht/Saturn/s.avi"])).toEqual([
      { name: "Jupiter_1.ser", kind: "video", files: ["Nacht/Jupiter_1.ser"] },
      { name: "Mond", kind: "images", files: ["Nacht/Mond/m1.png", "Nacht/Mond/m2.png"] },
      { name: "Saturn_s.avi", kind: "video", files: ["Nacht/Saturn/s.avi"] },
    ]);
  });

  it("tiefere Ordner: Pfad mit _ als Name; Bilder im gewählten Ordner selbst heissen wie er", () => {
    expect(names(["Finsternis/C1.jpg", "Finsternis/Teil/A/x.cr2", "Finsternis/Teil/B/y.fits.fz"]).map((i) => i.name)).toEqual(["Finsternis", "Teil_A", "Teil_B"]);
  });

  it("andere und versteckte Dateien werden übergangen", () => {
    expect(names(["A/S1/a.jpg", "A/S1/Thumbs.db", "A/S1/notes.txt", "A/S1/._a.jpg", "A/.cache/z.png", "A/S2/run.pof", "A/S2/b.tif"])).toEqual([
      { name: "S1", kind: "images", files: ["A/S1/a.jpg"] },
      { name: "S2", kind: "images", files: ["A/S2/b.tif"] },
    ]);
  });

  it("mehrere hineingezogene Ordner und lose Bilder (ohne gemeinsamen Ordner)", () => {
    expect(names(["/Serie1/a.jpg", "/Serie2/b.jpg", "/IMG_5.jpg"]).map((i) => i.name)).toEqual(["IMG_5", "Serie1", "Serie2"]);
  });

  it("ein Ordner ohne Unterordner ist eine einzige Bildserie", () => {
    expect(groupBatch(pick("Serie/1.jpg", "Serie/2.jpg", "Serie/3.jpg"))).toHaveLength(1);
  });

  it("Windows-Pfade mit Backslash", () => {
    expect(names(["Abend\\S1\\a.jpg", "Abend\\S2\\b.jpg"]).map((i) => i.name)).toEqual(["S1", "S2"]);
  });
});
