#!/usr/bin/env sh
# Usado pelo cron no Linux/Mac.
cd "$(dirname "$0")" || exit 1
exec node src/index.js
