#!/bin/bash
# Restyle every raw tile with Codex image generation, N at a time.
cd "$(dirname "$0")"
mkdir -p tiles_styled logs
export REF=$PWD/stylized_google.png
N=${N:-3}
run() {
  t=$1; name=$(basename "$t" .png); out=$PWD/tiles_styled/$name.png
  [ -s "$out" ] && { echo "skip $name"; return; }
  sed "s#OUTPUT_PATH#$out#" style_tile_prompt.txt | \
    codex exec --skip-git-repo-check -s workspace-write -C "$PWD" -i "$PWD/$t" -i "$REF" -o "logs/$name.last" - > "logs/$name.log" 2>&1
  [ -s "$out" ] && echo "done $name" || echo "FAILED $name (see logs/$name.log)"
}
export -f run
ls tiles_raw/tile_*.png | xargs -P "$N" -I{} bash -c 'run {}'
echo ALL_FINISHED
