# Testdaten

Frei zugängliche Aufnahmen zum Testen von Astrotool. Stand: November 2026.
Die Dateien gehören den jeweiligen Fotografen und werden **nicht** ins Repository übernommen. Lokal unter `web/.testdata/` ablegen (ist in `.gitignore`).

## Planeten (SER-Videos)

| Quelle | Inhalt | Grösse | Bedingungen |
|---|---|---|---|
| [Strata Sample Files](https://macobservatory.com/strata-sample-data/) (Dropbox-ZIP) | Saturn-SER `2022-10-25-0055_2.ser` + Jupiter-TIFF-Stack | 1.29 GB | „für Evaluation und Tests“ |
| [Cloudy Nights: „The Planetary Imaging Free SER File Thread“](https://www.cloudynights.com/forums/topic/903741-the-planetary-imaging-free-ser-file-thread/) | ausgewählte Rohvideos mit Referenz-Stack, Links auf Google Drive / SharePoint | 1–20 GB je Datei | zum Üben ausdrücklich freigegeben |

Datensätze aus dem Cloudy-Nights-Thread (alle mit 16-bit-Referenz-Stack zum Vergleich):

| Beitrag | Objekt | Teleskop / Kamera | Besonderheit |
|---|---|---|---|
| #2 Borodog | Saturn 2022 | C11 EdgeHD, ASI183MC (Farbe, Bayer) | sehr gutes Seeing |
| #3 Borodog | Mars 2022 (Opposition) | C11 EdgeHD, ASI183MC | |
| #4 Borodog | Jupiter 10.11.2023 | C11 EdgeHD, ASI678MC | |
| #5 kennhk | Jupiter 22.11.2023 | 16″-Dobson, Player One Uranus-C | |
| #7 Ittaku | Saturn mit Tethys und Schattendurchgang 10.10.2023 | 16″ SCT, Uranus-C | 2.7 GB, 6 min @ 50 fps |
| #9 kennhk | Jupiter 26.08.2024 | 16″-Dobson | Seeing 10/10, ZIP |
| #10 Astrohunter8se | Jupiter 19.10.2024 | C11 | 12 **Mono**-SER (SharePoint) |
| #15 Borodog | 04.03.2026 | C11 EdgeHD, ASI676MC | |
| #16 Ittaku | Saturn 2026 | 16″ SCT | ⚠ 20 GB |

**Getestet (02.11.2026):** Strata-Saturn `2022-10-25-0055_2.ser` – 3.7 GB, 8984 Frames 640 × 640, Bayer RGGB, 8 bit, ASI183MC, 5 min @ 30 fps. Astrotool: alle Frames gelesen, Saturn in jedem Frame gefunden, beste 50 % als SER (439 MB) in 44 s (≈ 200 Frames/s). Prüfskript: `npx vite-node scripts/inspect-ser.ts -- <datei.ser> <ausgabeordner>`.

Damit testbar: Bayer-Farbdaten (Debayer, Roadmap 1.5), Mono, 16 bit, sehr grosse Dateien (Roadmap 1.12), Qualitätssortierung im Vergleich zum Referenz-Stack.

## Sonnenfinsternis

| Quelle | Inhalt | Nutzen |
|---|---|---|
| Eigene Aufnahmen 12.08.2026 (privater Bilderordner, nicht im Repo) | 77 JPGs, partielle Phasen, 5 PIPP-Läufe | Referenz (Auswertung nur lokal, nicht im Repo) |
| [NASA Eclipse Megamovie 2024 – Datenbank](https://eclipsemegamovie.org/database) | 52 000+ Rohbilder (Level 1) von 143 Stationen, Schwerpunkt Totalität | Testdaten für den geplanten Totalitäts-Modus (Ausrichtung am Mondrand, HDR-Reihen) |
| [Citizen CATE 2024](https://eclipse.boulder.swri.edu/?p=598) | FITS-Rohbilder, Totalität | Freigabe angekündigt, Stand unklar |
| [Wikimedia Commons: Solar eclipse of 2026 August 12](https://commons.wikimedia.org/wiki/Category:Solar_eclipse_of_2026_August_12) | Einzelfotos und fertige Phasenmontagen (CC-Lizenzen) | als Vorlage für eine Phasenmontage; kaum Bildserien |

## Mond

Kein frei verfügbares Mond-SER gefunden, das sich ohne Anmeldung herunterladen lässt (die früheren BiggSky-Beispieldaten sind nicht mehr verlinkt). Nachfrage in Foren oder eigene Aufnahme nötig.

## Praxistests

**Betrachter (0.7, 02.11.2026)** mit `saturn600.ser` (erste 600 Frames des Strata-Saturn, Bayer RGGB, mit Zeitstempeln): Farbe korrekt, Farbbalance neutral (R 0.91, B 1.09), Wiedergabe ~16 Bilder/s, Marker 101–250 per Tastatur, Bereich als SER original gespeichert (150 Frames, byteexakt inkl. Zeitstempel) und als SER RGB „wie angezeigt“, Bereich an die Verarbeitung übergeben (Start 100, 150 Frames).

Zusätzlich: automatischer Test der Windows-App mit `web/scripts/app-e2e.mjs` (siehe [windows-app.md](windows-app.md)).

**Vollständiger Testdurchgang der Windows-App 0.8 (03.11.2026)** mit `web/scripts/app-fulltest.mjs`: 18 von 18 Tests bestanden.

| Test | Ergebnis |
|---|---|
| Über-Dialog, Sprachwechsel, Werkzeug-Status, AVI-Ablehnung | ✅ Version 0.8.0, Meldung „Videos other than SER … later version“ |
| Betrachter `saturn600.ser` | Wiedergabe **29.8 Bilder/s** (Farbe, 640 × 640); Marker 101–250 per Tastatur; SER roh 61 441 378 Bytes (byteexakt), SER farbig 150 Frames RGB, PNG-ZIP 150 Bilder; Bereich übernommen (Start 100, 150 Frames) |
| Planet, beste 50 % | 300 Frames 448 × 448 als SER **Bayer roh** (57 MB) in 11 s; Zeitraffer HEVC (hvc1, FFmpeg), Aufnahmedatum 2022-10-25 |
| Planet, SER farbig + PNG | 50 Frames RGB (30 MB), ZIP 50 PNG + Protokoll |
| Nur sortieren | 600 Frames 640 × 640 in 4 s |
| `.pof`-Import | Zuschnitt 300 × 280, beste 123, Debayer übernommen |
| Sonne/Mond, 10 JPG volle Grösse | PNG-ZIP 128 MB in 12 s |
| Finsternis, 77 JPG | 73 PNG + Protokoll, Zeitraffer HEVC 0.4 MB, 1080 × 1080, 11.1 s, Datum 12.08.2026 und Titel im MP4; GIF 7.7 MB, H.264 4.0 MB |
| Grosses SER (Strata-Saturn, 3.7 GB, 8984 Frames) | beste 50 % = 4492 Frames (860 MB) in 61 s |

**Totalitäts-Modus 0.9 (03.11.2026).** Echte Totalitäts-Aufnahmen liegen noch nicht vor; geprüft wurde mit künstlichen Serien (`web/scripts/make-totality-testset.mjs`: 22 JPG 1600 × 1200 mit EXIF – 4 partiell mit Filter, 3 Belichtungsreihen 1/1000 … 1/4 s, 3 partiell; Sonne wandert durchs Bild):

| Test | Ergebnis |
|---|---|
| Einheitstests (`tests/totality.test.ts`, 11 Tests) | Mondmitte < 0.4 px bei allen 5 Belichtungen; partielle und ringförmige Phase bleiben am Sonnenrand; Reihen richtig getrennt; HDR ohne Überbelichtung, innere und äussere Korona sichtbar |
| Windows-App, 22 Bilder, Vorlage Finsternis | 15 Bilder am Mondrand, 3 Reihen zu HDR → 10 PNG (`…_hdr_astro.png`) + Protokoll; Mitte auf ≤ 0.07 px genau (gegen die bekannte Lage); Zeitraffer HEVC 1080 × 1080 ohne Flackern, Datum 02.08.2027 und Titel im MP4; 5 s |
| Eigene Bilder 12.08.2026 (77 JPG, nur partiell) | kein Bild fälschlich als Totalität erkannt, Mittelpunkte unverändert (Abweichung 0.000 px zu 0.8) |

**Echte Totalität (03.11.2026):** NASA Eclipse Megamovie 2024, Station Tammara King (Texas, 32.69° N), 31 JPG `DSC_5867`–`DSC_5897`, Nikon D5, 340 mm, 5568 × 3712, Belichtungen 1/3200 s bis 2 s bei f/8 und f/4.8, teils Wolken. Nur lokal in `web/.testdata/megamovie-king` (keine Lizenzangabe in der Datenbank – nicht ins Repo).

| Ergebnis | |
|---|---|
| Mondrand gefunden | 17 Bilder, Radius 245.3–249.3 px, Randabweichung 0.29–0.88 px |
| HDR | 4 Reihen (5876–78, 5883–84, 5885–89, 5892–93); 5885–89 zeigt Korona-Strahlen und Protuberanzen, 5883–84 (f/4.8, heller Himmel) körnig – ab 0.23 Mond dunkel, ohne Korn, Verlauf etwa halbiert |
| verworfen mit Grund | Diamantring mit Wolken (Radius 1.5–2× zu gross), fast schwarze Bilder (Perlschnur bei 1/3200 s, hellster Wert 4–8 von 255), dünne Sicheln kurz vor/nach der Totalität |

Gefunden und behoben: (1) Bei vom Himmel aufgehelltem Mond rutschte die Schwellen-Suche in den Mond hinein → Suche endet, sobald das Loch kleiner wird (5888/5889 jetzt richtig). (2) Dünner Chromosphären-Ring ging in der Helligkeits-Statistik unter → Spitzenwert aus den hellsten 0.05 %. (3) Falsche „Sonnenränder“ in der Totalität wurden übernommen → Radiusprüfung über Sonne und Mond gemeinsam, und ein Sonnenrand zwischen zwei Mondrand-Bildern (≤ 8 min) wird verworfen („in der Totalität, aber Mondrand nicht gefunden“). Die Randabweichung taugt dafür nicht: Echte Sonnenrand-Anpassungen der Serie vom 12.08.2026 liegen bei 2–3 px (Seeing, JPEG), genau wie die falschen.

**Noch offen:** Totalität mit anderer Ausrüstung (Weitwinkel, Teleskop mit Kamera), RAW-Dateien (NEF/CR2/ARW) einlesen – die meisten Megamovie-Stationen liefern nur RAW.

Gefunden und behoben: Mit „Beste Frames zuerst“ lief der Zeitraffer in Qualitäts- statt Aufnahmereihenfolge – jetzt immer chronologisch.

| Datum | Test | Ergebnis |
|---|---|---|
| 02.11.2026 | Zeitraffer `SAM_3105-SAM_3188_astrotool_hevc.mp4` (H.265/HEVC, hvc1, 1080 × 1080, 30 fps, 11 s, 2.8 MB) über WhatsApp Web (Chrome, Windows 11) verschickt, empfangen auf Pixel 10 Pro XL | ✅ wird formatfüllend abgespielt (Test durch Nutzer) |
| 02.11.2026 | dieselbe Datei über den Webbrowser in Google Fotos hochgeladen | ✅ gesichert in Originalqualität, 2.8 MB, 1080 × 1080. ⚠ Google Fotos ordnete das Video nach dem Erstellungsdatum der Datei ein (02.11.2026), nicht nach dem Aufnahmetag (12.08.2026). **Behoben in 0.5:** Astrotool schreibt den Aufnahmezeitpunkt des ersten Bildes als `creation_time` ins MP4 (mvhd/tkhd/mdhd) sowie Datum und Titel als Metadaten. |
| 02.11.2026 | `SAM_3105-SAM_3188_astrotool-app_hevc.mp4` aus der Windows-App 0.6.0 (H.265/HEVC über FFmpeg libx265, 0.38 MB, mit Aufnahmedatum) in Google Fotos hochgeladen | ✅ wird unter **12.08.2026, 19:33** einsortiert – Datumsfehler behoben (Test durch Nutzer) |
| 02.11.2026 | dieselbe Datei per WhatsApp verschickt | ✅ (Test durch Nutzer) |

## AVI und MP4 (0.10, 03.11.2026)

Erzeugt mit FFmpeg aus dem Saturn-Zeitraffer (448 × 448), nur lokal in `web/.testdata/avi`:

```bash
ffmpeg -i planet_saturn_hevc.mp4 -frames:v 40 -c:v rawvideo -pix_fmt gray saturn_y800.avi
ffmpeg -i planet_saturn_hevc.mp4 -frames:v 40 -vf crop=447:300:0:0 -c:v rawvideo -pix_fmt bgr24 saturn_bgr24_odd.avi
ffmpeg -i planet_saturn_hevc.mp4 -frames:v 40 -c:v mjpeg -q:v 3 saturn_mjpeg.avi
ffmpeg -stream_loop 6 -i planet_saturn_hevc.mp4 -c:v rawvideo -pix_fmt bgr24 saturn_big.avi
```

| Datei | Ergebnis Astrotool-Leser |
|---|---|
| `saturn_y800.avi` (8 bit grau) | 40 Bilder, pixelgleich mit FFmpeg (Abweichung 0) |
| `saturn_bgr24_odd.avi` (BGR, von unten nach oben, 446 px breit) | pixelgleich (0) |
| `saturn_mjpeg.avi` | 40 Bilder gelesen |
| `saturn_big.avi` (4.05 GB, OpenDML mit mehreren RIFF-Abschnitten, 6720 Bilder) | in 0.5 s geöffnet, Bild 1500 pixelgleich (0) |

Einheitstests (`tests/avi.test.ts`): eigener kleiner AVI-Schreiber für 8 bit grau, BGR mit aufgefüllten Zeilen, graue Palette mit Audiospur davor, 16 bit grau mit zweitem RIFF-Abschnitt, Fehlermeldungen. MP4 wird im Volltest der App geprüft (eigener H.264-Zeitraffer wird wieder geöffnet und verarbeitet).

**Volltest der Windows-App 0.10 (03.11.2026):** 23 Tests (neu: kaputte AVI mit Meldung, AVI Y800 → SER mono 40 Bilder, AVI MJPEG → 40 PNG, AVI 4 GB → beste 10 % = 672 Bilder in 41 s, eigener H.264-Zeitraffer als MP4 wieder geöffnet und im Finsternis-Modus verarbeitet). 22 im ersten Lauf bestanden; der eine Fehler lag in der Prüfung des Testskripts (Zahl ohne Trennzeichen im Infotext) und bestand nach der Korrektur einzeln (`--only`). Öffnen der 4-GB-AVI in der App: 6.5 s. Das grosse SER brauchte im Gesamtlauf 148 s statt 62 s, weil die 4-GB-AVI zuvor den Datei-Cache von Windows verdrängt hatte; einzeln wieder 70 s.

## Kamera-RAW (0.11, 03.11.2026)

Je eine Belichtungsreihe aus der Totalität 2024 (NASA Eclipse Megamovie, nur lokal in `web/.testdata/raw/<format>`, 24 Dateien, 505 MB):

| Format | Station, Kamera | Eingebettetes JPEG | Sensordaten |
|---|---|---|---|
| NEF | Igor Ruderman, Nikon D5100 (14 bit, Nikon-Kompression) | 4928 × 3264 | noch nicht → JPEG |
| CR2 | James Gray Lambe III, Canon EOS Rebel T7 | 6000 × 4000 | ✅ verlustfreies JPEG in 3 Streifen, Muster GBRG (RGGB ab sichtbarem Bereich), 6000 × 4000, 0.8 s/Bild |
| CR3 | Donald S. Gardner, Canon EOS R5 | 8192 × 5464 (Spur 1) | noch nicht → JPEG |
| ARW | Ivo Kudini, Sony A7 IV (verlustfrei komprimiert) | 7008 × 4672 | ✅ Kacheln 512 × 512 mit 2×2-Blöcken, 7008 × 4672, 0.9 s/Bild |
| DNG | Rick Galloway, Canon R6 (Adobe DNG) | nur 1024 × 683 | ✅ Kacheln 256 × 256, Aktivbereich + DefaultCrop, 5472 × 3648, 0.6 s/Bild |
| RAF | Franz Zabroky G., Fujifilm X-T4 | 4416 × 2944 | komprimiert → JPEG mit Hinweis auf DNG |

Ergebnisse: Grösse und Ausschnitt der Sensordaten stimmen genau mit dem Kamerabild überein. Weissabgleich aus dem Vergleich mit dem Kamerabild an denselben Bildstellen (R/B etwa 2.2/1.7 Canon, 2.45/1.54 Sony, 1.90/1.46 DNG); übersteuerte Pixel bleiben weiss. Finsternis-Modus mit HDR auf den Sensordaten: Mondrand in allen Bildern (Radius auf ±2 px gleich), HDR mit Korona-Strahlen und Protuberanzen (ARW, DNG). Gefunden und behoben: (1) Canon-Farbmuster beginnt am sichtbaren Bereich, nicht am Sensoranfang. (2) Ausgebrannte Stellen wurden durch den Weissabgleich rosa. (3) In linearen Rohdaten ist die schwache Korona kaum über dem Rauschen – für die Erkennung wird das Bild wie von einer Kamera aufgehellt (Quadratwurzel), die Ausgabe bleibt linear.

Einheitstests (`tests/raw.test.ts`): verlustfreies JPEG mit eigenem Test-Kodierer für alle 7 Prädiktoren, 1–4 Komponenten, 12–16 bit (exakt); mit vorhandenen Testdateien zusätzlich Kamerabild, EXIF und Sensordaten je Format.

**Volltest der Windows-App 0.11 (03.11.2026):** 30 von 30 Tests bestanden (neu: RAW – ARW-Sensordaten mit Finsternis-HDR, Umschalten auf Kamerabild, CR2/DNG als Sensordaten, NEF/CR3/RAF über das eingebettete Bild).

**Nikon NEF (0.12, 03.11.2026):** Nikon D5100, Kompression 4 (verlustbehaftet, 14 bit, Kennlinie mit 257 Stützpunkten und Codebaum-Wechsel ab Zeile „split“ aus MakerNote-Tag 0x0096). Alle Bilder ohne ungültigen Code dekodiert, Bild deckungsgleich mit dem Kamerabild; zugeschnitten auf 4928 × 3264 (Nikon speichert rechts zusätzliche Sensorspalten). Weissabgleich aus MakerNote-Tag 0x000C (R 1.98, B 1.43) – das Kamerabild ist bei diesen kurzen Belichtungen (hellster Wert 4 % des Maximums) zu dunkel für die Schätzung. Die 4 Testbilder zeigen die Korona nur einseitig; der Mondrand wird darin nicht sicher gefunden (Daten, nicht Dekoder).

**Aufwand der übrigen Formate:** CR3 nutzt Canons Wavelet-Codec „CRX“ (etwa zehnmal NEF); RAF der X-T4 hat Fujis eigene Kompression und ein X-Trans-Farbmuster 6 × 6 statt Bayer 2 × 2 – dafür müssten Demosaicing, Zuschnitt und Erkennung erweitert werden. Samsung SRW (NX500 des Besitzers): Testdateien angefragt.

**X-Trans (0.21, 04.11.2026):** `DSCF0266.RAF` (Fujifilm X-T4, unkomprimiert, 55 MB, CC0) von [raw.pixls.us](https://raw.pixls.us/data/Fujifilm/X-T4/) in `.testdata/raw/raf-unc/` (mit Erlaubnis des Besitzers geladen). Lage des X-Trans-Musters (Tag 0x131 rückwärts, ab Sensorpunkt 0,0) und Zuschnitt (0x110: oben 13, links 6) gegen das eingebettete Kamerabild bestimmt: Farbkorrelation 0.85 je Kanal, alle anderen Musterlagen deutlich schlechter. Ergebnis 6240 × 4160 RGB, Weissabgleich der Kamera aus 0xf00e; Farbtafel im Bild neutral. Einheitstest `tests/xtrans.test.ts` (auch künstliches X-Trans-DNG), Volltest-Fall „RAW: RAF-UNC“.

**Samsung SRW (0.13, 03.11.2026):** 7 eigene Aufnahmen der NX500 des Besitzers (`REA\Astrotool-App\fotos\RAW`, RAW + JPG, Zimmeraufnahme), Kopie von 3 Dateien in `web/.testdata/raw/srw`. Hinweis: Die NX500 speichert RAW nur in den Modi P, A, S, M – im Automatik- und Szenenmodus nur JPG. Kompression 32773 („Version 3“): Blöcke zu 16 Pixeln, Vorhersageart und Bitlängen je Block, Zeilen auf 16 Byte ausgerichtet; Sensor 6496 × 4336, sichtbarer Bereich 6480 × 4320 aus MakerNote 0xa010 (= Grösse des Kamera-JPGs); Schwarzwert 128 (gemessen an allen 7 Bildern, gleich dem Startwert im Datenkopf); Weissabgleich aus 0xa021 minus 0xa028 (R 1.81, B 1.91; beide Grün gleich). Farben und Geometrie stimmen mit dem Kamera-JPG überein; 1.4 s je Bild.

**Totalität verbessert (0.14, 03.11.2026):** Testserie `make-totality-testset.mjs` jetzt physikalisch stimmig (der Mond zieht mit 0.15 px/s gleichmässig vor der Sonne vorbei, Totalität solange der Abstand < Radiusdifferenz). Abstand der Bildmitte zur wahren Sonnenmitte in den 15 Totalitäts-Bildern: 0.01–0.19 px mit „auf die Sonne zentrieren“, 1.6–5.5 px auf den Mond; Mondrand in 5 von 7 partiellen Bildern gemessen. Echte Serie Megamovie (King): keine brauchbaren partiellen Bilder → bleibt beim Mond (wie vorgesehen). HDR mit Abzug des Himmelsschleiers: 5885–5889 dunklerer Mond, sauberere Korona; 5883–5884 (heller, verlaufender Himmel bei f/4.8) nur wenig besser.

**Samsung NX500, alle Modi (0.14.1, 03.11.2026):** Die 4 CC0-Muster von [raw.pixls.us](https://raw.pixls.us/data/Samsung/NX500/) (12/14 bit, „normal“ und „lossless“; nur lokal in `web/.testdata/raw-srw-pixls`) dekodieren alle fehlerfrei, auch die bisher ungetesteten Pfade der „normal“-Kompression (Verstärkungsfaktor, wahlweise Bitlängen). Gefunden und behoben: Der Schwarzwert ist bei 12 bit 32, nicht 128 (der Startwert im Datenkopf ist in beiden Fällen 128) – mit 128 fielen die Schatten ab. Bei gleicher Belichtung ist 12 bit konstant rund 11 % heller als 14 bit (Weisspunkt der Modi), für Serien unerheblich. Ausserdem behoben: Beim schnellen Umschalten „Sensordaten/Kamerabild“ konnte das Format einer noch ladenden Serie in die nächste übergehen; jetzt hat jedes Öffnen seinen eigenen Zustand, veraltete Ergebnisse werden verworfen.

**Phasenmontage (0.15, 03.11.2026):** Eigene Serie 12.08.2026 (77 JPG, Aufnahmepause 19:33–19:54): 11 Bilder als Bogen, 3840 × 1342 px, keine doppelten Zeiten mehr nach der Mischung aus Zeit und Bildnummer; die Rechtecke der Ausschnitte waren zuerst sichtbar (Himmelsschleier ohne Filter) – behoben durch Abzug des Himmels aus den Bildecken und weichen Rand. Künstliche Serie mit Totalität: 9 Bilder, HDR-Bild der Totalität in der Mitte. 7 neue Einheitstests (Auswahl, Lücken, Anordnung).

**Dunkle Teilphasen (0.15.1, 03.11.2026):** 12 partielle Bilder derselben Megamovie-Station (`DSC_5805`–`DSC_5939`, nur lokal in `web/.testdata/megamovie-king-full`), viele hinter Wolken. Vorher: 5825 mit halbem Radius (r 124 statt 236), 5805/5815 mit Streuung ~3 px gefittet, 5868/5869 (Diamantring hinter Wolken, r 737/783) verschoben den Vergleich der Nachbarn. Jetzt: zweistufige Radiusprüfung (erst gegen den Median der ganzen Serie, Grenze 30 %, dann gegen die Nachbarn), Grund „zu dunkel (Wolken?)“ bei hellstem Wert unter 8 % – ohne Rand oder mit Streuung > 2 px. Ergebnis: 5 brauchbare Bilder r 234–236 (Streuung < 1 px), 7 dunkle mit klarem Grund, beide Diamantring-Fehlfits verworfen. In der Montage werden dunkle Sicheln auf gleiche Helligkeit gestreckt (höchstens 8-fach, Totalität unverändert).

**16-bit-PNG, TIFF, FITS (0.16, 03.11.2026):** 7 Einheitstests schreiben grau/Farbe/BGR mit 8, 12 und 16 bit und lesen jeden Wert zurück (PNG mit pngjs, TIFF und FITS mit eigenem Prüfleser). Gegenprobe mit Pillow 12.3: 16-bit-PNG und -TIFF grau wertgleich, Farbe korrekt (Pillow reduziert 16-bit-Farbe beim Lesen auf 8 bit), TIFF-DateTime und PNG-Software stimmen. Pillows FITS-Leser beachtet weder BZERO noch ROWORDER und dreht die Zeilen – für FITS deshalb Siril/PixInsight als Referenz (Prüfung mit echter Software steht noch aus). App-Volltest: je 3 Bilder als 16-bit-PNG, TIFF und FITS.

**Grosse Ausgaben direkt auf die Platte (0.17, 03.11.2026):** Skript `web/.testdata/big-out.ts` schreibt über `FileSink` mit einer Node-Datei eine SER mit 1100 Bildern 2048 × 1024 × 16 bit (4.6 GB, 3 s) und ein ZIP mit 70 Einträgen à 64 MB (4.7 GB, 11 s). Gegenprobe mit Python: SER-Kopf 1100 Bilder, Dateigrösse, letztes Bild und Zeitstempel stimmen; `zipfile` liest das ZIP64-Archiv, alle CRC in Ordnung, letzter Eintrag bei Offset 4.63 GB. Hinweis: Node `openAsBlob` meldet bei Dateien über 4 GB eine falsche Grösse (modulo 2³²) – darum die Prüfung mit Python. 6 Einheitstests (Platte = Speicher bitgleich mit kleinem Puffer und nachträglichen Korrekturen, Schreibfehler verwirft die Datei, SER-Kopf nachgetragen, ZIP64 hinter 4 GB und ab 65 535 Einträgen). App-Volltest: SER direkt in eine Datei (privater Speicher der Seite statt Dialog).

**Dark/Flat (0.18, 03.11.2026):** `node scripts/make-calibration-testset.mjs .testdata/saturn600.ser .testdata/calibration` erzeugt passend zur Saturn-SER (640 × 640, 8 bit, RGGB) `dark.ser` (6 Bilder, Offset 6, 60 heisse Pixel, ein „kosmischer Strahl“), `flat.ser` (6 Bilder, Vignettierung, Staubring, Bayer-Empfindlichkeit 1/0.85/0.85/0.6) und `bias.ser` (3 Bilder). Prüfung mit der Engine: Strahl im Dark-Master entfernt (6.3 statt 246), heisses Pixel bleibt (186) und wird abgezogen; Saturn kalibriert 100 von 100 Bildern erkannt. 9 Einheitstests (Ausreisser, Bayer-Zellen, Vignettierung und Staub ausgeglichen, Wertebereich, Grösse, Bittiefe). Gefunden und behoben: Flat je 2×2-Zelle auch bei echtem Grau erzeugte ein Schachbrett von ~0.5 % – jetzt nur bei Bayer. App-Volltest mit `--cal`. Echte Darks/Flats einer Kamera fehlen noch.

**FITS (0.20, 04.11.2026):** `node scripts/make-fits-testset.mjs .testdata/saturn600.ser .testdata/fits 30` schreibt die ersten 30 Bilder der Saturn-SER als einzelne FITS-Dateien (16 bit, BZERO 32768, unterste Zeile zuerst ohne ROWORDER, BAYERPAT in Dateireihenfolge, DATE-OBS aus den SER-Zeitstempeln, EXPTIME 0.01). Volltest mit `--fits .testdata/fits`: öffnen (640 × 640, RGGB, 16 bit, Zeit), Planet → beste 50 % als SER. Nachgeprüft: zurückgelesene Werte = SER-Werte × 257, 0 Abweichungen.

**Oberfläche (0.22, 04.11.2026):** `node scripts/make-surface-testset.mjs .testdata/surface/moon_surface.ser` erzeugt eine künstliche Mond-Nahaufnahme (640 × 480, 8 bit grau, 62 Bilder): Kraterlandschaft, Zittern ±12 px, Drift 0.3/−0.2 px je Bild, wechselnde Unschärfe, Rauschen, Bilder 21 und 42 als Wolken ohne Struktur. Engine-Prüfung: 1.8 s, beide Wolkenbilder verworfen (4 % Übereinstimmung), Ausgabe deckungsgleich (mittlere Abweichung 4.5 Graustufen, um 4 px verschoben ≈ 8). Volltest mit `--surface .testdata/surface/moon_surface.ser`; Einheitstests `tests/surface.test.ts` (bekannte Verschiebungen auf ≤ 0.35 px, grosse auf ≤ 1 px). Noch keine echte Mond- oder Sonnenaufnahme.

**Heller Himmel im HDR (0.23, 04.11.2026):** Einheitstests mit künstlicher Totalität und hellem, verlaufendem, bläulichem Himmel (`totalityRadiance` mit `sky`, `skyGrad`, `skyCurve`, `skyTint`; Himmel etwa so hell wie die äussere Korona, 1 : 6 über das Bild): Himmelsmodell höchstens 9 % neben dem wahren Verlauf (nur der gekrümmte Anteil fehlt), HDR-Ergebnis ausserhalb des Mondes im Mittel 0.75 Stufen vom Ergebnis ganz ohne Himmel entfernt, in den Ecken höchstens 5 (ohne Abzug 2.3 und 33). Gleichmässiger Himmel mit Rauschen: kein erfundener Verlauf. Echte Serie Megamovie (King), verglichen mit 0.22: Reihe 5883–84 (f/4.8) – Mond dunkel statt blau, kein grobes Korn mehr, Helligkeit am Rand (Mitte links / rechts) 44 / 177 → 48 / 136, Ecken oben 38 / 164 → 34 / 111; die drei anderen Reihen praktisch unverändert. Vergleichsbild nur lokal: `web/.testdata/real-tot/compare-sky.png`.

**Ankerbox (0.24, 04.11.2026):** Einheitstests: Box wird ins Bild gelegt, zu kleine Box (< 24 px) → ganzes Bild; Szene mit einem zweiten, anders bewegten und stärker strukturierten Bildteil – über das ganze Bild > 2 px daneben, mit Box auf der Oberfläche < 0.5 px; Drift über 40 Bilder bis ≈ 100 px bei einer Box von 100 × 100 px: jedes Bild < 0.5 px (mit 64 px Box bis ≈ 1 px, die Testtextur hat dort kaum Krater); Verarbeitung einer SER mit Box. App-Volltest: Rechteck mit der Maus gezogen (CDP-Mausereignisse), Anzeige „160 × 140 px bei 200, 150“, 60 Bilder, Wolkenbilder verworfen, Deckung 4.53 gegenüber 8.02 bei 4 px Versatz (wie ohne Box), Box gelöscht → Hinweis wieder da.

**FITS-Würfel (0.25, 04.11.2026):** `node scripts/make-fits-testset.mjs .testdata/saturn600.ser .testdata/fitscube/saturn_cube.fits 30` schreibt die ersten 30 Bilder der Saturn-SER als einen Würfel (NAXIS3 = 30, 16 bit, RGGB, DATE-OBS/DATE-END, 24.6 MB). Geprüft: Bilder 1, 14, 30 Pixel für Pixel gleich wie die Einzeldateien, Bildrate aus den Zeiten 29.93 fps. Einheitstests: 3D-Würfel Bayer (Spiegeln, Muster, Zeiten), 4D-Würfel Farbe als Gleitkomma (gleicher Faktor für alle Bilder), ein Bild je Erweiterung mit einer Tabelle dazwischen, NAXIS3 = 3 mit und ohne BAYERPAT. App-Volltest: Würfel öffnen (30 Bilder, 640 × 640, RGGB, 29.9 fps), Betrachter auf Bild 15, Planet → beste 50 % als SER (15 Bilder, Bayer, 448 × 448). Noch nicht mit Würfeln echter Aufnahmeprogramme geprüft.

**Weitere RAW-Formate (0.27, 04.11.2026):** Mit Erlaubnis des Besitzers vier CC0-Muster von [raw.pixls.us](https://raw.pixls.us/) geladen, nur lokal in `web/.testdata/raw/`: `arw-lossy/_DSC0009.ARW` (Sony A7 III, verlustbehaftet, 24 MB), `srw-nx300/nx300.SRW` (Samsung NX300, Kompression 32770 mit Zeilentabelle, 22 MB), `srw-nx100/RAW_SAMSUNG_NX100.SRW` (Samsung NX100, 12 bit gepackt, 26 MB), `raf-bayer/DSCF0617.RAF` (Fujifilm X-A5, Bayer, 14 bit gepackt, 41 MB). Geprüft mit `.testdata/rawnew-check.ts` gegen das eingebettete Kamerabild (Farbkorrelation R/G/B der Farbanteile, Weissabgleich aus dem Bildvergleich gegen den der Kamera):

| Datei | Farbkorrelation | Weissabgleich R/B (Kamera) | Befund |
|---|---|---|---|
| Sony A7 III | 0.49 / 0.73 / 0.65 | 2.23 / 1.66 | wie die verlustfreie ARW (2.45 / 1.54); Bild einwandfrei |
| Samsung NX300 | 0.68 / 0.68 / 0.72 | 2.26 / 1.68 (2.51 / 1.74) | Muster laut Tag RGGB falsch, richtig GRBG; Ausschnitt der MakerNote ragt über den Sensor – Lage des Kamerabilds gemessen: links 52, oben 29 |
| Samsung NX100 | 0.95 / 0.91 / 0.94 | 2.05 / 0.97 (1.92 / 0.97) | Schwarz 0 (Wert der MakerNote, rund 390, passt nicht) |
| Fujifilm X-A5 | 0.58 / 0.71 / 0.77 | 1.41 / 2.12 (1.64 / 1.99) | Packung: von sechs Varianten nur „32-bit-Wörter Little Endian, höchstes Bit zuerst“ glatt; Muster RGGB ab Sensorpunkt 0,0 |

Einheitstests `tests/rawformats.test.ts`: Kodierer für Sony-Blöcke und Samsung-Zeilen (bitgenau zurückgelesen), gepackte 12/14 bit, Echtdateien (Format, Grösse, Muster).

**Kalibrierung, Oberfläche, Zuletzt geöffnet (0.28, 04.11.2026):** Einheitstests `tests/session028.test.ts`: Dark-Skalierung mit künstlichem Sensor (Sockel 1000, Wärme 50 bzw. 2000 e/s im heissen Pixel, Bild 4 s, Dark 2 s) – mit Bias genau 0 Rest, mit Median als Sockel ist das heisse Pixel weg; Master-FITS hin und zurück (Bayer 12 bit, RGB, Belichtung, Anzahl) und fremder Gleitkomma-Master; Drehung 0.5–2° auf < 0.08° und < 0.6 px; Drehung 0→12° in 12 Schritten auf < 0.5; Struktur wandelt sich in 30 Bildern ganz in eine andere Landschaft – mit Nachführen am Ende < 1 px und Übereinstimmung > 0.3, ohne < 0.2; ein Dunstbild wird nicht Referenz. Volltest: Master Dark speichern (FITS-Kopf geprüft) und wieder laden (gleiche Angaben), Oberfläche mit Drehungsausgleich (Protokollspalte `rotation_deg`, Winkel < 1° bei der nur verschobenen Testserie), Datei über Handle öffnen, App neu laden, aus „Zuletzt“ wieder öffnen.

**WinJUPOS-Namen und Tonwerte (0.29, 05.11.2026):** Einheitstests `tests/session029.test.ts`: Zeitstempel mit Rundung auf die Zehntelminute und Übertrag über Tag/Jahr, Beobachter/Angabe mit ungeeigneten Zeichen, Beginn/Mitte/Ende, Zeit aus sechs Arten von Dateinamen (und ungültige); Breite × Höhe mit und ohne Seitenverhältnis, nach dem Drehen; Verstärkung mit Abschneiden, Gamma, Strecken mit heissem Pixel, Schwarzpunkt bei 12 bit, je Farbe bei RGB und Bayer RGGB (bleibt roh). Volltest mit `saturn600.ser` (Aufnahme 00:55:17 UT): SER heisst wie der Beispielname in der App (`2022-10-25-0055_3-JS-Sat.ser`), 300 × 300 farbig; PNG-ZIP und Einzelbilder mit Zeit vorne; nur Tonwerte → SER bleibt Bayer RGGB.

**Echte partielle Finsternis 12.08.2026 (05.11.2026 geladen, nicht im Repo):**
- Metz, Vespera (azimutale Montierung) und Hestia mit iPhone: Zenodo [21916192](https://zenodo.org/records/21916192), Olivier Parisot (LIST), CC BY-SA 4.0. 5250 JPEG 1920 × 1080 von 17:04 bis 18:52 (Zeit nur im Dateinamen, kein EXIF-Datum) und 48 iPhone-Bilder; Ordner `web/.testdata/eclipse-metz`. Prüfung mit jedem 50. Bild (`.testdata/metz-check.ts`): Die Feinsuche des Sonnenrands brach bei diesem Teleskop ab, weil die Sonne am Rand nur gut halb so hell ist wie in der Mitte (Randabfall: Mitte 158, Rand 70–90) – Sicheln von 17:33 bis 17:55 galten als Vollscheibe, in der tiefen Phase war der Radius um 2 % zu gross. Behoben (innen genügt jetzt 30 % statt 50 % der Spanne Hintergrund–Scheibe, Einheitstest „starker Randabfall“): sichtbarer Rand fällt gleichmässig von 100 % auf 45 % (Maximum 18:15) und steigt wieder, Radius 315 ± 1 px bis 18:15; danach wird die tief stehende Sonne durch die Lichtbrechung oval (Kreis-Radius sinkt bis 293 px, Streuung bis 3.7 px); ab 18:43 (Sonnenhöhe unter 3°) sehr dunkel und unregelmässig, als „zu dunkel“ verworfen (9 von 105). Feldrotation (`.testdata/metz-spots.ts`, Richtung zwischen den zwei grössten Sonnenflecken): −0.54° in 28 min (17:05–17:33, danach Flecken vom Mond verdeckt), berechnet für eine azimutale Montierung 0.4° (Sonne fast im Westen) – die Vespera dreht nicht zurück, die Rotation ist aber für einen Test des Drehungsausgleichs zu klein.
- GONG Hα, Station El Teide (Teneriffa): 67 Bilder 17:50–18:56 UT (erster Kontakt 17:57, Maximum 70 % um 18:53, Sonne tief), 2048 × 2048, 16 bit, FITS mit Rice-Kompression (`.fits.fz`, Zeilenkacheln 2048 × 1, BLOCKSIZE 32), seit 0.30 lesbar; Ordner `web/.testdata/gong-teide`. Bildfeld durch einen Rotator nachgeführt – keine Feldrotation. Vor der Finsternis rechnet GONG die Bilder auf r = 900 px und Mitte 1024 um (`RADIUS = 900`); mit `ECLIPSE = 1` bleiben sie unbearbeitet: r ≈ 881 px (Leitrohr `GTCLMBRA` 881.45), die Sonne wandert im Bild und läuft teils über den Rand. Prüfung (`.testdata/gong-check.ts`, `gong-pipeline.ts`): Entpacken 0.25 s je Bild, Bild sichtbar richtig (Filamente, Protuberanz). Zwei Schwächen der Randsuche gefunden und behoben: (1) die Sonne füllt 60 % des Bildes – der Median als Hintergrund lag auf der Scheibe, jetzt dann das dunkelste Zwanzigstel; (2) nach dem Wurzelziehen linearer Daten ist die Kante der Blende (schwarz → grau) steiler als der Sonnenrand – der steilste Anstieg zählt jetzt nur, wo es innen hell ist. Danach alle 67 Bilder angenommen, r = 902 px (Vollscheibe) bzw. 879–883 px (Finsternis), Streuung < 2 px. Gegenprobe: Metz unverändert, eigene Serie 12.08.2026 gleiche Bilder verworfen, Mitten ≤ 0.3 px verschoben. Dank an GONG bei Veröffentlichungen nötig: „Data were acquired by GONG instruments operated by NISP/NSO/AURA/NSF with contribution from NOAA.“

**Weitere RAW-Muster (0.30, 05.11.2026, Erlaubnis des Besitzers):** sechs CC0-Dateien von [raw.pixls.us](https://raw.pixls.us/) in `web/.testdata/raw-more` (NX2000 zusätzlich in `raw/srw-nx2000`): Samsung NX2000 und NX300M, Sony DSLR-A100, Fujifilm FinePix S5Pro, F550EXR, X10. Ergebnis (`.testdata/rawnew-check.ts`, `rawnew-align.ts`, `cfa-probe.ts`):
- NX2000: Kompression 32770 mit Zeilentabelle wie NX300; Sensor 5536 × 3714, Kamerabild 5472 × 3648 ab links 40, oben 24 (Korrelation 0.978); danach Farbkorrelation 0.90/0.86/0.95 mit GRBG, Weissabgleich 2.25/1.62 (Kamera 2.35/1.68).
- NX300M: wie NX300 (Sensor 5546 breit), Lage gemessen links 54, oben 28 – 2 px neben dem NX300-Wert, bleibt.
- DSLR-A100: Rohdaten-IFD verschlüsselt, nicht unterstützt (Kamerabild wird verwendet).
- X10, F550EXR (EXR): unkomprimiert, Bildausschnitt passt, Farbmuster aber kein 2×2-Bayer; Korrelation je Lage im 4×4-Feld schwach und widersprüchlich (Gegenprobe X-A5: RGGB klar erkannt) – nicht unterstützt. Bis 0.29 wurden sie als Bayer mit falschen Farben gelesen; jetzt erkannt am RAF-Satz 0x112 (fertiges Bild rund 1.4-mal so breit wie die Rohdaten) → Kamerabild.
- S5Pro (SuperCCD): nicht unterstützt.
