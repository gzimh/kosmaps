#!/bin/bash
# Generate the night set from the styled day tiles with Codex, N at a time.
cd "$(dirname "$0")"
N=${N:-3}
run() {
  name=$(basename "$1" .png); out=$PWD/tiles_night/$name.png
  [ -s "$out" ] && { echo "skip $name"; return; }
  sed "s#OUTPUT_PATH#$out#" night_prompt.txt | \
    codex exec --skip-git-repo-check -s workspace-write -C "$PWD" -i "$PWD/$1" -o "logs/night_$name.last" - > "logs/night_$name.log" 2>&1
  [ -s "$out" ] && echo "done $name" || echo "FAILED $name (see logs/night_$name.log)"
}
export -f run
ls tiles_styled/tile_*.png | xargs -P "$N" -I{} bash -c 'run {}'
echo ALL_FINISHED
