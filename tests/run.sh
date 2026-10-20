#!/bin/sh
# Starts a fresh fake backend for each suite (state is in memory), runs it, stops it.
cd "$(dirname "$0")"
status=0
for suite in e2e.js e2e-offline.js; do
  node fake-backend.js .. 8787 > fake-backend.log 2>&1 &
  pid=$!
  sleep 1
  node "$suite" || status=1
  kill $pid
done
exit $status
