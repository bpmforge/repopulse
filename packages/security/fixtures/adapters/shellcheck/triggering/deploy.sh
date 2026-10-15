#!/bin/sh
# Seeded defects: each line below is a real bug, not a style opinion.
target=$1
cd $target
rm -rf "$PREFIX"/
for f in $(ls *.log); do
  echo "rotating $f"
done
if [ $count == 3 ]; then
  echo finished
fi
