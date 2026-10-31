#!/usr/bin/env sh
# Install what the integration tests need into the current Python environment:
# Home Assistant's test harness, plus the HA frontend package at the exact version that
# Home Assistant release expects (the panel depends on the frontend component).
set -eu
PY="${PYTHON:-python}"
"$PY" -m pip install --quiet pytest-homeassistant-custom-component
FRONTEND=$("$PY" - <<'PYEOF'
import json, pathlib, homeassistant
manifest = pathlib.Path(homeassistant.__file__).parent / "components" / "frontend" / "manifest.json"
print(json.loads(manifest.read_text())["requirements"][0])
PYEOF
)
"$PY" -m pip install --quiet "$FRONTEND"
echo "Installed test harness and $FRONTEND"
