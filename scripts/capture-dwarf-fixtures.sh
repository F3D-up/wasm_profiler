#!/bin/sh
set -eu
wasm=fixtures/out/profiler_fixture.debug.wasm
info=$(mktemp)

llvm-dwarfdump --debug-line "$wasm" | awk '{ print } /end_sequence/ { exit }' \
  > tests/fixtures/dwarfdump-debug-line.txt

llvm-dwarfdump --debug-info "$wasm" > "$info"
start=$(awk '/^0x[0-9a-f]+: *Compile Unit:/ { cu = NR } /"\/src\/src\/lib\.rs"/ { print cu; exit }' "$info")
[ -n "$start" ] || { echo "no compile unit references /src/src/lib.rs" >&2; exit 1; }
end=$(awk -v s="$start" 'NR > s && /^0x[0-9a-f]+: *Compile Unit:/ { print NR - 1; exit }' "$info")
[ -n "$end" ] || end='$'
sed -n "${start},${end}p" "$info" > tests/fixtures/dwarfdump-debug-info.txt
rm -f "$info"

wc -l tests/fixtures/dwarfdump-debug-line.txt tests/fixtures/dwarfdump-debug-info.txt
