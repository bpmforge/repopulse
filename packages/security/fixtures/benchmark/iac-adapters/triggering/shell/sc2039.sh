#!/bin/sh
# expect: tool.shellcheck.SC3010
if [[ -n "$1" ]]; then echo set; fi
