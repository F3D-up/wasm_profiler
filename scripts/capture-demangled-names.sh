#!/bin/sh
set -eu

raw=$(mktemp)
out=tests/fixtures/demangled-names.tsv

{
  node dist/symbol-tool.mjs --dump-names fixtures/out/profiler_fixture.wasm | cut -f2
  node dist/symbol-tool.mjs --dump-names fixtures/out/profiler_fixture.debug.wasm | cut -f2
} | sort -u >"$raw"

llvm-cxxfilt <"$raw" | paste "$raw" - >"$out"
rm -f "$raw"
wc -l "$out"
