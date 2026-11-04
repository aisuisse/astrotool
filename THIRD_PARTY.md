# Third-party components

Astrotool is licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)), © 2026 aisuisse.
Astrotool contains no code from PIPP or SER Player; their functions were re-implemented independently.

Libraries shipped with or built into Astrotool (all compatible with the GPL v3):

| Component | Purpose | Licence |
|---|---|---|
| [Tauri](https://tauri.app) | Windows app (window, WebView2, native commands) | MIT / Apache-2.0 |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | reading MP4/MOV/MKV/WebM, writing MP4/WebM (WebCodecs) | MPL-2.0 |
| [gifenc](https://github.com/mattdesl/gifenc) | animated GIF | MIT |
| Rust crates (via Tauri) | see `web/src-tauri/Cargo.lock` | MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, MPL-2.0 (all 406 crates in the lock file checked on 4 Nov 2026; none GPL-incompatible) |

Not shipped, only called when present:

| Program | Purpose | Licence |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) | H.265/HEVC encoding in the Windows app | LGPL/GPL (depending on the build) |
| Microsoft Edge WebView2 | rendering in the Windows app | Microsoft licence, part of Windows 11 |

Development only (not part of the app): Vite, TypeScript, Vitest, jpeg-js, pngjs, rea.

Own implementations (no third-party code): SER reader/writer, AVI reader (RIFF/OpenDML), TIFF/DNG/CR2/ARW/CR3/RAF parsing, lossless-JPEG decoder (ITU-T T.81), debayer and X-Trans colour reconstruction, FITS reader (single images, cubes, extensions) and writer, 16-bit PNG/TIFF writer, limb fitting, HDR merge with sky model, FFT and surface alignment, dark/flat calibration, viewer.

## Provenance of the camera RAW decoders

| Decoder | Basis |
|---|---|
| DNG, Canon CR2, Sony ARW (lossless) | published specifications: TIFF 6.0, Adobe DNG specification, ITU-T T.81 (lossless JPEG); layout details (CR2 slices, Sony 2×2 tiles, Canon sensor area) checked against the files themselves |
| Nikon NEF (compression 34713), Samsung SRW (compression 32773) | no manufacturer specification exists. The algorithms (Huffman trees and curve for Nikon, block coding for Samsung) were written from general knowledge of these formats, which is publicly documented mainly through open-source decoders such as dcraw, LibRaw and RawSpeed. No source code was copied, and the implementation was verified against the camera's own JPEG. Projects with a strict clean-room rule (no knowledge from those decoders) should treat these two decoders as **not clean-room**. |

If a second licence is ever offered, these two decoders are the parts to review first.
