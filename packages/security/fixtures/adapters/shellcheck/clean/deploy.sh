#!/bin/sh
# Near-miss of the triggering script: the same operations, written safely.
set -eu
target=$1
cd "$target" || exit 1
rm -rf "${PREFIX:?}"/
for f in ./*.log; do
  [ -e "$f" ] || continue
  echo "rotating $f"
done
count=${count:-0}
if [ "$count" -eq 3 ]; then
  echo finished
fi
