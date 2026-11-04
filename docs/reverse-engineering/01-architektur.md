# 01 – Architektur von PIPP 2.5.9

Analysiert: `C:\Program Files\PIPP` (64-bit-Installation, Version 2.5.9 vom 7. Jan. 2017).
Werkzeug: [rea](https://github.com/morluto/rea) 6.8.0, nur statische Analyse (PIPP wurde nicht ausgeführt, ausser `pipp_core.exe -help`).
Belege neu erzeugen: `bash re/scripts/extract-evidence.sh`.

## Bausteine

| Datei | Art | Aufgabe |
|---|---|---|
| `PIPP.exe` | .NET Framework 4 (C#, WinForms), IL-only, x64 | Nur die Oberfläche. Keine nativen Imports. |
| `pipp_core.exe` | natives C/C++, x64, Konsolenprogramm | Die eigentliche Bildverarbeitung. Wird von der GUI als Kindprozess gestartet. |
| `pipp_dll.dll` | natives C/C++, x64 | Hilfsfunktionen, die die GUI direkt per P/Invoke aufruft (Datei-Infos, Vorschau). |
| `av*-57/55.dll`, `sw*.dll` | FFmpeg 3.x (Dez. 2016), LGPL | Video lesen/schreiben (AVI, MOV, MP4 …). |
| (eingebettet) | dcraw 9.27 | Kamera-RAW-Dateien (CR2, NEF, DNG …). |

```
┌────────────── PIPP.exe (.NET / WinForms) ──────────────┐
│  Form1: Tabs Source/Input/Processing/Quality/Output/…  │
│  generate_cmdline_options_*()  →  Argumentliste        │
└───────┬───────────────────────────────┬────────────────┘
        │ P/Invoke (c_dll)              │ Kindprozess, stdin/stdout
        ▼                               ▼
  pipp_dll.dll                   pipp_core.exe -gui
  ser_info, avi_info,            liest Optionen + Dateiliste von stdin,
  fits_info, video_check,        meldet Fortschritt als "@SCHLÜSSEL=Wert"
  stack_frames (Dark/Flat) …     auf stdout
        │                               │
        └──────────── FFmpeg 3.x + dcraw ┘
```

## .NET-Oberfläche (PIPP.exe)

35 Typen, 400 Methoden, 1795 String-Literale. Wichtigste Klassen:

- `Form1` – Hauptfenster (167 Methoden). Pro Tab gibt es je ein `reset_*_options` und ein `generate_cmdline_options_*_tab`. Die GUI übersetzt also jede Einstellung in Kommandozeilen-Schalter für die Engine.
- `c_dll` – 13 P/Invoke-Funktionen in `pipp_dll.dll`: `get_pipp_version`, `get_dcraw_version`, `raw_decode_check`, `date_time_check`, `video_check`, `ser_check`, `ser_info`, `avi_info`, `fits_info`, `stack_frames`, `set_progress_fn`, `set_gui_print_fn`, `set_abort_request`.
- `testrunForm` – Testlauf-Dialog mit Vorschau (`pipp_input_frame.bmp` / `pipp_output_frame.bmp` im Temp-Ordner).
- `c_filelist`, `cListViewColumnSorter`, `cFileInfoBox` – Dateilisten.
- `cPersistentData` – speichert Einstellungen in `pipp.config`.
- `MessageBoxEx` – eigene MessageBox per Win32-Hook (eine Ursache für Darstellungsprobleme unter Windows 11 / HiDPI).

## Engine (pipp_core.exe)

- Importiert nur `KERNEL32`, `WS2_32` (Netzwerk, vermutlich nur für Zeitfunktionen) und FFmpeg.
- Video-Ausgabe nutzt `avcodec_encode_video2` (FFmpeg 3-API, heute entfernt).
- AVI-Codecs in der GUI: nur **DIB (unkomprimiert)** und **FMP4** (MPEG-4 Part 2). Kein FFV1, H.264/H.265, AV1.
- Eingebauter dcraw-Code (Hilfetext von dcraw ist in der Binärdatei enthalten).
- Qualitätsverfahren: Standard (Downsampling-basiert), „Ninox“ (Original-Algorithmus aus dem quelloffenen Ninox von Anthony Wesley), Histogramm-Spitze, Gesamthelligkeit.

## Folgerungen für die Neuentwicklung

1. Die Trennung GUI ↔ Engine über einen klar definierten Schalter-Satz ist gut und wird übernommen: eine **Engine mit Options-Objekt** (siehe [02-optionen-und-protokoll.md](02-optionen-und-protokoll.md)), darauf eine Web-Oberfläche und später eine Windows-Oberfläche.
2. Die Algorithmen selbst sind im nativen Code. Für eine genaue Nachbildung (Planetenerkennung, Qualitätsmass, Oberflächen-Stabilisierung) braucht es einen Decompiler (Ghidra) – siehe [03-roadmap.md](03-roadmap.md).
3. FFmpeg 3 und die WinForms-MessageBox-Hooks sind die Hauptgründe für die Probleme unter Windows 11. Beides fällt in der Neuentwicklung weg.
