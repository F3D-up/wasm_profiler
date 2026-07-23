#!/bin/sh
set -eu

MV="-mmultivalue -Xclang -target-abi -Xclang experimental-mv"
LINK="-nostdlib -Wl,--no-entry -Wl,--export-all"

mkdir -p out

clang --target=wasm32 $MV $LINK -O2      -o out/multivalue.wasm       multivalue.cpp
clang --target=wasm32 $MV $LINK -O0 -g   -o out/multivalue.debug.wasm multivalue.cpp

ls -la out
