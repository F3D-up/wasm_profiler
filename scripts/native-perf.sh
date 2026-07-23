#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/fixtures/native/target/release/native_bench"
OUT="$ROOT/fixtures/out/native-benchmark.perf"
mkdir -p "$ROOT/fixtures/out"
RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release --manifest-path "$ROOT/fixtures/native/Cargo.toml"
perf record -F 999 --call-graph dwarf -o "$OUT.data" -- "$BIN"
perf script --no-inline -i "$OUT.data" >"$OUT"
echo "import into speedscope: $OUT"
