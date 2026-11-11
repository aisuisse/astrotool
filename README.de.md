# Astrotool

[English](README.md) · **Deutsch**

**Vorverarbeitung für Planeten-, Mond-, Sonnen- und Finsternis-Aufnahmen** – ein moderner Nachfolger für PIPP (Planetary Imaging PreProcessor, letzte Version 2.5.9 von 2017).

Astrotool bereitet Videos und Bildserien für Stacking-Programme wie AutoStakkert!, RegiStax oder PlanetarySystemStacker vor. Es findet das Objekt in jedem Frame, zentriert es und schneidet unnötigen Hintergrund weg. Unbrauchbare Frames (Objekt fehlt, zu klein, am Rand, überbelichtet) werden verworfen, die übrigen nach Schärfe sortiert, und nur die besten werden gespeichert. Das spart Speicherplatz und macht das Stacking schneller und besser.

Einsatzgebiete:

- **Planeten** – Jupiter, Saturn, Mars & Co. trotz Seeing und Nachführfehlern stabil in der Bildmitte.
- **Mond und Sonne** – Vollscheibe zentrieren, Oberflächen-Ausschnitte stabilisieren (0.22).
- **Finsternis-Film mit einem Klick (Einfach-Modus)** – für Reisende ohne Astronomie-Kenntnisse: alle Fotos der Finsternis hineinziehen (Kamera oder Handy, beliebige Abstände, auch verschieden gezoomt); Astrotool sortiert verwackelte, überstrahlte und Bilder ohne Sonne aus, hält die Sonne gleich gross in der Mitte und macht daraus ein MP4 (1080 × 1080), das gleichmässig läuft – Bilder zwischen den Fotos werden berechnet, der Mond steht dort, wo er zu dieser Zeit war (0.34).
- **Einfach-Modus zum Erleben (0.36)** – ein Sternenhimmel und eine gezeichnete Finsternis begrüssen dich. Beim Rechnen schaust du zu: Jedes Foto erscheint mit dem gefundenen Kreis, der Filmstreifen wächst, aussortierte Fotos nennen den Grund. Der fertige Film läuft gross wie im Kino, darunter eine Zeitleiste aus deinen Fotos – ein Tipp springt dorthin – und am Handy ein Knopf zum Teilen. Die Webseite beginnt in der Sprache des Browsers und ist fürs Handy eingerichtet.
- **Mondfinsternisse, Handyfotos und weitere Formate (0.35)** – der Einfach-Modus macht auch aus einer **Mondfinsternis** einen Film: Der Mond bleibt über alle Zoomstufen gleich gross in der Mitte, Landschaften mit winzigem Mond werden aussortiert. **iPhone-Fotos (HEIC)** werden direkt gelesen (Hochformat steht aufrecht); der Film ist wahlweise quadratisch, 9:16 (Status, Reels) oder 16:9. Grosse Fotos werden rund 2.5-mal schneller ausgewertet, und Lücken von 20 Minuten und mehr werden ohne Störungen überbrückt.
- **Sonnenfinsternisse** – Bildserien über alle Phasen ausrichten und die Sonnenscheibe auch bei schmaler Sichel sauber zentrieren (Kreis am Sonnenrand statt Helligkeits-Schwerpunkt); Aufnahmezeiten bleiben erhalten. Daraus direkt einen Zeitraffer mit eingeblendeter Uhrzeit erstellen; Phasenmontagen folgen.
- **WinJUPOS** – Dateinamen mit der Aufnahmezeit in UT, direkt für die Derotation (0.29).
- **Ganze Beobachtungsabende** – viele SER/AVI-Aufnahmen oder ein Ordner mit Bildserien auf einmal, jede mit denselben Einstellungen in einen Ordner, mit WinJUPOS-Namen – oder Aufnahmen zu einer Serie zusammengefügt (0.31, Bildserien 0.32).
- **ISS-Transits, Animationen** – wie bei PIPP (geplant).

Die Verarbeitung läuft lokal – als Windows-App oder im Browser: **[astrotool.ai-suisse.com](https://astrotool.ai-suisse.com)** (nichts zu installieren, die Fotos bleiben auf dem eigenen Gerät).

- **Phase 1 – Web-Version** (`web/`): läuft komplett im Browser, Dateien verlassen den Rechner nicht.
- **Phase 2 – Windows-App** (ab Windows 11): gleiche Oberfläche als Tauri-App mit nativer Engine und modernem FFmpeg.

Hintergrund und Plan: [docs/reverse-engineering](docs/reverse-engineering/).

## Windows-App (.exe)

Schwerpunkt der Entwicklung. Installer (~2 MB) bzw. portable .exe (~9 MB), Windows 10/11, keine weiteren Programme nötig. Noch nicht signiert: Beim ersten Start kann SmartScreen „Der Computer wurde durch Windows geschützt“ melden – „Weitere Informationen“ → „Trotzdem ausführen“; Astrotool nur von der Release-Seite dieses Repos herunterladen. Bauen und Details: [docs/windows-app.md](docs/windows-app.md).

**macOS und Linux (experimentell, seit 0.35):** Die Releases enthalten auch ein `.dmg` für macOS (Apple Silicon und Intel) sowie AppImage und `.deb` für Linux. Sie werden auf GitHub automatisch gebaut und probeweise gestartet, sind aber noch nicht auf echten Geräten geprüft – Rückmeldungen sind willkommen. Die macOS-App ist nicht von Apple beglaubigt: Beim ersten Start verweigert macOS das Öffnen; unter *Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen* lässt es sich erlauben.

## Web-Version starten

```bash
cd web
npm install
npm run dev
```

Dann http://localhost:5173 öffnen und eine `.ser`-Datei oder mehrere Bilder hineinziehen.
Ohne eigene Aufnahme: `npm run sample` erzeugt `sample-jupiter.ser` (synthetischer Planet mit Seeing).

Tests: `npm test` · Produktions-Build: `npm run build` (Ausgabe in `web/dist`, statisch hostbar).

### Stand 0.15

| Funktion | PIPP-Schalter | Stand |
|---|---|---|
| SER lesen (8/16 bit, Mono/Bayer/RGB, Zeitstempel, abgebrochene Dateien) | – | ✅ |
| **AVI lesen** (SharpCap, FireCapture & Co.): 8/16 bit grau, Bayer roh, 24/32 bit BGR, MJPEG, Dateien > 4 GB (OpenDML) – ohne Zusatzprogramm | – | ✅ 0.10 |
| **MP4, MOV, MKV, WebM lesen** (Handy, Systemkamera) über den Video-Dekoder von Windows, Aufnahmedatum aus der Datei | – | ✅ 0.10 |
| Objekt prüfen, Mindestgrösse, Schwelle auto/manuell | `-chk -ms= -mp=` | ✅ |
| **Überbelichtete Frames verwerfen** (Anteil des Objekts an der Sättigungsgrenze; Totalität ausgenommen) | `-oe=` | ✅ 0.26 |
| **Bilder bearbeiten:** Graustufen, Spiegeln, Drehen um 90/180/270°, Grösse in % oder (0.29) als Breite × Höhe; Verstärkung, Histogramm strecken (Ziel, Schwarzpunkt, je Farbe) und Gamma (0.29) – Bayer-Rohdaten bleiben bei Tonwerten, Spiegeln und Drehen roh | `-convmono -flip_x -flip_y -rotate90 -resize_en -resize_width= -resize_height= -input_gain= -hs= -hs_bp -hsrgb -gamma=` | ✅ 0.26, 0.29 |
| Zentrieren, Zuschneiden, Versatz (Bayer-sicher) | `-ctr -cx= -cy= -ox= -oy=` | ✅ |
| Qualität: Schärfe mehrstufig, hellster Pixel, Helligkeit | `-q -qmin= -qmax= -qinc= -qhisto -qtotal` | ✅ |
| Beste N / beste % behalten, Reihenfolge | `-q= -qpcnt= -nr` | ✅ |
| SER schreiben (Zeitstempel bleiben erhalten) | `-ser` | ✅ |
| **WinJUPOS-Dateinamen:** Aufnahmezeit in UT mit Zehntelminute, Beobachterkürzel, weitere Angaben; Video nach Beginn, Mitte oder Ende benannt; Zeit aus der Datei, dem SER-Kopf oder dem Dateinamen, verschiebbar | `-wjpos_*` | ✅ 0.29 |
| **Stapel:** mehrere SER-/AVI-/Video-Aufnahmen in einem Durchgang mit denselben Einstellungen, je eine Ausgabe in einen gewählten Ordner (SER-Datei oder Unterordner mit Einzelbildern, dazu Zeitraffer/Montage), Übersichtstabelle; oder **zusammengefügt** zu einer Serie, beste Bilder aus allen. **Ordner öffnen** (oder Ordner hineinziehen): jeder Unterordner mit Bildern wird eine Bildserie des Stapels, jedes Video eine Aufnahme; andere Dateien werden übergangen (0.32) | mehrere Eingaben, `-join` | ✅ 0.31/0.32 |
| Bildserien (JPG, PNG, TIFF) mit Sortierung nach EXIF-Aufnahmezeit | – | ✅ |
| **Kamera-RAW:** Sensordaten (16 bit, linear, Bayer) von DNG, Canon CR2, Sony ARW (verlustfrei, verlustbehaftet „cRAW“ und unkomprimiert – 0.27), Nikon NEF (komprimiert), Samsung SRW (NX1/NX500, NX300-Familie mit NX300M und NX2000, NX100-Familie – 0.27/0.30), Fujifilm RAF unkomprimiert mit Bayer-Sensor (z. B. X-A5, 0.27) und mit X-Trans-Muster, auch als DNG (0.21, eigene Farbrekonstruktion); für CR3, komprimierte RAF, ORF, RW2 … das eingebettete Kamerabild in voller Grösse. Weissabgleich automatisch aus dem Kamerabild, Aufnahmedaten aus EXIF | – | ✅ 0.11 |
| **Finsternis-Modus:** Zentrieren per Kreis am Sonnenrand, auch bei schmaler Sichel | – (neu) | ✅ |
| **Einfach-Modus** für Finsternis-Serien: ein Knopf von den Fotos zum MP4 (1080 × 1080, H.264). Sortiert nach Aufnahmezeit, nimmt nur die Kamera mit den meisten Fotos, verwirft verwackelte/unscharfe Bilder (Sonnenrand breiter als in den Nachbarbildern), überstrahlte und Bilder ohne Sonne (Landschaft, Personen); gleicht verschiedenen Zoom aus; Ausschnitt nach der Sonnengrösse; zeittreue Zeitachse: unregelmässige Abstände laufen gleichmässig, Lücken werden mit berechneten Bildern gefüllt (Mond entlang seiner Bahn verschoben), Totalität langsamer; Zusammenfassung in einfacher Sprache (0.34) | – (neu) | ✅ 0.34 (eigene Serie NX500 ohne Sonnenfilter, Handy-Serie Pixel mit verschiedenem Zoom, gemischter Ordner mit Landschaften und Personen, Totalität 2026) |
| **Einfach-Modus, Live-Ansicht und Kino:** beim Rechnen jedes Foto mit dem gefundenen Kreis und ein wachsender Filmstreifen (Vorschaubilder kommen vom Rechenteil, ohne sie zu kopieren); das Ergebnis mit einer Zeitleiste aus den Fotos, die an ihre Stelle im Film springt; Teilen-Knopf, wo das Gerät Dateien teilen kann | – (neu) | ✅ 0.36 (77 Fotos: 49 s mit Live-Ansicht, 54 s ohne – kein messbarer Mehraufwand) |
| **Einfach-Modus für Mondfinsternisse:** Kreis am Mondrand (der Erdschatten hat keinen scharfen Rand); jedes glaubhaft gemessene Foto bleibt, egal mit welchem Zoom; Nachtaufnahmen ohne Mond werden verworfen (wenig Rand, grosse Streuung); zwischen den Fotos wird überblendet | – (neu) | ✅ 0.35 (Handy-Serie Samsung S24 Ultra der totalen Mondfinsternis vom 07.09.2025: 14 Mondfotos im Film, 14 Landschaften verworfen; 30 Nachtaufnahmen einer Veranstaltung: nur das eine Mondfoto bleibt) |
| **iPhone-Fotos (HEIC/HEIF):** Aufbau der Datei selbst gelesen (Raster aus HEVC-Kacheln, Drehung, Exif), dekodiert mit dem HEVC-Dekoder des Systems über WebCodecs – keine fremde Bibliothek | – (neu) | ✅ 0.35 (iPhone 11 Pro Max und 13 Pro Max, Nokia 8.3, Beispieldateien der HEIF-Konformitätssammlung; 12 MP in 0.4 s) |
| **Format des Films** im Einfach-Modus: quadratisch, Hochformat 9:16 oder Querformat 16:9, Titel und Uhrzeit über und unter dem Bild; bei wenigen Fotos kürzer | – (neu) | ✅ 0.35 |
| **Schnelle Analyse** von Fotoserien: Das Objekt wird in einer verkleinerten Ansicht gesucht, nur der Ausschnitt darum in voller Auflösung gelesen | – (neu) | ✅ 0.35 (77 Fotos mit 28 MP: 64 s statt 160 s, gleiche 73 Fotos im Film) |
| **Zwischenbilder über grosse Lücken** (Mond um mehr als ein Viertel des Sonnenradius gewandert): Modell des Fotos – Helligkeit nach Abstand vom Rand der sichtbaren Sonne – statt Verschieben; der Mondrand wird je Foto nachgemessen | – (neu) | ✅ 0.35 (eigene Serie, Lücke 21 min: ohne dunkle Flecken und Reste des alten Mondrands) |
| **Totalität:** Ausrichtung am Mondrand (dunkle Scheibe in der Korona, automatisch erkannt), Belichtungsreihen (EXIF-Belichtungszeit) zu einem HDR-Bild zusammengefasst – innere und äussere Korona in einem Bild, Zeitraffer ohne Flackern; Himmelsschleier samt Verlauf abgezogen (0.23); Kennlinie der Kamera aus jeder Reihe bestimmt, damit Kamera-JPEGs ohne Ringe zusammenpassen, falsche Ränder an den Kontakten (Sichel, Diamantring, überbelichtete innere Korona) verworfen (0.33) | – (neu) | ✅ 0.9 (künstliche Serien; echte Serien NASA Eclipse Megamovie 2024 und Totalität 12.08.2026 mit Teleskop bei tiefer Sonne) |
| **Phasenmontage** einer Finsternis: ausgewählte Bilder als Bogen (Weg der Sonne), Reihe oder Raster, Totalität in der Mitte, Uhrzeit unter jeder Scheibe, ein grosses PNG | – (neu) | ✅ 0.15 |
| PNG-Einzelbilder als ZIP oder direkt in einen Ordner, mit Protokoll (CSV) | `-png` | ✅ |
| **Direkt auf die Platte** während der Verarbeitung (SER in eine Datei, Einzelbilder in einen Ordner), auch beim Speichern eines Bereichs im Betrachter (0.19) – ohne Grenze durch den Arbeitsspeicher; ZIP64 für Archive über 4 GB | – | ✅ 0.17 |
| **Volle Tiefe:** 16-bit-PNG, 16-bit-TIFF und FITS (Aufnahmezeit, Belichtung, Bayer-Muster im Kopf) für Siril, PixInsight, DeepSkyStacker | TIFF, FITS | ✅ 0.16 |
| PIPP-Optionsdatei `.pof` importieren (Teilmenge, Format an echten Dateien bestätigt) | – | ✅ |
| Zeitraffer als **MP4 H.265/HEVC** (Standard, teilbar in WhatsApp und Google Fotos), MP4 H.264, WebM oder GIF – Bildrate, Standbild am Ende, hin und zurück, Aufnahmezeit und Titel eingeblendet | `-anim_fwd -anim_rev -anim_fwd_lf_rep= -fps_rate= -gif` | ✅ |
| Oberfläche Englisch (Standard) / Deutsch umschaltbar | – | ✅ |
| Menü „Tools & Setup“: Browser-Check, Installationsbefehle, Setup-Skript für Windows (`setup-windows.ps1`, winget) | – | ✅ |
| Defekte oder fremde Bilder in einer Serie werden übersprungen statt abzubrechen | – | ✅ |
| **Farbkameras (Debayer)** in der Verarbeitung: PNG und Zeitraffer farbig, SER wahlweise farbig oder als Bayer-Rohdaten (für AutoStakkert!); Erkennung und Schärfemass auf einem Helligkeitsbild ohne Bayer-Schachbrett | `-db -db= -pb` | ✅ |
| **Betrachter „SER Player“** (eigenständiger Nachbau): Abspielen vorwärts/rückwärts/vor & zurück, Start-/Endmarker, Debayer, Verstärkung, Gamma, Sättigung, Farbbalance, Histogramm, Zoom, Bereich speichern (SER original/wie angezeigt, PNG), Bereich für die Verarbeitung übernehmen | – | ✅ |
| Reparatur von SER-Dateien mit „0 Frames“ im Kopf | – | ✅ |
| Nachtmodus (rotes Licht) | – | ✅ |
| **Dark/Flat-Kalibrierung:** Master aus SER, Video, Bildserie oder RAW (Mittel ohne Höchst- und Tiefstwert), Flat-Dark/Bias, farbneutrale Flats bei Bayer-Daten; vor Zuschnitt und Debayer angewendet, auch in der Vorschau; Dark an andere Belichtungszeit angepasst, Master als FITS speichern und laden (0.28) | Dark/Flat | ✅ 0.18 |
| **FITS lesen:** Einzelbilder (grau, Bayer, Farbe; 8/16/32 bit, Gleitkomma) mit Zeit und Belichtung aus dem Kopf – auch als Darks/Flats; Würfel mit vielen Bildern in einer Datei (0.25) öffnen wie ein Video; komprimiertes FITS (`.fits.fz`: Rice, GZIP, quantisierte Gleitkommawerte – wie von fpack und Sonnenobservatorien, z. B. NSO/GONG) (0.30) | FITS | ✅ 0.20, 0.30 |
| Komprimierte CR3/RAF: Format nicht öffentlich beschrieben – mit dem kostenlosen Adobe DNG Converter in DNG umwandeln (Hinweis in der App) | | Weg über DNG |
| **Oberflächen-Stabilisierung:** Mond-/Sonnen-Nahaufnahmen ohne ganzen Rand – jedes Bild über die Oberflächenstruktur am ersten Bild ausgerichtet (eigene FFT, Unterpixel), Bilder ohne passende Struktur (Wolken) verworfen; Vorlage „Oberfläche“; freiwillige Ankerbox in der Vorschau ziehen (0.24); Referenz folgt bei langen Serien der sich wandelnden Struktur, Bilddrehung (Feldrotation) wird erkannt und ausgeglichen (0.28) | Surface Feature | ✅ 0.22 |

## Reverse Engineering mit rea

Die Analyse von PIPP läuft mit [rea](https://github.com/morluto/rea) (MCP-Server für Reverse Engineering).

1. rea installieren (einmalig, ausserhalb des Repos):
   ```bash
   npm install --prefix "%USERPROFILE%/tools/rea-agents" rea-agents@6.8.0
   ```
2. `.mcp.json.example` nach `.mcp.json` kopieren und `<USER>` ersetzen. Claude Code fragt beim nächsten Start in diesem Ordner, ob der Server `rea` aktiviert werden soll.
3. Belege neu erzeugen: `bash re/scripts/extract-evidence.sh` → `re/evidence/` (nicht im Git).

Für die Analyse der nativen Engine (`pipp_core.exe`) braucht rea zusätzlich Ghidra + JDK 21.

## Datenschutz

Die Web-Version unter astrotool.ai-suisse.com ist dasselbe Programm, ausgeliefert über GitHub Pages; wie bei jeder Webseite sieht der Anbieter (GitHub) die Adresse, von der aus der Browser zugreift. Fotos und Videos werden im Browser verarbeitet und nie hochgeladen.

Dieses Programm überträgt keine Informationen an andere Systeme im Netz, ausser die Benutzerin oder der Benutzer verlangt es ausdrücklich. Astrotool arbeitet offline mit den eigenen Dateien. Der Installer lädt Microsoft WebView2 nur, wenn es auf dem Computer fehlt; Hilfsprogramme wie FFmpeg werden nur per Klick auf *Installieren* unter *Tools & Setup* über winget installiert.

## Lizenz

Astrotool ist freie Software unter der **GNU General Public License, Version 3 oder später** (GPL-3.0-or-later), © 2026 aisuisse – siehe [LICENSE](LICENSE). Verwendete Bibliotheken: [THIRD_PARTY.md](THIRD_PARTY.md).

Astrotool enthält **keinen Code** aus PIPP oder SER Player; deren Funktionen werden eigenständig nachgebaut. Damit bleibt der Urheber in der Lage, Astrotool bei Bedarf auch unter einer weiteren Lizenz anzubieten. Beiträge Dritter sollten deshalb mit einer Zustimmungserklärung (CLA) erfolgen.

## Rechtliches

PIPP ist Freeware von Chris Garry; der Quellcode wurde nie veröffentlicht. Dieses Projekt enthält **keinen** Code und keine Binärdateien von PIPP. Die Analyse dient nur dazu, Funktionsumfang, Optionen und Dateiformate zu verstehen; die Algorithmen werden eigenständig umgesetzt.
