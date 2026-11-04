# Windows-App (.exe)

Astrotool für Windows 10/11 ist eine Tauri-2-App: dieselbe Oberfläche wie die Web-Version (`web/src`) in einem nativen Fenster mit WebView2 (in Windows 11 enthalten). Nativ ergänzt wird nur, was eine Webseite nicht darf, z. B. Hilfsprogramme wie FFmpeg per winget installieren (Menü „Tools & Setup“).

**Für Anwender:** Installer `Astrotool_<version>_x64-setup.exe` ausführen – keine weiteren Programme nötig. Installation pro Benutzer, ohne Administratorrechte. Installer auf Englisch oder Deutsch.

## Bauen (nur Entwicklungsrechner)

Einmalig:

```powershell
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
cd web
npm install
```

Dann:

```powershell
cd web
npm run app:dev      # App mit Live-Neuladen starten
npm run app:build    # Installer bauen
```

Ergebnis (Build-Ordner ausserhalb von „Dokumente“, siehe unten):

- `%LOCALAPPDATA%\astrotool-build\release\astrotool.exe` – die App selbst (startet ohne Installation, braucht WebView2)
- `%LOCALAPPDATA%\astrotool-build\release\bundle\nsis\Astrotool_<version>_x64-setup.exe` – Installer zum Weitergeben

**Warum ausserhalb von „Dokumente“?** Windows setzt bei „Dokumente“ und Unterordnern oft das Attribut „schreibgeschützt“, das neue Ordner erben. Einige Rust-Build-Skripte (`autocfg`) brechen dann mit „output path is not a writable directory“ ab. `web/scripts/tauri.mjs` setzt deshalb `CARGO_TARGET_DIR` auf `%LOCALAPPDATA%\astrotool-build` und ergänzt `~\.cargo\bin` im PATH.

**Hinweis Claude-Desktop-App:** Wird der Build aus der Claude-App heraus gestartet, leitet Windows `%LOCALAPPDATA%` in den App-Container um (`AppData\Local\Packages\Claude_…\LocalCache\Local\astrotool-build`). Fertige Versionen werden deshalb nach `REA\Astrotool-App\<version>\` kopiert (Installer, portable .exe, LIESMICH).

## Bekannte Unterschiede zur Browser-Version

- **H.265/HEVC-Kodierung** kann WebView2 nicht (Chrome schon). Seit 0.6 übernimmt in der App das lokale FFmpeg: Die Oberfläche rendert die Bilder wie gewohnt und reicht sie roh an `ffmpeg` weiter (`src-tauri/src/hevc.rs`, Befehle `hevc_begin/frame/finish`). Encoder-Wahl automatisch: `libx265` → `hevc_amf` → `hevc_nvenc` → `hevc_qsv` → `hevc_mf` (der erste, der auf dem Rechner wirklich läuft). Ergebnis: hvc1, Main, 30 fps konstant, fast start, Aufnahmedatum und Titel. Ohne FFmpeg: automatisch H.264.
- „Tools & Setup“ zeigt installierte Hilfsprogramme mit Pfad und installiert fehlende per Knopfdruck (getestet: FFmpeg erkannt).

## Installer-Test auf einem frischen Windows-Konto (von Hand)

Prüft, was der automatische Test nicht kann: Installation ohne Entwickler-Werkzeuge, ohne gespeicherte Einstellungen und ohne FFmpeg. Dauer etwa 20 Minuten. Das Konto legt man selbst an (Einstellungen → Konten → Andere Benutzer → „Konto hinzufügen“ → „Ich kenne die Anmeldeinformationen nicht“ → „Benutzer ohne Microsoft-Konto hinzufügen“, Standardbenutzer, kein Administrator).

1. **Vorbereiten:** `Astrotool_<version>_x64-setup.exe` und ein paar Testdateien (kleine SER, einige Finsternis-JPG) in einen Ordner legen, den das neue Konto lesen kann (z. B. `C:\Users\Public\Documents`). Mit dem neuen Konto anmelden.
2. **Installieren:** Installer starten. Erwartet: SmartScreen-Warnung möglich („Weitere Informationen“ → „Trotzdem ausführen“, solange nicht signiert), **keine** Abfrage nach Administratorrechten, Sprache Deutsch/Englisch wählbar, Installation in `%LOCALAPPDATA%\Astrotool`.
3. **Startmenü und Start:** Eintrag „Astrotool“ im Startmenü, App startet ohne Fehlermeldung, Version im Über-Dialog stimmt, Oberfläche in der Systemsprache, Sprachwechsel geht.
4. **Ohne Hilfsprogramme:** „Tools & Setup“ zeigt FFmpeg als nicht installiert. Finsternis-Bilder öffnen, Vorlage „Finsternis“, Zeitraffer erzeugen → läuft mit H.264 statt H.265 (Hinweis in der Oberfläche).
5. **Verarbeiten und speichern:** kleine SER öffnen, Vorlage „Planet“, Ergebnis speichern; Datei landet im gewählten Ordner und lässt sich wieder öffnen.
6. **FFmpeg per Knopfdruck (freiwillig):** in „Tools & Setup“ installieren (winget, Windows fragt evtl. nach) → nach Neustart der App „installiert“, Zeitraffer jetzt H.265.
7. **Neu starten:** App schliessen und wieder öffnen – Sprache und Nachtmodus bleiben erhalten.
8. **Deinstallieren:** Einstellungen → Apps → Astrotool → Deinstallieren. Erwartet: keine Administratorrechte, Startmenü-Eintrag weg, `%LOCALAPPDATA%\Astrotool` weg. Den Datenordner `%LOCALAPPDATA%\ch.aisuisse.astrotool` (WebView2-Profil) entfernt der Deinstaller nur, wenn man „App-Daten löschen“ ankreuzt – beides notieren.
9. **Aufräumen:** abmelden, Testkonto in den Einstellungen wieder entfernen.

Ergebnis (Datum, Windows-Version, Abweichungen) in `docs/testdaten.md` festhalten.

## Automatischer Test der .exe

```powershell
cd web
node scripts/app-e2e.mjs <Pfad\astrotool.exe> <Bilderordner> <ausgabe.mp4> [hevc|h264|gif]
```

Startet die App mit lokalem WebView2-Debug-Port, wählt die Bilder wie über „Öffnen“, setzt die Vorlage „Finsternis“, erzeugt den Zeitraffer und speichert ihn. Ergebnis 02.11.2026 mit 77 Finsternis-Bildern: H.265/HEVC (FFmpeg libx265), 1080 × 1080, 11.1 s, 0.38 MB, 4 Bilder begründet verworfen, Laufzeit 90 s.

### Vollständiger Testdurchgang

```powershell
cd web
node scripts/make-totality-testset.mjs .testdata\totality   # einmalig: künstliche Totalitäts-Serie
node scripts/app-fulltest.mjs <Pfad\astrotool.exe> <ausgabeordner> --ser <klein.ser> --images <Bilderordner> [--big <gross.ser>] [--totality <Pfad>\.testdata\totality]
```

Bedient die App wie ein Mensch und prüft: Version im Über-Dialog, Sprachwechsel, Werkzeug-Status, Ablehnung von AVI, Betrachter (Wiedergabe, Marker per Tastatur, Bereich als SER roh/farbig und PNG speichern, Bereich übernehmen), Vorlagen Planet (SER Bayer roh, SER farbig, PNG, Zeitraffer HEVC), Nur sortieren, `.pof`-Import, Sonne/Mond, Finsternis (PNG, HEVC, GIF, H.264), AVI (grau, MJPEG, 4 GB) und MP4, optional Totalität (Mondrand, HDR-Belichtungsreihen) und ein grosses SER. Mit `--only <muster>` laufen nur die passenden Tests. Ergebnis: `bericht.json`, Videos und bei Fehlern ein Bildschirmfoto im Ausgabeordner. Dateipfade immer absolut übergeben (das Skript wandelt sie um) – mit relativen Pfaden blieb die Seite in einem frühen Lauf hängen.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `web/src-tauri/tauri.conf.json` | Name, Version, Fenster, Installer (NSIS, EN/DE, pro Benutzer) |
| `web/src-tauri/src/lib.rs` | native Befehle `tools_status`, `install_tool` (nur feste winget-IDs) |
| `web/src-tauri/src/hevc.rs` | HEVC-Kodierung über das lokale FFmpeg |
| `web/src-tauri/icons/` | App-Symbole, erzeugt aus `icon-source/icon.png` mit `npx tauri icon` |
| `web/src/tools.ts` | erkennt die App (`__TAURI_INTERNALS__`) und zeigt dann „Installieren“-Knöpfe |

## Offen

- Code-Signatur (ohne Signatur warnt Windows SmartScreen beim ersten Start)
- Automatische Updates (Tauri Updater)
- Native Dateidialoge und direktes Schreiben grosser Dateien (statt Download)
