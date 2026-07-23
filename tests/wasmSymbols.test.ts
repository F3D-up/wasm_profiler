import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWasmBytes, parseWasmSymbols } from "../src/shared/wasmSymbols";

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function str(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...leb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const MANGLED = "_ZN4core3fmt5Debug3fmt17h0123456789abcdefE";

function buildTestModule(withNameSection: boolean): Uint8Array {
  const nameSub = [
    ...leb(2),
    ...leb(1),
    ...str("alpha"),
    ...leb(2),
    ...str(MANGLED),
  ];
  const bytes = [
    ...HEADER,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [1, ...str("env"), ...str("log"), 0x00, 0]),
    ...section(3, [2, 0, 0]),
    ...section(7, [1, ...str("foo"), 0x00, 1]),
    ...section(10, [2, 2, 0, 0x0b, 2, 0, 0x0b]),
    ...(withNameSection
      ? section(0, [...str("name"), 1, ...leb(nameSub.length), ...nameSub])
      : []),
  ];
  return Uint8Array.from(bytes);
}

describe("isWasmBytes", () => {
  it("accepts the wasm magic and rejects everything else", () => {
    expect(isWasmBytes(buildTestModule(true))).toBe(true);
    expect(isWasmBytes(new TextEncoder().encode('{"symbols":{}}'))).toBe(false);
    expect(isWasmBytes(new Uint8Array([0, 1, 2]))).toBe(false);
  });
});

describe("parseWasmSymbols", () => {
  it("counts imported, defined, and exported functions", () => {
    const info = parseWasmSymbols(buildTestModule(true));
    expect(info.importedFunctionCount).toBe(1);
    expect(info.definedFunctionCount).toBe(2);
    expect(info.exportedFunctionCount).toBe(1);
    expect(info.hasNameSection).toBe(true);
  });

  it("extracts symbols with the quality ladder applied", () => {
    const info = parseWasmSymbols(buildTestModule(true));
    expect(info.symbols.get(0)).toEqual({
      name: "import:env.log",
      quality: "export-import",
    });

    expect(info.symbols.get(1)).toEqual({ name: "alpha", quality: "name" });

    expect(info.symbols.get(2)).toEqual({ name: MANGLED, quality: "name" });
  });

  it("falls back to export-import names without a name section", () => {
    const info = parseWasmSymbols(buildTestModule(false));
    expect(info.hasNameSection).toBe(false);
    expect(info.symbols.get(1)).toEqual({
      name: "foo",
      quality: "export-import",
    });
  });

  it("records code ranges with import-offset function indexes", () => {
    const info = parseWasmSymbols(buildTestModule(true));
    expect(info.codeRanges.map((r) => r.funcIndex)).toEqual([1, 2]);
    for (const range of info.codeRanges) {
      expect(range.bodyEnd).toBeGreaterThan(range.bodyStart);
    }
  });

  it("rejects non-wasm input", () => {
    expect(() => parseWasmSymbols(new Uint8Array([1, 2, 3, 4]))).toThrow(
      /magic/,
    );
  });

  it.skipIf(!existsSync("test-site/profiler_fixture.wasm"))(
    "parses the Rust test-site module",
    () => {
      const info = parseWasmSymbols(
        new Uint8Array(readFileSync("test-site/profiler_fixture.wasm")),
      );
      expect(info.definedFunctionCount).toBe(14);
      const names = [...info.symbols.values()].map((s) => s.name);
      for (const expected of [
        "fib",
        "hot_loop",
        "chain_a",
        "work",
        "benchmark",
      ]) {
        expect(names).toContain(expected);
      }

      expect(names.filter((n) => n.startsWith("_RNv"))).toHaveLength(9);
      expect(info.hasNameSection).toBe(true);
    },
  );

  it.skipIf(!existsSync("test-site/multivalue.wasm"))(
    "parses the C++ multi-value module",
    () => {
      const info = parseWasmSymbols(
        new Uint8Array(readFileSync("test-site/multivalue.wasm")),
      );
      const names = [...info.symbols.values()].map((s) => s.name);
      for (const expected of ["multi_loop", "pack_a"]) {
        expect(names).toContain(expected);
      }
      expect(names.some((n) => n.includes("fixture::pack"))).toBe(true);
      expect(info.hasNameSection).toBe(true);
    },
  );
});
