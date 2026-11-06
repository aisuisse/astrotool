# Texts for the GitHub repository page

Description and topics were set on GitHub on 3 Nov 2026. The repository is public; the website field points to the latest release, and the social preview image was uploaded on 6 Nov 2026. Release checklist: [../reverse-engineering/03-roadmap.md](../reverse-engineering/03-roadmap.md).

## Description (About box, max. 350 characters)

> Pre-processing for planetary, lunar, solar and eclipse imaging – a modern successor to PIPP. Centres, crops and ranks frames from SER, AVI, MP4, JPG and camera RAW; aligns eclipse series on the solar or lunar limb, merges totality brackets to HDR and creates shareable time-lapses. Windows app, runs fully offline. GPL-3.0.

Short version (e.g. for the social preview or a list):

> Modern successor to PIPP: align, rank and crop planetary, solar and eclipse recordings – with HDR for totality and shareable time-lapses.

## Website

Leave empty for now, or link to the latest release: `https://github.com/aisuisse/astrotool/releases/latest`

## Topics

```
astrophotography, astronomy, planetary-imaging, solar-eclipse, eclipse, lucky-imaging, image-processing,
ser, pipp, autostakkert, hdr, timelapse, raw-image, debayer, tauri, typescript, windows
```

## Social preview image

`docs/github/social-preview.png` (1280 × 640 px, 6 Nov 2026): app name, tagline and drawn graphics only – the ringed planet of the app icon and the phases of an eclipse, no photos. Source: `social-preview.html` in the same folder (render with a headless Chromium browser at 1280 × 640). Upload by hand: GitHub → repository Settings → General → Social preview → Edit → Upload an image.

## Release notes – first public release

Version number: the one current at publication (written for 0.25.0, 4 Nov 2026 – update the numbers below if a later version is released).

**Astrotool 0.25.0** – first public release

Pre-processing for planetary, lunar, solar and eclipse imaging, as a native Windows 10/11 app. Download the installer (`Astrotool_0.25.0_x64-setup.exe`, per user, no admin rights) or the portable exe.

What it does
- Finds the object in every frame, centres and crops it, rejects unusable frames, ranks the rest by sharpness and keeps the best – ready for AutoStakkert!, RegiStax or PlanetarySystemStacker.
- Reads SER, AVI (also > 4 GB), MP4/MOV/MKV/WebM, JPG/PNG/TIFF, FITS (single images and cubes) and camera RAW (sensor data from DNG incl. Fujifilm X-Trans, CR2, ARW, NEF, SRW and uncompressed RAF; for CR3 and compressed RAF the embedded image is used, or convert to DNG).
- Writes SER, PNG (8/16 bit), 16-bit TIFF and FITS with capture time, exposure and Bayer pattern.
- Eclipse mode: circle fit to the solar limb – on real data 1.1 px from the true centre where PIPP is 170 px off. Totality: alignment on the lunar limb, HDR from exposure brackets with the sky glow and its gradient removed, phase montage.
- Surface stabilisation for lunar and solar close-ups without a full limb, with an optional anchor box.
- Dark and flat calibration, time-lapses as H.265/H.264 MP4 with capture time, WebM or GIF.
- Viewer with 30 fps playback, markers, debayer, histogram, export to disk; PIPP `.pof` import; English and German UI; red night mode.

Known limitations
- Not code-signed yet – Windows SmartScreen may show "Windows protected your PC" on first start: click **More info** → **Run anyway**. Only download Astrotool from this releases page.
- No RAW sensor data for CR3 and compressed RAF (formats not publicly described).
- Surface stabilisation and FITS cubes are tested with synthetic and converted data, not yet with recordings from many capture programs – test files are welcome.

Tested with an automated end-to-end run of the finished exe (40 checks: SER up to 3.7 GB, AVI up to 4 GB, MP4, RAW from six camera makers, FITS, partial eclipse and totality series, surface stabilisation) and 123 unit tests.
