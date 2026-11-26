#!/bin/zsh
# Builds macos/build/Marigona.app: a static export of the map inside a small native WebKit shell.
#   macos/build.sh            build
#   macos/build.sh --install  build and copy to ~/Applications (Spotlight, Launchpad, Dock)
# Needs Xcode command line tools and public/data (the exported map). The .app contains the map
# imagery, so like public/data it must not be committed or shared.
set -euo pipefail
cd "${0:A:h}/.."
ROOT=$PWD
OUT=macos/build
APP=$OUT/Marigona.app

[[ -f public/data/meta.json ]] || { echo "public/data is missing: export the map first" >&2; exit 1; }

echo "› static export"
rm -rf out
KOSMAPS_EXPORT=1 npx next build >/dev/null

echo "› native shell"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target arm64-apple-macos14 macos/Marigona.swift -o "$APP/Contents/MacOS/Marigona"
sed "s/__VERSION__/$(date +%Y%m%d.%H%M)/" macos/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "› icon"
ICONSET=$OUT/AppIcon.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
swiftc -O macos/render_icon.swift -o $OUT/render_icon
for s in 16 32 128 256 512; do
  $OUT/render_icon macos/icon.svg "$ICONSET/icon_${s}x${s}.png" $s
  $OUT/render_icon macos/icon.svg "$ICONSET/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET" $OUT/render_icon

echo "› site"
cp -R out "$APP/Contents/Resources/site"
rm -rf out

# ad-hoc signature: runs on this Mac (and others after right-click > Open)
codesign --force --deep --sign - "$APP"
echo "✓ $APP ($(du -sh "$APP" | cut -f1))"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p ~/Applications
  rm -rf ~/Applications/Marigona.app
  cp -R "$APP" ~/Applications/
  echo "✓ installed to ~/Applications/Marigona.app"
fi
