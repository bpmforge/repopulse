#!/bin/bash
# expect: tool.shellcheck.SC2045
for f in $(ls /var/log); do echo "$f"; done
