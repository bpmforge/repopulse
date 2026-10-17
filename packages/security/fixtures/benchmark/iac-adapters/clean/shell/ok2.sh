#!/bin/sh
set -eu
name="${1:-world}"
printf 'hello %s\n' "$name"
if [ -n "$name" ]; then echo set; fi
curl -s https://example.com >/dev/null 2>&1
