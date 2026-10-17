#!/bin/bash
set -euo pipefail
dir="${1:?usage: ok1.sh DIR}"
cd "$dir" || exit 1
for f in /var/log/*; do
  echo "$f"
done
files=(a b c)
echo "${files[0]}"
printf '%s\n' "$@"
rm -rf "${dir:?}/"
