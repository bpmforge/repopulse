#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC2034
legacy_name="kept for callers that source this file"

out=""
out=$(pwd)
declare -a parts=("$@")
for p in "${parts[@]}"; do
  read -r line <<<"$p"
  echo "item: $line"
done
if [[ -d "$out" ]]; then
  echo "done"
fi
