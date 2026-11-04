#!/usr/bin/env bash
# Erzeugt die Analyse-Belege für PIPP 2.5.9 neu (statisch, ohne PIPP auszuführen).
# Aufruf:  bash re/scripts/extract-evidence.sh ["C:/Program Files/PIPP"]
# Ergebnis: re/evidence/ (nicht im Git, enthält Daten aus fremden Binärdateien)
set -euo pipefail

PIPP_DIR="${1:-C:/Program Files/PIPP}"
REA="${REA:-node $HOME/tools/rea-agents/node_modules/rea-agents/scripts/rea.mjs}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/evidence"
mkdir -p "$OUT"

# 1. Native Imports (zeigt: Engine nutzt FFmpeg 3.x, GUI ist .NET)
for f in PIPP.exe pipp_core.exe pipp_dll.dll; do
  $REA inspect-pe-imports "$PIPP_DIR/$f" --json > "$OUT/imports_$f.json"
done

# 2. .NET-Oberfläche: Identität, Typen, Methoden, String-Literale
$REA inspect-managed-artifact "$PIPP_DIR/PIPP.exe" --json > "$OUT/managed_artifact.json"
$REA inspect-managed-members  "$PIPP_DIR/PIPP.exe" --json > "$OUT/managed_members.json"

# 3. Literale als Textliste (eine Zeile pro ldstr)
python -I - "$OUT/managed_members.json" > "$OUT/gui_literals.txt" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))["normalized_result"]
for x in m["user_strings"]["literals"]:
    print(repr(x["value"]))
EOF

# 4. ASCII/UTF-16-Strings der nativen Engine
python -I - "$PIPP_DIR/pipp_core.exe" > "$OUT/core_strings.txt" <<'EOF'
import re, sys
b = open(sys.argv[1], "rb").read()
for m in re.finditer(rb"[\x20-\x7e\t]{6,}", b): print(m.group().decode())
for m in re.finditer(rb"(?:[\x20-\x7e]\x00){6,}", b): print("W:", m.group().decode("utf-16le"))
EOF

echo "Belege in $OUT"
