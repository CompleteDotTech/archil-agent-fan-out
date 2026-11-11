#!/usr/bin/env bash
# Render from any working directory. Install Mermaid CLI separately or set MMDC.
set -euo pipefail
cd "$(dirname "$0")"
renderer="${MMDC:-mmdc}"
extra=()
if [[ -n "${PUPPETEER_CONFIG:-}" ]]; then
  extra+=(--puppeteerConfigFile "$PUPPETEER_CONFIG")
fi
for source in overview parallel-workers verification-gate stop-resume; do
  "$renderer" --input "$source.mmd" --output "$source.png" \
    --configFile mermaid-config.json --backgroundColor white \
    --width 1600 --scale 2 "${extra[@]}"
done
