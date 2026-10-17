#!/bin/bash
# expect: tool.shellcheck.SC2069
curl https://example.com 2>&1 >/dev/null
