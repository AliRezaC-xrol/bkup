#!/usr/bin/env bash
# Bump the project version everywhere it lives (package.json + version.ts).
# Usage: bash scripts/bump-version.sh 2.0.1
set -euo pipefail
V="${1:?usage: bump-version.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

python3 - "$ROOT" "$V" <<'PY'
import json, pathlib, re, sys
root, v = pathlib.Path(sys.argv[1]), sys.argv[2]

pkg = root / "package.json"
data = json.loads(pkg.read_text(encoding="utf-8"))
data["version"] = v
pkg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

vt = root / "src" / "lib" / "version.ts"
s = vt.read_text(encoding="utf-8")
s = re.sub(r'APP_VERSION = "[^"]+"', f'APP_VERSION = "{v}"', s)
vt.write_text(s, encoding="utf-8")
print(f"version → {v}")
PY
