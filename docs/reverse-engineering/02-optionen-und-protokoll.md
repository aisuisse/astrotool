# 02 – Optionen und GUI↔Engine-Protokoll

Quelle: String-Literale von `PIPP.exe` (rea `inspect-managed-members`), Methodennamen von `Form1`, Ausgabe von `pipp_core.exe -help`.

## Ablauf einer Verarbeitung

1. GUI startet `pipp_core.exe -gui` (bzw. `-gui -test_run` für den Testlauf).
2. `send_arguments_to_pipp_process` schreibt die Schalter auf stdin, `send_source_files_to_pipp_process` danach die Dateiliste.
3. Dark-/Flat-Frames werden vorher über `pipp_dll.stack_frames` zu Master-Frames gestapelt und als Temp-Dateien übergeben (`-dark_tmp=`, `-dark_pgm=`, `-flat_tmp=`, `-flat_dark_tmp=`, `-temp_dir=`).
4. Die Engine meldet Status als Zeilen auf stdout:

| Meldung | Bedeutung |
|---|---|
| `@PROGRESS=` | Fortschritt in % |
| `@PFILE=`, `@PFILELAB=`, `@FNAMELAB=` | aktuelle Datei |
| `@PFRAMELAB=`, `@FNUM=`, `@FCNT=` | aktueller Frame / Anzahl |
| `@QSORT=`, `@QSFRAMESLAB=` | Qualitätssortierung |
| `@ANIM=` | Animations-Erzeugung |
| `@XPOS=`, `@YPOS=` | erkannte Objektposition (Testlauf) |
| `@MAX_PIXEL=`, `@MAX_R/G/B_PIXEL=` | Maximalwerte (Testlauf) |
| `@DETECT_THRESHOLD=` | automatisch bestimmte Schwelle |

Alle anderen Zeilen landen im Log-Fenster. Ende: `PROCESSING COMPLETE` / `CANCELLED` / `FAILED WITH ERRORS`.

## Schalter der Engine (Version 2.5.9)

Die eingebaute Hilfe ist veraltet (zeigt nur ~40 Optionen). Die GUI erzeugt tatsächlich diese Schalter:

**Eingabe / Kalibrierung**
`-join` · `-f=` (Frames) · `-sf=` (Startframe) · `-ifd=` (Input-Frame-Drop) · `-mono` / `-colour` · `-y8` · `-ser_bpp=8…16` · `-dark` `-save_dark` `-dark_bayer` `-hot_pixel=` · `-flat` `-save_flat` `-flat_bayer` · `-flat_dark` `-save_flat_dark` · `-bin=` `-bin_sum` · RAW: `-raw_hpf` `-raw_db=` `-raw_ocs=` `-raw_hl=` · Debayer: `-db` `-db=` (0 GBRG, 1 BGGR, 2 RGGB, 3 GRBG) `-db_type=` `-pb` (Bayer schützen) · Datum/Zeit für WinJUPOS: `-wjpos_dtmask=` `-wjpos_lt2ut` `-wjpos_ipfps=` `-wjpos_time=`

**Verarbeitung**
`-input_gain=` · `-gamma=` · `-median` · `-chk` (Objekt prüfen) · `-ms=` (Mindestgrösse) · `-mp=` (Schwelle) · `-oe=` (überbelichtete Pixel) · `-freject` · `-ctr` (zentrieren) · `-shdw=` (Rand im Schatten) · `-cx=` `-cy=` `-ox=` `-oy=` (Zuschnitt) · Stabilisierung: `-en_ss` `-en_surface_feature_tracking` `-afb_x/y/width/height=` (Ankerbox) · AOI: `-aoi` `-aoi_x/y/width/height=` `-aoi_reject` `-aoi_crop` · `-hs=` `-hs_bp` `-hsrgb` (Histogramm-Streckung) · `-convmono=0…6` · `-flip_x` `-flip_y` `-rotate90/180/270` · `-resize_en` `-resize_width=` `-resize_height=`

**Qualität**
`-q` `-q=` (beste N) `-qpcnt=` (beste N %) · `-qmin=` `-qmax=` `-qinc=` (Downsampling, Standard 3/5/1) · `-qold` (Ninox) `-qhisto` `-qtotal` · `-qw` (Gewichtung) · `-nr` (nicht umnummerieren)

**Ausgabe**
`-od=` `-osubdir=` `-op=` `-os=` · Format: `-bmp` `-tif` `-png` `-fits` `-ser` `-avi` `-gif` · `-rgb` (RGB-Split) · `-drop=` · `-avi_codec=` `-avi_quality=` `-avi_old` `-avi_old4` `-avi_safe_width` · `-auto_fps` `-fps_rate=` `-fps_scale=` · GIF: `-gif_quant_type=` `-gif_border_tol=` `-gif_trns_pxl_tol=` `-gif_col_tbl_depth=` `-gif_lossy_comp=` · `-keepimgname` `-nlz` (keine führenden Nullen) `-incqv` (Qualitätswert im Namen)

**Animation**
`-anim_fwd` `-anim_rev` `-anim_fwd_lf_rep=` `-anim_rev_lf_rep=` `-anim_all_rep=` `-anim_all_rep_always` `-no_anim_rev_last_rep`

**Sonstiges**
`-gui` `-test_run` `-sdp` `-no_ram_buff` `-temp_dir=` `-sr` (abgelehnte Frames speichern)

## Optionsdatei `.pof`

Textdatei, erste Zeile `[PIPP OPTIONS FILE]`, danach eine Zeile `SCHLÜSSEL Wert` pro Option (ca. 180 Schlüssel, z. B. `PLANETARY_MODE`, `CENTRE_PLANET`, `CROP_WIDTH`, `QUALITY_FRAMES`, `OUTPUT_SER`). Die Vorlagen-Modi der GUI sind `PLANETARY_MODE`, `FULLDISC_MODE` (Sonne/Mond), `CLOSEUP_MODE`, `PLANETARY_ANNIMATION_*`, `ISS_MODE`, `AVI_ARCHIVE_MODE`.

Die neue Anwendung soll `.pof`-Dateien **importieren** können, damit bestehende Einstellungen weiter nutzbar sind. Die vollständige Schlüsselliste steht in `re/evidence/gui_literals.txt`.

## Unterstützte Formate (2.5.9)

- Eingabe: SER, AVI (inkl. Y800/BY8), weitere Videos über FFmpeg (MOV, MP4, MKV, MTS …), BMP, TIFF, PNG, JPG, FITS (8/16/32-bit float), Kamera-RAW (`3fr arw cr2 crw dcr dng erf orf raf raw rw2 nef nrw mef mos mrw pef x3f`), Magic Lantern MLV.
- Ausgabe: SER, AVI (DIB, FMP4), BMP, TIFF, PNG, FITS, animiertes GIF.
