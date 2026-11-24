#!/bin/bash
# Restyle every raw 45° tile of a flat-3D area (e.g. Marigona) with Codex image generation, giving the
# model the photo tile, the data-built 3D guide, a finished style-reference tile and a per-tile data
# sheet (buildings, floors, heights, roofs). N tiles at a time; existing outputs are skipped.
#
# Usage: N=3 world3d/style_all.sh <work_dir> <world.json> <style_ref.png>
#   needs <work_dir>/tiles_raw/ (grid.mjs) and <work_dir>/guides/ (guides.mjs); writes <work_dir>/tiles_styled/
cd "$(dirname "$0")/.."
export WORK=$(cd "$1" && pwd) WORLD=$(cd "$(dirname "$2")" && pwd)/$(basename "$2") REF=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
export PIPE=$PWD PY=${PY:-$PWD/../.venv/bin/python}
mkdir -p "$WORK/tiles_styled" "$WORK/logs"
run() {
  name=$(basename "$1" .png); ij=${name#tile_}; i=${ij%_*}; j=${ij#*_}
  out=$WORK/tiles_styled/$name.png
  [ -s "$out" ] && { echo "skip $name"; return; }
  sheet=$("$PY" "$PIPE/world3d/tile_brief.py" "$WORLD" "$WORK/tiles_raw/grid.json" "$i" "$j")
  SHEET="$sheet" OUT="$out" "$PY" -c 'import os,sys; t=open(sys.argv[1]).read(); print(t.replace("DATA_SHEET", os.environ["SHEET"]).replace("OUTPUT_PATH", os.environ["OUT"]))' \
    "$PIPE/world3d/style_prompt.txt" > "$WORK/logs/$name.prompt.txt"
  codex exec --skip-git-repo-check -s workspace-write -C "$WORK" \
    -i "$WORK/tiles_raw/$name.png" -i "$WORK/guides/guide_${i}_${j}.png" -i "$REF" \
    -o "$WORK/logs/$name.last" - < "$WORK/logs/$name.prompt.txt" > "$WORK/logs/$name.log" 2>&1
  [ -s "$out" ] && echo "done $name" || echo "FAILED $name (see $WORK/logs/$name.log)"
}
export -f run
# centre tile first, so the look can be checked early
ls "$WORK"/tiles_raw/tile_*.png | awk '{print (index($0,"tile_2_2")?0:1) " " $0}' | sort -k1,1n -s | cut -d' ' -f2- |
  xargs -P "${N:-3}" -I{} bash -c 'run {}'
echo ALL_FINISHED
