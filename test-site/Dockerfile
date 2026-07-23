FROM rust:1-slim-bookworm AS rust
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY fixtures/rust/Cargo.toml ./
COPY fixtures/rust/src ./src
RUN cargo build --target wasm32-unknown-unknown \
 && cargo build --release --target wasm32-unknown-unknown

FROM debian:trixie-slim AS cpp
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang lld \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY fixtures/cpp/ ./
RUN sh build.sh

FROM python:3.12-slim
COPY --from=rust /src/target/wasm32-unknown-unknown/release/profiler_fixture.wasm /modules/profiler_fixture.wasm
COPY --from=rust /src/target/wasm32-unknown-unknown/debug/profiler_fixture.wasm   /modules/profiler_fixture.debug.wasm
COPY --from=cpp  /src/out/multivalue.wasm                                          /modules/multivalue.wasm
COPY --from=cpp  /src/out/multivalue.debug.wasm                                    /modules/multivalue.debug.wasm
COPY test-site/serve.sh /serve.sh
CMD ["sh", "/serve.sh"]
