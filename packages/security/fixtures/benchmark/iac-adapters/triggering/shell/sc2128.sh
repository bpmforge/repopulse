#!/bin/bash
files=(a b c)
# expect: tool.shellcheck.SC2128
echo "$files"
