#!/bin/bash
# Night set for an area's aligned day tiles (same prompt as Dardania's night_all.sh), N at a time.
# Usage: N=3 world3d/night_all.sh <work_dir> [day_dir=tiles_seamed]   -> <work_dir>/tiles_night/
cd "$(dirname "$0")/.."
export WORK=$(cd "$1" && pwd) DAY=${2:-tiles_seamed} PIPE=$PWD
mkdir -p "$WORK/tiles_night" "$WORK/logs"
run() {
  name=$(basename "$1" .png); out=$WORK/tiles_night/$name.png
  [ -s "$out" ] && { echo "skip $name"; return; }
  sed "s#OUTPUT_PATH#$out#" "$PIPE/night_prompt.txt" | \
    codex exec --skip-git-repo-check -s workspace-write -C "$WORK" -i "$1" -o "$WORK/logs/night_$name.last" - > "$WORK/logs/night_$name.log" 2>&1
  [ -s "$out" ] && echo "done $name" || echo "FAILED $name (see $WORK/logs/night_$name.log)"
}
export -f run
ls "$WORK/$DAY"/tile_*.png | xargs -P "${N:-3}" -I{} bash -c 'run {}'
echo ALL_FINISHED
