#!/bin/bash
# Render each ad to a PNG via Chrome headless
# Usage: ./render-ads.sh

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="http://localhost:8765/ads.html?render="
OUT_DIR="/tmp/ad-renders"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.png

# Each ad: id, width, height
ADS=(
  "ad1 1080 1080"
  "ad2 1080 1080"
  "ad3 1080 1350"
  "ad4 1080 1350"
  "ad5 1080 1920"
  "ad6 1080 1920"
  "ad7 1080 1080"
  "ad8 1080 1350"
  "ad9 1080 1080"
  "ad10 1080 1920"
  "ad11 1080 1350"
  "ad12 1080 1080"
)

for entry in "${ADS[@]}"; do
  read -r id w h <<<"$entry"
  out="$OUT_DIR/${id}.png"
  echo "Rendering $id at ${w}x${h}..."
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --no-sandbox \
    --window-size="$w","$h" \
    --screenshot="$out" \
    --virtual-time-budget=2000 \
    "${URL}${id}" 2>/dev/null
done

echo ""
echo "Done. Rendered files:"
ls -la "$OUT_DIR"
