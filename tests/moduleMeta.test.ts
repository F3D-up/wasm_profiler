import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeWasm } from "../src/shared/moduleMeta";

const wasmPath = "test-site/profiler_fixture.wasm";

describe.skipIf(!existsSync(wasmPath))("describeWasm", () => {
  const bytes = (): Uint8Array => new Uint8Array(readFileSync(wasmPath));

  it("hashes the exact bytes it was given", async () => {
    const meta = await describeWasm(bytes());
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await describeWasm(bytes())).toEqual(meta);
  });

  it("counts imported plus defined functions", async () => {
    const meta = await describeWasm(bytes());
    expect(meta.functionCount).toBe(14);
    expect(meta.funcNames).toHaveLength(meta.functionCount);
  });

  it("aligns funcNames with the function index space", async () => {
    const meta = await describeWasm(bytes());
    const plain = meta.funcNames.filter((n) => !n.startsWith("_R")).sort();
    expect(plain).toEqual(["benchmark", "chain_a", "fib", "hot_loop", "work"]);
    const mangled = meta.funcNames.filter((n) => n.startsWith("_R"));
    expect(mangled).toHaveLength(9);
    for (const name of mangled) {
      expect(name).toMatch(/^_RNvCs\w+_16profiler_fixture\d+\w+$/);
    }
  });

  it("rejects bytes that are not a wasm binary", async () => {
    await expect(
      describeWasm(new TextEncoder().encode('{"not":"wasm"}')),
    ).rejects.toThrow(/not a WebAssembly binary/);
  });
});

describe("describeWasm on a module with no name section", () => {
  const stripped = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60,
    0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);

  it("still reports the right count, with an empty name per index", async () => {
    const meta = await describeWasm(stripped);
    expect(meta.functionCount).toBe(1);
    expect(meta.funcNames).toEqual([""]);
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
