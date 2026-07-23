#!/bin/sh
set -eu

mkdir -p /app/test-site /app/fixtures/out

cp /modules/*.wasm /app/test-site/
cp /modules/profiler_fixture.wasm /modules/profiler_fixture.debug.wasm /app/fixtures/out/

echo "fixtures published to test-site/ and fixtures/out/:"
ls -la /modules

exec python -m http.server 8000 --directory /app/test-site
