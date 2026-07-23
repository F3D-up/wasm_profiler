#!/bin/sh
set -eu
node --cpu-prof --cpu-prof-interval=200 --cpu-prof-dir=tests/fixtures \
  --cpu-prof-name=node-fib.cpuprofile scripts/cpuprofile-workload.mjs
node -e "const p=JSON.parse(require('fs').readFileSync('tests/fixtures/node-fib.cpuprofile','utf8'));console.log('nodes:',p.nodes.length,'samples:',p.samples.length,'wasm nodes:',p.nodes.filter(n=>/wasm/.test(n.callFrame.url)||/wasm-function/.test(n.callFrame.functionName)).length)"
