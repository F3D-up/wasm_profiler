import { describe, expect, it } from "vitest";
import {
  artifactMatchesModule,
  isRuntimeCompatible,
  loadArtifacts,
  normalizedName,
  parseArtifact,
  relatedNames,
  resolveFrame,
  saveArtifact,
} from "../src/shared/artifacts";
import { importReport } from "../src/shared/importReport";
import { REPORT_KIND } from "../src/shared/report";
import type { ArtifactSymbols, CapturedModule } from "../src/shared/profile";

const artifact = (over: Partial<ArtifactSymbols>): ArtifactSymbols => ({
  hash: "",
  filename: "a.wasm",
  functionCount: undefined,
  symbolQuality: "name",
  symbols: {},
  sources: [],
  createdAt: 0,
  ...over,
});

const module = (over: Partial<CapturedModule>): CapturedModule => ({
  id: "wasm://wasm/abc",
  hash: "",
  url: "wasm://wasm/abc",
  functionCount: 0,
  funcNames: [],
  symbolQuality: "stripped",
  ...over,
});

const served = artifact({
  filename: "my_app_bg.wasm",
  hash: "HASH_SERVED",
  functionCount: 5,
  symbolQuality: "name",
  symbols: {
    2: { name: "fib", quality: "name" },
    3: { name: "hot_step", quality: "name" },
  },
});

const debugCompanion = artifact({
  filename: "my_app.wasm",
  hash: "HASH_DEBUG",
  functionCount: 9,
  symbolQuality: "debug",
  symbols: {
    7: { name: "fib", source: "src/lib.rs", line: 10, quality: "debug" },
    8: {
      name: "only_in_debug",
      source: "src/other.rs",
      line: 4,
      quality: "debug",
    },
  },
});

describe("normalizedName", () => {
  it("relates served, debug, and path-qualified variants", () => {
    expect(normalizedName("my_app_bg.wasm")).toBe("my_app");
    expect(normalizedName("my_app.wasm")).toBe("my_app");
    expect(normalizedName("my_app.debug.wasm")).toBe("my_app");
    expect(normalizedName("pkg-dev/my_app_bg.wasm")).toBe("my_app");
    expect(normalizedName("other.wasm")).toBe("other");
  });

  it("strips stacked suffixes, not just the outermost one", () => {
    expect(normalizedName("my_app.wasm.map")).toBe("my_app");
    expect(normalizedName("my_app_bg_opt.wasm")).toBe("my_app");
  });

  it("accepts dot, dash, and underscore as flavour separators", () => {
    expect(normalizedName("myModule.debug.wasm")).toBe("mymodule");
    expect(normalizedName("myModule.release.wasm")).toBe("mymodule");
    expect(normalizedName("my_app-release.wasm")).toBe("my_app");
  });

  it("relates our own symbol-map output to the binary it describes", () => {
    expect(normalizedName("profiler_fixture.symbols.json")).toBe(
      "profiler_fixture",
    );
    expect(normalizedName("profiler_fixture.wasm")).toBe("profiler_fixture");
    expect(
      relatedNames("profiler_fixture.symbols.json", "profiler_fixture.wasm"),
    ).toBe(true);
  });

  it("only strips a suffix when a separator precedes it", () => {
    expect(normalizedName("wasmCase.wasm")).toBe("wasmcase");
    expect(normalizedName("release.wasm")).toBe("release");
    expect(normalizedName("a.b.wasm")).toBe("a.b");
  });
});

describe("matching", () => {
  it("matches by hash, url basename, and stem family", () => {
    expect(artifactMatchesModule(served, module({ hash: "HASH_SERVED" }))).toBe(
      true,
    );
    expect(
      artifactMatchesModule(
        served,
        module({ url: "http://x/pkg/my_app_bg.wasm" }),
      ),
    ).toBe(true);
    expect(
      artifactMatchesModule(
        debugCompanion,
        module({ url: "http://x/pkg/my_app_bg.wasm" }),
      ),
    ).toBe(true);
    expect(artifactMatchesModule(served, module({}))).toBe(false);
  });

  it("grants runtime compatibility only on a hash match", () => {
    expect(isRuntimeCompatible(served, module({ hash: "HASH_SERVED" }))).toBe(
      true,
    );

    expect(
      isRuntimeCompatible(served, module({ url: "http://x/my_app_bg.wasm" })),
    ).toBe(false);
    expect(isRuntimeCompatible(served, module({ functionCount: 5 }))).toBe(
      false,
    );
    expect(
      isRuntimeCompatible(debugCompanion, module({ functionCount: 9 })),
    ).toBe(false);

    expect(isRuntimeCompatible(served, module({ hash: "" }))).toBe(false);
  });

  it("rejects a stale rebuild whose hash differs, even by the same name", () => {
    const running = module({
      url: "http://x/my_app_bg.wasm",
      hash: "HASH_REBUILT",
      functionCount: 5,
    });

    expect(isRuntimeCompatible(served, running)).toBe(false);

    expect(artifactMatchesModule(served, running)).toBe(true);
  });
});

describe("resolveFrame (sampling mode: no module hash/count)", () => {
  const artifacts = [served, debugCompanion];
  const samplingModule = module({});

  it("resolves by name: funcIndex from served (inferred), source from debug", () => {
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: "wasm://wasm/abc",
      },
      samplingModule,
      artifacts,
    );
    expect(r).toEqual({
      name: "fib",
      source: "src/lib.rs",
      line: 10,
      quality: "debug",
      funcIndex: 2,
      inferredFuncIdx: true,
      inferredSource: true,
    });
  });

  it("resolves runtime-only names without a debug hit", () => {
    const r = resolveFrame(
      {
        label: "hot_step",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      samplingModule,
      artifacts,
    );
    expect(r.funcIndex).toBe(3);
    expect(r.inferredFuncIdx).toBe(true);
    expect(r.source).toBeUndefined();
    expect(r.quality).toBe("name");
  });

  it("upgrades wasm-function[N] frames by explicit index only against the running binary", () => {
    const identified = module({ hash: "HASH_SERVED", functionCount: 5 });
    const r = resolveFrame(
      {
        label: "wasm-function[3]",
        funcIndex: 3,
        quality: "fallback",
        source: undefined,
      },
      identified,
      artifacts,
    );
    expect(r.name).toBe("hot_step");
    expect(r.funcIndex).toBe(3);
    expect(r.inferredFuncIdx).toBeUndefined();

    const blind = resolveFrame(
      {
        label: "wasm-function[3]",
        funcIndex: 3,
        quality: "fallback",
        source: undefined,
      },
      samplingModule,
      artifacts,
    );
    expect(blind.name).toBe("wasm-function[3]");
  });

  it("never exports a companion-only index", () => {
    const r = resolveFrame(
      {
        label: "only_in_debug",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      samplingModule,
      artifacts,
    );
    expect(r.name).toBe("only_in_debug");
    expect(r.source).toBe("src/other.rs");
    expect(r.quality).toBe("debug");
    expect(r.funcIndex).toBeUndefined();
    expect(r.inferredFuncIdx).toBeUndefined();
  });

  it("prefers debug companions from the same filename family", () => {
    const otherDebug = artifact({
      filename: "other.wasm",
      symbolQuality: "debug",
      symbols: {
        1: {
          name: "fib",
          source: "WRONG/other.rs",
          line: 99,
          quality: "debug",
        },
      },
    });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      samplingModule,
      [otherDebug, served, debugCompanion],
    );
    expect(r.source).toBe("src/lib.rs");
  });

  it("returns the frame unchanged when nothing matches", () => {
    const r = resolveFrame(
      {
        label: "zzz",
        funcIndex: undefined,
        quality: "name",
        source: "wasm://wasm/abc",
      },
      samplingModule,
      artifacts,
    );
    expect(r).toEqual({
      name: "zzz",
      source: "wasm://wasm/abc",
      quality: "name",
      funcIndex: undefined,
    });
  });
});

const projectedMap = artifact({
  filename: "my_app_bg.wasm",
  hash: "HASH_SERVED",
  functionCount: 5,
  symbolQuality: "debug",
  symbols: {
    2: {
      name: "my_app::fib",
      source: "src/lib.rs",
      line: 10,
      quality: "debug",
    },
    3: {
      name: "my_app::hot_step",
      source: "src/lib.rs",
      line: 22,
      quality: "debug",
    },
  },
});

describe("resolveFrame (runtime-projected symbol map)", () => {
  const artifacts = [served, projectedMap];

  it("joins by index when the map describes the same binary as the served artifact", () => {
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      module({}),
      artifacts,
    );
    expect(r).toEqual({
      name: "my_app::fib",
      source: "src/lib.rs",
      line: 10,
      quality: "debug",
      funcIndex: 2,
      inferredFuncIdx: true,
      inferredSource: true,
    });
  });

  it("carries names the runtime section could not make readable", () => {
    const mangled = artifact({
      filename: "my_app_bg.wasm",
      hash: "HASH_SERVED",
      functionCount: 5,
      symbols: {
        3: { name: "_RNvCskMqK18PHlIa_6my_app8hot_step", quality: "name" },
      },
    });
    const r = resolveFrame(
      {
        label: "_RNvCskMqK18PHlIa_6my_app8hot_step",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      module({}),
      [mangled, projectedMap],
    );
    expect(r.name).toBe("my_app::hot_step");
    expect(r.line).toBe(22);
    expect(r.funcIndex).toBe(3);
  });

  it("refuses the index join for a companion built from a different binary", () => {
    const foreign = artifact({
      filename: "my_app.wasm",
      hash: "HASH_DEBUG",
      functionCount: 9,
      symbolQuality: "debug",
      symbols: {
        2: {
          name: "WRONG",
          source: "WRONG/other.rs",
          line: 99,
          quality: "debug",
        },
      },
    });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      module({}),
      [served, foreign],
    );
    expect(r.name).toBe("fib");
    expect(r.source).toBeUndefined();
    expect(r.funcIndex).toBe(2);
  });
});

describe("resolveFrame (index provenance)", () => {
  it("trusts a name-recovered index from a runtime-compatible artifact", () => {
    const identified = module({ hash: "HASH_SERVED", functionCount: 5 });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      identified,
      [served],
    );
    expect(r.funcIndex).toBe(2);
    expect(r.inferredFuncIdx).toBeUndefined();
  });

  it("still flags the index when the artifact is not verified against the module", () => {
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      module({}),
      [served],
    );
    expect(r.funcIndex).toBe(2);
    expect(r.inferredFuncIdx).toBe(true);
  });

  it("flags the index when the name is ambiguous even in a compatible artifact", () => {
    const twins = artifact({
      filename: "my_app_bg.wasm",
      hash: "HASH_TWINS",
      functionCount: 5,
      symbolQuality: "name",
      symbols: {
        2: { name: "fib", quality: "name" },
        4: { name: "fib", quality: "name" },
      },
    });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      module({ hash: "HASH_TWINS", functionCount: 5 }),
      [twins],
    );
    expect(r.funcIndex).toBe(2);
    expect(r.inferredFuncIdx).toBe(true);
  });

  it("never flags an index Chrome reported directly", () => {
    const r = resolveFrame(
      {
        label: "wasm-function[2]",
        funcIndex: 2,
        quality: "fallback",
        source: undefined,
      },
      module({}),
      [served],
    );
    expect(r.funcIndex).toBe(2);
    expect(r.inferredFuncIdx).toBeUndefined();
  });
});

describe("resolveFrame (tracing mode: strict trust rule)", () => {
  it("restricts index lookups to strictly compatible artifacts", () => {
    const strictModule = module({ hash: "HASH_SERVED", functionCount: 5 });
    const r = resolveFrame(
      {
        label: "wasm-function[2]",
        funcIndex: 2,
        quality: "fallback",
        source: undefined,
      },
      strictModule,
      [debugCompanion, served],
    );

    expect(r.name).toBe("fib");
    expect(r.inferredFuncIdx).toBeUndefined();
  });
});

describe("resolveFrame (sampling a named module)", () => {
  const mapWithMangled = artifact({
    filename: "my_app_bg.wasm",
    hash: "HASH_SERVED",
    functionCount: 5,
    symbolQuality: "debug",
    symbols: {
      2: {
        name: "my_app::fib",
        mangled: "_RNvCskMqK18PHlIa_6my_app3fib",
        source: "src/lib.rs",
        line: 2,
        quality: "debug",
      },
    },
  });

  const named = module({
    hash: "HASH_SERVED",
    url: "wasm://wasm/2b3c4d5e",
    functionCount: 5,
  });

  it("resolves a mangled frame label through the mangled key", () => {
    const r = resolveFrame(
      {
        label: "_RNvCskMqK18PHlIa_6my_app3fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      named,
      [mapWithMangled],
    );
    expect(r.name).toBe("my_app::fib");
    expect(r.line).toBe(2);
    expect(r.quality).toBe("debug");
  });

  it("leaves an unknown mangled label alone", () => {
    const r = resolveFrame(
      {
        label: "_RNvCskMqK18PHlIa_6my_app7unknown",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      named,
      [mapWithMangled],
    );
    expect(r.name).toBe("_RNvCskMqK18PHlIa_6my_app7unknown");
    expect(r.line).toBeUndefined();
  });
});

describe("resolveFrame (debug provenance)", () => {
  const strictModule = module({ hash: "HASH_SERVED", functionCount: 5 });

  const foreign = artifact({
    filename: "other_project.wasm",
    hash: "HASH_OTHER",
    functionCount: 9,
    symbolQuality: "debug",
    symbols: {
      4: { name: "fib", source: "other/parser.rs", line: 88, quality: "debug" },
    },
  });

  it("ignores a coincidental debug hit when the runtime answered", () => {
    const r = resolveFrame(
      { label: "fib", funcIndex: 2, quality: "fallback", source: undefined },
      strictModule,
      [served, foreign],
    );
    expect(r.name).toBe("fib");
    expect(r.source).toBeUndefined();
    expect(r.line).toBeUndefined();
    expect(r.quality).toBe("name");
  });

  it("accepts a coincidental debug hit when nothing else resolved the frame", () => {
    const r = resolveFrame(
      { label: "fib", funcIndex: 2, quality: "fallback", source: undefined },
      strictModule,
      [foreign],
    );
    expect(r.source).toBe("other/parser.rs");
    expect(r.line).toBe(88);
    expect(r.quality).toBe("debug");
  });

  it("still lets a filename-related companion override the runtime", () => {
    const related = artifact({
      filename: "my_app.wasm",
      hash: "HASH_DEBUG",
      functionCount: 9,
      symbolQuality: "debug",
      symbols: {
        7: { name: "fib", source: "src/lib.rs", line: 10, quality: "debug" },
      },
    });
    const r = resolveFrame(
      { label: "fib", funcIndex: 2, quality: "fallback", source: undefined },
      strictModule,
      [served, related],
    );
    expect(r.source).toBe("src/lib.rs");
    expect(r.line).toBe(10);
    expect(r.funcIndex).toBe(2);
  });

  it("reports the quality of the symbol whose name it displays", () => {
    const weak = artifact({
      filename: "my_app.wasm",
      hash: "HASH_DEBUG",
      functionCount: 9,
      symbolQuality: "debug",
      symbols: {
        7: { name: "fib", source: "src/lib.rs", line: 10, quality: "fallback" },
      },
    });
    const r = resolveFrame(
      { label: "fib", funcIndex: 2, quality: "name", source: undefined },
      strictModule,
      [served, weak],
    );
    expect(r.name).toBe("fib");
    expect(r.source).toBe("src/lib.rs");
    expect(r.quality).toBe("fallback");
  });
});

describe("artifact registry", () => {
  const fakeStorage = (): Record<string, unknown> => {
    const store: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: (key: string) => Promise.resolve({ [key]: store[key] }),
          set: (items: Record<string, unknown>) => {
            Object.assign(store, items);
            return Promise.resolve();
          },
          remove: (key: string) => {
            delete store[key];
            return Promise.resolve();
          },
        },
      },
    };
    return store;
  };

  it("keeps a served binary and its symbol map side by side", async () => {
    fakeStorage();
    await saveArtifact(served);
    await saveArtifact(projectedMap);
    const stored = await loadArtifacts();
    expect(stored).toHaveLength(2);
    expect(stored.map((a) => a.symbolQuality).sort()).toEqual([
      "debug",
      "name",
    ]);
    expect(new Set(stored.map((a) => a.hash))).toEqual(
      new Set(["HASH_SERVED"]),
    );
  });

  it("separates two uploads that describe the same binary the same way", async () => {
    fakeStorage();
    await saveArtifact({
      ...projectedMap,
      uploadName: "from-debug.symbols.json",
    });
    await saveArtifact({
      ...projectedMap,
      uploadName: "from-release.symbols.json",
    });
    expect(await loadArtifacts()).toHaveLength(2);
  });

  it("replaces an artifact when the same file is uploaded again", async () => {
    fakeStorage();
    await saveArtifact(served);
    await saveArtifact({ ...served, functionCount: 99 });
    const stored = await loadArtifacts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.functionCount).toBe(99);
  });
});

describe("parseArtifact (JSON path)", () => {
  const encode = (obj: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(obj));

  it("accepts a spec §5 symbol map", async () => {
    const a = await parseArtifact(
      encode({
        version: 1,
        filename: "my_app.wasm",
        hash: "DEADBEEF",
        functionCount: 9,
        symbolQuality: "debug",
        symbols: { 7: { name: "fib", source: "src/lib.rs", line: 10 } },
        sources: ["src/lib.rs"],
      }),
      "my_app.symbols.json",
    );
    expect(a.hash).toBe("DEADBEEF");
    expect(a.filename).toBe("my_app.wasm");
    expect(a.uploadName).toBe("my_app.symbols.json");
    expect(a.symbolQuality).toBe("debug");
    expect(a.symbols[7]).toEqual({
      name: "fib",
      source: "src/lib.rs",
      line: 10,
      quality: "debug",
    });
  });

  it("rejects JSON without a symbols object", async () => {
    await expect(
      parseArtifact(encode({ version: 1 }), "bad.json"),
    ).rejects.toThrow(/symbols/);
  });

  it("defaults a missing symbolQuality to debug", async () => {
    const a = await parseArtifact(
      encode({ symbols: { 1: { name: "f" } } }),
      "m.json",
    );
    expect(a.symbolQuality).toBe("debug");
    expect(a.symbols[1]!.quality).toBe("debug");
  });

  it("rejects an invalid symbolQuality instead of trusting it", async () => {
    await expect(
      parseArtifact(encode({ symbolQuality: "banana", symbols: {} }), "m.json"),
    ).rejects.toThrow(/invalid symbolQuality/);
    await expect(
      parseArtifact(encode({ symbolQuality: 42, symbols: {} }), "m.json"),
    ).rejects.toThrow(/invalid symbolQuality/);
  });

  it("treats a null symbolQuality as absent, like every other optional field", async () => {
    const a = await parseArtifact(
      encode({ symbolQuality: null, symbols: {} }),
      "m.json",
    );
    expect(a.symbolQuality).toBe("debug");
  });

  it("drops a symbol with an invalid quality but keeps the rest", async () => {
    const a = await parseArtifact(
      encode({
        symbolQuality: "debug",
        symbols: {
          1: { name: "good" },
          2: { name: "bad", quality: "banana" },
          3: { name: "explicit", quality: "name" },
        },
      }),
      "m.json",
    );
    expect(Object.keys(a.symbols)).toEqual(["1", "3"]);
    expect(a.symbols[1]!.quality).toBe("debug");
    expect(a.symbols[3]!.quality).toBe("name");
  });
});

describe("resolveFrame (source provenance)", () => {
  const foreignWasm = artifact({
    filename: "foreign.wasm",
    hash: "HASH_X",
    functionCount: 12,
    symbols: { 5: { name: "fib", quality: "name" } },
  });
  const foreignMap = artifact({
    filename: "foreign.wasm",
    hash: "HASH_X",
    functionCount: 12,
    symbolQuality: "debug",
    symbols: {
      5: {
        name: "fib",
        source: "foreign/other.rs",
        line: 99,
        quality: "debug",
      },
    },
  });

  it("flags a source line no artifact earned against the running module", () => {
    const unidentified = module({});
    expect(isRuntimeCompatible(foreignWasm, unidentified)).toBe(false);
    expect(isRuntimeCompatible(foreignMap, unidentified)).toBe(false);

    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      unidentified,
      [foreignWasm, foreignMap],
    );
    expect(r.source).toBe("foreign/other.rs");
    expect(r.inferredSource).toBe(true);
  });

  it("leaves the flag off when the source artifact is the running binary", () => {
    const projectedMap = artifact({
      filename: "my_app_bg.wasm",
      hash: "HASH_SERVED",
      functionCount: 5,
      symbolQuality: "debug",
      symbols: {
        2: { name: "fib", source: "src/lib.rs", line: 10, quality: "debug" },
      },
    });
    const identified = module({ hash: "HASH_SERVED", functionCount: 5 });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      identified,
      [projectedMap],
    );
    expect(r.source).toBe("src/lib.rs");
    expect(r.inferredSource).toBeUndefined();
    expect(r.inferredFuncIdx).toBeUndefined();
  });

  it("flags source from a debug companion that is not the running binary", () => {
    const identified = module({ hash: "HASH_SERVED", functionCount: 5 });
    const r = resolveFrame(
      {
        label: "fib",
        funcIndex: undefined,
        quality: "name",
        source: undefined,
      },
      identified,
      [served, debugCompanion],
    );
    expect(r.source).toBe("src/lib.rs");
    expect(r.inferredSource).toBe(true);
  });

  it("drops an unverified source on re-import so it cannot harden into fact", () => {
    const run = importReport(
      JSON.stringify({
        kind: REPORT_KIND,
        profile: { version: 3, mode: "sampling", startedAt: 0, endedAt: 1 },
        modules: [],
        callTree: [
          {
            id: 1,
            parentId: null,
            depth: 0,
            label: "fib",
            name: "fib",
            source: "foreign/other.rs",
            line: 99,
            inferredSource: true,
            quality: "debug",
            totalMs: 1,
            selfMs: 1,
          },
        ],
      }),
    );
    expect(run.nodes[1]!.source).toBeUndefined();
  });
});
