import { describe, expect, it } from "vitest";
import {
  convertCdpProfile,
  isWasmFrame,
  type CdpProfile,
} from "../src/shared/cdpConvert";

const frame = (functionName: string, url: string, scriptId = "1") => ({
  functionName,
  scriptId,
  url,
});

const fixture: CdpProfile = {
  startTime: 0,
  endTime: 3_000_000,
  nodes: [
    { id: 1, callFrame: frame("(root)", ""), children: [2, 3] },
    { id: 2, callFrame: frame("(program)", "") },
    {
      id: 3,
      callFrame: frame("runWorkload", "http://localhost:8000/"),
      children: [4, 7, 8],
    },
    {
      id: 4,
      callFrame: frame("fib", "wasm://wasm/abc123", "42"),
      children: [5],
    },
    {
      id: 5,
      callFrame: frame("fib", "wasm://wasm/abc123", "42"),
      children: [6],
    },
    { id: 6, callFrame: frame("hot_step", "wasm://wasm/abc123", "42") },
    { id: 7, callFrame: frame("wasm-function[7]", "wasm://wasm/abc123", "42") },
    { id: 8, callFrame: frame("jsHelper", "http://localhost:8000/app.js") },
  ],
  samples: [6, 6, 4, 7, 8, 2],
  timeDeltas: [1000, 1000, 500, 250, 100, 50],
};

const opts = {
  startedAt: 1000,
  endedAt: 4000,
  sampleIntervalMicroS: 1000,
  targetUrl: "http://t",
};

describe("isWasmFrame", () => {
  it("detects wasm-function[N] in the name", () => {
    expect(isWasmFrame(frame("wasm-function[3]", ""))).toBe(true);
  });
  it("detects wasm: scheme URLs", () => {
    expect(isWasmFrame(frame("fib", "wasm://wasm/8f00c47e"))).toBe(true);
  });
  it("detects .wasm URLs, with and without query", () => {
    expect(isWasmFrame(frame("f", "http://x/app.wasm"))).toBe(true);
    expect(isWasmFrame(frame("f", "http://x/app.wasm?v=2"))).toBe(true);
  });
  it("rejects plain JS frames", () => {
    expect(isWasmFrame(frame("jsHelper", "http://x/app.js"))).toBe(false);
    expect(isWasmFrame(frame("(program)", ""))).toBe(false);
  });

  it("rejects V8 boundary wrappers that carry the module url", () => {
    expect(
      isWasmFrame(frame("js-to-wasm:i:d", "wasm://wasm/app.wasm-35570bbe")),
    ).toBe(false);
    expect(
      isWasmFrame(frame("wasm-to-js:i:i", "wasm://wasm/app.wasm-35570bbe")),
    ).toBe(false);
    expect(isWasmFrame(frame("fib", "wasm://wasm/app.wasm-35570bbe"))).toBe(
      true,
    );
  });
});

describe("convertCdpProfile", () => {
  const run = convertCdpProfile(fixture, opts);

  it("keeps only WASM frames and drops non-WASM samples", () => {
    const labels = Object.values(run.nodes).map((n) => n.label);
    expect(labels).not.toContain("runWorkload");
    expect(labels).not.toContain("jsHelper");
    expect(labels).not.toContain("(program)");
    expect(run.roots).toHaveLength(2);
  });

  it("builds the recursive fib chain with correct time attribution", () => {
    const fibRoot =
      run.nodes[run.roots.find((id) => run.nodes[id]!.label === "fib")!]!;
    expect(fibRoot.totalMs).toBeCloseTo(2.5);
    expect(fibRoot.selfMs).toBeCloseTo(0.5);
    expect(fibRoot.samples).toBe(3);
    expect(fibRoot.selfSamples).toBe(1);

    const fibInner = run.nodes[fibRoot.children[0]!]!;
    expect(fibInner.label).toBe("fib");
    expect(fibInner.totalMs).toBeCloseTo(2.0);
    expect(fibInner.selfMs).toBeCloseTo(0);

    const hotStep = run.nodes[fibInner.children[0]!]!;
    expect(hotStep.label).toBe("hot_step");
    expect(hotStep.totalMs).toBeCloseTo(2.0);
    expect(hotStep.selfMs).toBeCloseTo(2.0);
    expect(hotStep.selfSamples).toBe(2);
  });

  it("extracts funcIndex from wasm-function[N] frames only", () => {
    const fallback = Object.values(run.nodes).find(
      (n) => n.label === "wasm-function[7]",
    )!;
    expect(fallback.funcIndex).toBe(7);
    expect(fallback.quality).toBe("fallback");
    expect(fallback.totalMs).toBeCloseTo(0.25);

    const named = Object.values(run.nodes).find((n) => n.label === "fib")!;
    expect(named.funcIndex).toBeUndefined();
    expect(named.quality).toBe("name");
  });

  it("records module, sample count, and run metadata", () => {
    expect(Object.keys(run.modules)).toEqual(["wasm://wasm/abc123"]);
    expect(run.sampleCount).toBe(6);
    expect(run.mode).toBe("sampling");
    expect(run.version).toBe(3);
    expect(run.targetUrl).toBe("http://t");
  });
});

describe("instrumented-page detection", () => {
  it("leaves traceIssues unset for an ordinary capture", () => {
    expect(convertCdpProfile(fixture, opts).traceIssues).toBeUndefined();
  });

  it("flags a capture of a page whose wasm was rewritten for tracing", () => {
    const instrumented: CdpProfile = {
      ...fixture,
      nodes: [
        { id: 1, callFrame: frame("(root)", ""), children: [4] },
        {
          id: 4,
          callFrame: frame("fib", "wasm://wasm/abc123", "42"),
          children: [5],
        },
        {
          id: 5,
          callFrame: frame("fib__profiler_orig", "wasm://wasm/abc123", "42"),
        },
      ],
      samples: [5, 5, 4],
      timeDeltas: [1000, 1000, 500],
    };
    const run = convertCdpProfile(instrumented, opts);
    expect(run.traceIssues).toHaveLength(1);
    expect(run.traceIssues![0]).toMatch(/rewritten for tracing/);
    expect(run.traceIssues![0]).toMatch(/Reload the page/);
  });
});

describe("wasm module identity from CDP", () => {
  const meta = {
    hash: "DEADBEEFCAFE",
    functionCount: 9,
    funcNames: [
      "fib",
      "hot_step",
      "hot_loop",
      "chain_c",
      "chain_b",
      "chain_a",
      "double",
      "pack",
      "multi_loop",
    ],
  };
  const withModules = {
    ...opts,
    wasmModules: new Map([["wasm://wasm/abc123", meta]]),
  };

  it("fills module identity from the map, keyed by the call-frame url", () => {
    const module = convertCdpProfile(fixture, withModules).modules[
      "wasm://wasm/abc123"
    ]!;
    expect(module.hash).toBe("DEADBEEFCAFE");
    expect(module.functionCount).toBe(9);
    expect(module.symbolQuality).toBe("name");
    expect(module.funcNames).toEqual(meta.funcNames);
  });

  it("upgrades a wasm-function[N] placeholder to the real name", () => {
    const run = convertCdpProfile(fixture, withModules);
    const node = Object.values(run.nodes).find((n) => n.funcIndex === 7)!;
    expect(node.label).toBe("pack");
    expect(node.quality).toBe("name");
  });

  it("leaves frames Chrome already named untouched", () => {
    const run = convertCdpProfile(fixture, withModules);
    const node = Object.values(run.nodes).find((n) => n.label === "hot_step")!;
    expect(node.quality).toBe("name");
  });

  it("keeps a placeholder when the module reports no name for that index", () => {
    const nameless = { ...meta, funcNames: new Array<string>(9).fill("") };
    const run = convertCdpProfile(fixture, {
      ...opts,
      wasmModules: new Map([["wasm://wasm/abc123", nameless]]),
    });
    const node = Object.values(run.nodes).find((n) => n.funcIndex === 7)!;
    expect(node.label).toBe("wasm-function[7]");
    expect(node.quality).toBe("fallback");
    expect(run.modules["wasm://wasm/abc123"]!.symbolQuality).toBe("stripped");
  });

  it("produces exactly the old output when no map is supplied", () => {
    expect(convertCdpProfile(fixture, opts)).toEqual(
      convertCdpProfile(fixture, { ...opts, wasmModules: new Map() }),
    );
  });
});
