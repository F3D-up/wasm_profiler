import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodeRange } from "../src/shared/wasmSymbols";
import type { LineEntry, Subprogram } from "../src/tool/dwarfdump";
import {
  buildSymbolMap,
  type JoinInput,
  type RuntimeInput,
} from "../src/tool/symbolMap";

const demangledNames = new Map<string, string>(
  readFileSync(
    new URL("./fixtures/demangled-names.tsv", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t") as [string, string]),
);

const chainB = [...demangledNames.keys()]
  .filter((name) => /^_RNvCs\w+_16profiler_fixture7chain_b$/.test(name))
  .sort();

const DEBUG_CHAIN_B = chainB[0]!;
const RUNTIME_CHAIN_B = chainB[1]!;
const RUNTIME_HOT_STEP = RUNTIME_CHAIN_B.replace("7chain_b", "8hot_step");

const ranges: CodeRange[] = [
  { funcIndex: 5, bodyStart: 102, bodyEnd: 120 },
  { funcIndex: 6, bodyStart: 121, bodyEnd: 150 },
];

const base = (over: Partial<JoinInput>): JoinInput => ({
  filename: "app.debug.wasm",
  hash: "HASH",
  importedFunctionCount: 5,
  definedFunctionCount: 2,
  codeSectionOffset: 100,
  codeRanges: ranges,
  subprograms: [],
  lineEntries: [],
  ...over,
});

const sub = (over: Partial<Subprogram> & { lowPc: number }): Subprogram => ({
  name: undefined,
  linkageName: undefined,
  declFile: undefined,
  declLine: undefined,
  highPc: undefined,
  ...over,
});

describe("buildSymbolMap", () => {
  it("maps code-section-relative subprograms to function indexes", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({ lowPc: 4, name: "fib", declFile: "src/lib.rs", declLine: 3 }),
          sub({
            lowPc: 23,
            name: "hot_step",
            declFile: "src/lib.rs",
            declLine: 10,
          }),
        ],
      }),
    );
    expect(diagnostics.convention).toBe("code-section-relative");
    expect(map.symbols["5"]).toEqual({
      name: "fib",
      source: "src/lib.rs",
      line: 3,
    });
    expect(map.symbols["6"]).toEqual({
      name: "hot_step",
      source: "src/lib.rs",
      line: 10,
    });
    expect(map.functionCount).toBe(7);
    expect(map.sources).toEqual(["src/lib.rs"]);
  });

  it("falls back to file-relative addresses when they fit better", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({ lowPc: 105, name: "fib" }),
          sub({ lowPc: 125, name: "hot_step" }),
        ],
      }),
    );
    expect(diagnostics.convention).toBe("file-relative");
    expect(map.symbols["5"]!.name).toBe("fib");
    expect(map.symbols["6"]!.name).toBe("hot_step");
  });

  it("assigns addresses in the size-field gap to the following function", () => {
    const { map } = buildSymbolMap(
      base({ subprograms: [sub({ lowPc: 20, name: "hot_step" })] }),
    );
    expect(map.symbols["6"]!.name).toBe("hot_step");
  });

  it("prefers the demangled linkage name over the plain name", () => {
    const { map } = buildSymbolMap(
      base({
        subprograms: [
          sub({ lowPc: 4, name: "chain_b", linkageName: DEBUG_CHAIN_B }),
        ],
        demangledNames,
      }),
    );
    expect(map.symbols["5"]!.name).toBe("profiler_fixture::chain_b");
  });

  it("falls back to the plain name when the linkage name does not demangle", () => {
    const { map } = buildSymbolMap(
      base({
        subprograms: [
          sub({
            lowPc: 4,
            name: "chain_b",
            linkageName: "_RNvCsadkVf7uAVZu_16profiler_fixture7chain_b",
          }),
        ],
      }),
    );
    expect(map.symbols["5"]!.name).toBe("chain_b");
  });

  it("uses the line table when the subprogram has no decl info", () => {
    const lineEntries: LineEntry[] = [
      { address: 2, line: 3, file: "src/lib.rs" },
      { address: 25, line: 11, file: "src/lib.rs" },
    ];
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [sub({ lowPc: 23, name: "hot_step" })],
        lineEntries,
      }),
    );
    expect(diagnostics.lineFallbacks).toBe(1);
    expect(map.symbols["6"]).toEqual({
      name: "hot_step",
      source: "src/lib.rs",
      line: 11,
    });
  });

  it("reports unmatched subprograms and collisions", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({ lowPc: 4, name: "fib" }),
          sub({ lowPc: 6, name: "fib_shadow" }),
          sub({ lowPc: 9000, name: "lost" }),
        ],
      }),
    );
    expect(diagnostics.matched).toBe(1);
    expect(diagnostics.collisions).toBe(1);
    expect(diagnostics.unmatched).toEqual(["lost"]);
    expect(Object.keys(map.symbols)).toEqual(["5"]);
  });

  it("refuses to emit when no subprogram fits either convention", () => {
    expect(() =>
      buildSymbolMap(
        base({ subprograms: [sub({ lowPc: 9000, name: "lost" })] }),
      ),
    ).toThrow(/either address convention/);
  });
});

describe("buildSymbolMap projected onto a runtime binary", () => {
  const runtime = (names: Map<number, string>): RuntimeInput => ({
    filename: "profiler_fixture.wasm",
    hash: "RUNTIME_HASH",
    importedFunctionCount: 0,
    definedFunctionCount: names.size,
    names,
  });

  it("rekeys debug symbols into the runtime index space and adopts its identity", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({
            lowPc: 4,
            name: "chain_b",
            linkageName: DEBUG_CHAIN_B,
            declFile: "src/lib.rs",
            declLine: 34,
          }),
          sub({
            lowPc: 23,
            name: "chain_a",
            declFile: "src/lib.rs",
            declLine: 39,
          }),
        ],
        runtimeInput: runtime(
          new Map([
            [0, RUNTIME_CHAIN_B],
            [1, "chain_a"],
          ]),
        ),
        demangledNames,
      }),
    );

    expect(map.symbols["0"]).toEqual({
      name: "profiler_fixture::chain_b",
      mangled: RUNTIME_CHAIN_B,
      source: "src/lib.rs",
      line: 34,
    });
    expect(map.symbols["1"]).toEqual({
      name: "chain_a",
      source: "src/lib.rs",
      line: 39,
    });
    expect(map.filename).toBe("profiler_fixture.wasm");
    expect(map.hash).toBe("RUNTIME_HASH");
    expect(map.functionCount).toBe(2);
    expect(diagnostics.runtimeMatched).toBe(2);
  });

  it("joins across builds whose crate disambiguators differ", () => {
    expect(DEBUG_CHAIN_B).not.toBe(RUNTIME_CHAIN_B);
    expect(demangledNames.get(DEBUG_CHAIN_B)).toBe(
      demangledNames.get(RUNTIME_CHAIN_B),
    );
  });

  it("still names runtime functions the debug build never covered", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({ lowPc: 4, name: "chain_b", linkageName: DEBUG_CHAIN_B }),
        ],
        runtimeInput: runtime(
          new Map([
            [0, RUNTIME_CHAIN_B],
            [1, RUNTIME_HOT_STEP],
          ]),
        ),
        demangledNames,
      }),
    );
    expect(map.symbols["1"]).toEqual({
      name: "profiler_fixture::hot_step",
      mangled: RUNTIME_HOT_STEP,
    });
    expect(diagnostics.runtimeMatched).toBe(1);
    expect(diagnostics.runtimeUnmatched).toEqual([
      "profiler_fixture::hot_step",
    ]);
  });

  it("skips names that two debug subprograms both claim", () => {
    const { map, diagnostics } = buildSymbolMap(
      base({
        subprograms: [
          sub({
            lowPc: 4,
            name: "chain_b",
            linkageName: DEBUG_CHAIN_B,
            declLine: 34,
            declFile: "a.rs",
          }),
          sub({
            lowPc: 23,
            name: "chain_b",
            linkageName: DEBUG_CHAIN_B,
            declLine: 99,
            declFile: "b.rs",
          }),
        ],
        runtimeInput: runtime(new Map([[0, RUNTIME_CHAIN_B]])),
        demangledNames,
      }),
    );
    expect(map.symbols["0"]).toEqual({
      name: "profiler_fixture::chain_b",
      mangled: RUNTIME_CHAIN_B,
    });
    expect(diagnostics.ambiguous).toEqual(["profiler_fixture::chain_b"]);
  });
});
