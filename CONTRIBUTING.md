# Contributing to Astrotool

Thank you for helping! The most valuable contributions right now are **test recordings and bug reports**.

## Test recordings

Especially welcome:

- solar eclipse series (partial phases and totality, with or without exposure brackets),
- camera RAW files from models whose sensor data Astrotool cannot read yet (Nikon-compressed NEF, Canon CR3, Fujifilm RAF, Olympus ORF, Panasonic RW2, Pentax PEF),
- SER/AVI captures from planetary cameras that do not open or look wrong.

Please state the camera, lens/telescope and whether we may use the files in automated tests (they are never added to the repository without your permission).

## Bug reports

Open an issue with the Astrotool version (*About* dialog), Windows version, what you did, what you expected and what happened. The log file `astrotool_log.csv` from the output is often helpful.

## Code contributions

Astrotool is licensed under GPL-3.0-or-later. To keep the option of offering Astrotool under an additional licence later, code contributions can only be accepted together with a **contributor licence agreement (CLA)**: you keep your copyright, and grant the project the right to distribute your contribution under the GPL and other licences. See [CLA.md](CLA.md) – it is still a draft and will be finalised before the first external pull request is merged.

Ground rules:

- No code from PIPP, SER Player or other closed or incompatibly licensed software. Implement from public specifications and literature, and name your sources in the code comments.
- Ask in an issue before adding a new dependency.
- Add or update tests (`cd web && npm test`), and run the type check (`npx tsc --noEmit`).
- Keep the engine (`web/src/engine`) free of DOM dependencies.
