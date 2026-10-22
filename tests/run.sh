#!/bin/sh
# Starts a fresh fake backend for each suite (state is in memory), runs it, stops it.
cd "$(dirname "$0")"
status=0
run() {
  env $1 node fake-backend.js .. 8787 > fake-backend.log 2>&1 &
  pid=$!
  sleep 1
  node "$2" || status=1
  kill $pid
}
run "WITH_TOKEN=1" e2e.js
run "WITH_TOKEN=1" e2e-offline.js
run "NO_TOKEN=1" e2e-embedded.js
exit $status
