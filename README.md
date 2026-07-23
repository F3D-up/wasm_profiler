# WASM Profiler

Chrome (MV3) extension that profiles WebAssembly on any page — sampling via the
debugger API or exact call tracing via Binaryen instrumentation — with a call
tree, function table, flame graph, artifact symbolication, and
speedscope/`.cpuprofile` interop.

Nothing is installed on the host. Every command below runs in a container, so
Docker with the Compose plugin is the only requirement.

## First run

Run these four in order. The last two compile the WebAssembly fixtures that the
test site serves and the test suite needs, so a checkout is not complete until
they have run once.

```sh
docker compose run --rm node npm ci
docker compose run --rm node npm run build
docker compose up -d testsite
docker compose run --rm symbols node dist/symbol-tool.mjs \
  fixtures/out/profiler_fixture.debug.wasm \
  --runtime fixtures/out/profiler_fixture.wasm \
  -o fixtures/out/profiler_fixture.symbols.json
```

Then load `dist/` in Chrome and open <http://localhost:8001>.

The containers run as uid 1000. If yours differs, export it first, or every
command that writes into the checkout will fail on permissions:

```sh
export DOCKER_UID=$(id -u) DOCKER_GID=$(id -g)
```

## Build the extension

```sh
docker compose run --rm node npm ci
docker compose run --rm node npm run build
```

The build writes the unpacked extension to `dist/`. `npm run dev` rebuilds the
extension bundles on change, but not the symbol tool.

## Load it in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` directory.
3. After every rebuild, press reload on the extension card.

Running Chrome on Windows against a WSL checkout: point the file picker at
`\\wsl.localhost\<distro>\home\<user>\profiler\dist`.

## Test site

```sh
docker compose up testsite
```

Serves the fixture page at <http://localhost:8001>. Starting the container also
publishes the compiled modules into `test-site/` and `fixtures/out/`, which is
what makes the fixture-backed tests runnable.

## Symbol tool

The offline tool reads DWARF from a debug build and emits a symbol map JSON with
demangled names and source lines. It needs `llvm-dwarfdump` and `llvm-cxxfilt`,
so it runs in the `symbols` container, and it runs the bundle the extension
build produces — run `npm run build` first.

```sh
docker compose run --rm symbols node dist/symbol-tool.mjs <debug.wasm> \
  --runtime <served.wasm> -o <out.json>
```

`--runtime` is what makes the map usable: the debug and release builds have
different function indexes, and the map has to be keyed in the index space of
the binary the page actually loads. Without it the map is keyed in the debug
build's own space and joins only if that is the file you serve.

Upload the emitted `.symbols.json` in the viewer's artifact panel. In sampling
mode upload the served `.wasm` alongside it — only its name section links
Chrome's frame labels to function indexes.

Two other flags: `--dump-names <file.wasm>` prints the raw name section, and
`--dwarfdump` / `--cxxfilt` override the binary paths.

## Tests

```sh
docker compose run --rm node npm test
docker compose run --rm node npm run check
```

A complete checkout reports 153 passed and 1 skipped. A higher skip count means
the fixtures are missing: tests that need a compiled module skip themselves
rather than fail, so run the first-run steps above.

## Maintaining fixtures

Everything in this section is only needed when the fixture sources or the
toolchain change. Building and running the project does not require any of it.

The `testsite` image compiles the fixture sources and carries the four modules
it publishes on start:

| module | source | build |
| --- | --- | --- |
| `profiler_fixture.wasm` | `fixtures/rust/src/lib.rs` | `cargo --release` — name section only |
| `profiler_fixture.debug.wasm` | same | `cargo` debug — DWARF |
| `multivalue.wasm` | `fixtures/cpp/multivalue.cpp` | `clang -O2` — name section only |
| `multivalue.debug.wasm` | same | `clang -O0 -g` — DWARF |

Rebuild them after editing `fixtures/rust/` or `fixtures/cpp/`:

```sh
docker compose build testsite
docker compose up testsite
```

The site serves a symbol map per module as a static file. They carry the
module's hash, so regenerate all four after rebuilding the fixtures:

```sh
docker compose run --rm symbols sh -c '
node dist/symbol-tool.mjs test-site/profiler_fixture.debug.wasm --runtime test-site/profiler_fixture.wasm -o test-site/profiler_fixture.symbols.json
node dist/symbol-tool.mjs test-site/profiler_fixture.debug.wasm -o test-site/profiler_fixture.debug.symbols.json
node dist/symbol-tool.mjs test-site/multivalue.debug.wasm --runtime test-site/multivalue.wasm -o test-site/multivalue.symbols.json
node dist/symbol-tool.mjs test-site/multivalue.debug.wasm -o test-site/multivalue.debug.symbols.json'
```

The rest are captured tool output, checked in so the unit tests never need the
toolchain:

```sh
docker compose run --rm symbols sh scripts/capture-demangled-names.sh   # tests/fixtures/demangled-names.tsv
docker compose run --rm symbols sh scripts/capture-dwarf-fixtures.sh    # tests/fixtures/dwarfdump-*.txt
docker compose run --rm node sh scripts/capture-cpuprofile.sh           # tests/fixtures/node-fib.cpuprofile
docker compose run --rm node node scripts/gen-unrelated-wasm.mjs        # test-site/unrelated.wasm
```

`node-fib.cpuprofile` is a sampled recording, so it differs on every capture even
when nothing changed; the tests assert its shape, not its counts.

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE). This is the
licence the thesis copyright page declares for its source code and the software
developed for it.
