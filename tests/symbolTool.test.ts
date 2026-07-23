import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArtifact, resolveFrame } from "../src/shared/artifacts";
import { sha256Hex } from "../src/shared/hash";
import { parseWasmSymbols } from "../src/shared/wasmSymbols";
import type { SymbolMapJson } from "../src/tool/symbolMap";

const mapPath = "fixtures/out/profiler_fixture.symbols.json";
const runtimeWasmPath = "fixtures/out/profiler_fixture.wasm";
const hasFixture = existsSync(mapPath) && existsSync(runtimeWasmPath);

describe.skipIf(!hasFixture)("symbol tool output (rust fixture)", () => {
  let map: SymbolMapJson;
  let runtimeBytes: Uint8Array;

  beforeAll(() => {
    map = JSON.parse(readFileSync(mapPath, "utf8")) as SymbolMapJson;
    runtimeBytes = new Uint8Array(readFileSync(runtimeWasmPath));
  });

  it("conforms to the §5 contract", () => {
    expect(map.symbolQuality).toBe("debug");
    expect(map.functionCount).toBeGreaterThan(0);
    expect(Object.keys(map.symbols).length).toBeGreaterThan(0);
  });

  it("resolves the fixture functions to lib.rs lines", () => {
    const named = Object.values(map.symbols);
    for (const fn of ["fib", "hot_step", "chain_c"]) {
      const hit = named.find(
        (s) => s.name === fn || s.name.endsWith(`::${fn}`),
      );
      expect(hit, fn).toBeDefined();
      expect(hit!.source, fn).toMatch(/lib\.rs$/);
      expect(hit!.line, fn).toBeGreaterThan(0);
    }
  });

  it("claims the served binary, not the debug companion, as its identity", async () => {
    expect(map.filename).toBe("profiler_fixture.wasm");
    expect(map.hash).toBe(await sha256Hex(runtimeBytes));
  });

  it("matches the declared functionCount to the binary", () => {
    const info = parseWasmSymbols(runtimeBytes);
    expect(map.functionCount).toBe(
      info.importedFunctionCount + info.definedFunctionCount,
    );
  });

  it("demangles the v0 symbols the name section leaves mangled", () => {
    const info = parseWasmSymbols(runtimeBytes);
    for (const [idx, raw] of info.rawNames) {
      if (!raw.startsWith("_R")) continue;
      expect(map.symbols[String(idx)]!.name, raw).not.toMatch(/^_R/);
    }
    expect([...info.rawNames.values()].some((n) => n.startsWith("_R"))).toBe(
      true,
    );
  });

  it("agrees with the name section on shared indexes", () => {
    const info = parseWasmSymbols(runtimeBytes);
    let shared = 0;
    let equal = 0;
    for (const [key, symbol] of Object.entries(map.symbols)) {
      const nameSection = info.symbols.get(Number(key));
      if (!nameSection || nameSection.quality !== "name") continue;
      shared++;
      const plain = symbol.name.replace(/<.*$/, "").split("::").pop()!;
      if (nameSection.name === symbol.name || nameSection.name.includes(plain))
        equal++;
    }
    if (shared === 0) return;
    expect(equal / shared).toBeGreaterThan(0.8);
  });

  it("aligns fixture function indexes with the name section", () => {
    const info = parseWasmSymbols(runtimeBytes);
    for (const fn of [
      "fib",
      "hot_step",
      "chain_a",
      "chain_b",
      "chain_c",
      "hot_loop",
    ]) {
      const entry = Object.entries(map.symbols).find(
        ([, s]) => s.name === fn || s.name.endsWith(`::${fn}`),
      );
      expect(entry, fn).toBeDefined();
      expect(info.rawNames.get(Number(entry![0])), fn).toContain(fn);
    }
  });

  it("resolves a mangled sampling frame end to end against both real artifacts", async () => {
    const runtimeArtifact = await parseArtifact(
      runtimeBytes,
      "profiler_fixture.wasm",
    );
    const mapArtifact = await parseArtifact(
      new TextEncoder().encode(JSON.stringify(map)),
      "profiler_fixture.symbols.json",
    );
    const info = parseWasmSymbols(runtimeBytes);
    const [funcIndex, label] = [...info.rawNames].find(([, raw]) =>
      raw.includes("chain_b"),
    )!;

    const resolved = resolveFrame(
      { label, funcIndex: undefined, quality: "name", source: undefined },
      {
        id: "wasm://wasm/abc",
        hash: "",
        url: "http://localhost:8000/profiler_fixture.wasm",
        functionCount: 0,
        funcNames: [],
        symbolQuality: "stripped",
      },
      [runtimeArtifact, mapArtifact],
    );

    expect(label).toMatch(/^_R/);
    expect(resolved.name).toBe("profiler_fixture::chain_b");
    expect(resolved.source).toBe("src/lib.rs");
    expect(resolved.line).toBeGreaterThan(0);
    expect(resolved.funcIndex).toBe(funcIndex);
    expect(resolved.quality).toBe("debug");
  });

  it("imports through the viewer artifact path as a debug artifact", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(map));
    const artifact = await parseArtifact(
      bytes,
      "profiler_fixture.symbols.json",
    );
    expect(artifact.symbolQuality).toBe("debug");
    expect(artifact.functionCount).toBe(map.functionCount);
    expect(Object.keys(artifact.symbols).length).toBe(
      Object.keys(map.symbols).length,
    );
  });
});

describe.skipIf(hasFixture)("symbol tool fixture placeholder", () => {
  it("skips until fixtures are built (docker compose up testsite, then run the symbol tool)", () => {
    expect(hasFixture).toBe(false);
  });
});
