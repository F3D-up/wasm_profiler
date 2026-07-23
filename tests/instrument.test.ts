import binaryen from "binaryen";
import { describe, expect, it } from "vitest";
import { totalProfileMs } from "../src/shared/callTree";
import { instrumentModule } from "../src/shared/instrument";
import { parseWasmSymbols } from "../src/shared/wasmSymbols";
import { TraceAggregator, assembleTraceRun } from "../src/shared/traceConvert";

const buildTestModule = (): Uint8Array => {
  const m = new binaryen.Module();
  m.setFeatures(binaryen.Features.All);
  const { i32 } = binaryen;

  m.addFunctionImport("ext", "env", "ext", i32, i32);

  m.addFunction(
    "fib",
    i32,
    i32,
    [],
    m.if(
      m.i32.lt_s(m.local.get(0, i32), m.i32.const(2)),
      m.return(m.local.get(0, i32)),
      m.return(
        m.i32.add(
          m.call("fib", [m.i32.sub(m.local.get(0, i32), m.i32.const(1))], i32),
          m.call("fib", [m.i32.sub(m.local.get(0, i32), m.i32.const(2))], i32),
        ),
      ),
    ),
  );

  m.addFunction(
    "chain_c",
    i32,
    i32,
    [i32, i32],
    m.block(null, [
      m.local.set(1, m.i32.const(0)),
      m.local.set(2, m.i32.const(0)),
      m.loop(
        "sum",
        m.block(null, [
          m.local.set(
            1,
            m.i32.add(
              m.local.get(1, i32),
              m.i32.mul(m.local.get(2, i32), m.local.get(2, i32)),
            ),
          ),
          m.local.set(2, m.i32.add(m.local.get(2, i32), m.i32.const(1))),
          m.br("sum", m.i32.lt_u(m.local.get(2, i32), m.local.get(0, i32))),
        ]),
      ),
      m.return(m.local.get(1, i32)),
    ]),
  );

  m.addFunction(
    "chain_b",
    i32,
    i32,
    [],
    m.return(
      m.i32.add(
        m.call("chain_c", [m.local.get(0, i32)], i32),
        m.call(
          "chain_c",
          [m.i32.div_u(m.local.get(0, i32), m.i32.const(2))],
          i32,
        ),
      ),
    ),
  );

  m.addFunction(
    "chain_a",
    i32,
    i32,
    [],
    m.return(
      m.i32.add(m.call("chain_b", [m.local.get(0, i32)], i32), m.i32.const(1)),
    ),
  );

  m.addFunction(
    "twice",
    i32,
    i32,
    [],
    m.return(
      m.i32.add(
        m.call("ext", [m.local.get(0, i32)], i32),
        m.call("ext", [m.local.get(0, i32)], i32),
      ),
    ),
  );

  const pairType = binaryen.createType([i32, i32]);
  m.addFunction(
    "pair",
    binaryen.none,
    pairType,
    [],
    m.tuple.make([m.i32.const(7), m.i32.const(9)]),
  );

  for (const name of ["fib", "chain_a", "twice", "pair"]) {
    m.addFunctionExport(name, name);
  }

  binaryen.setDebugInfo(true);
  if (!m.validate()) throw new Error("test module failed validation");
  const bytes = m.emitBinary();
  m.dispose();
  return bytes;
};

const original = buildTestModule();

interface TestExports {
  fib(n: number): number;
  chain_a(n: number): number;
  twice(n: number): number;
  pair(): [number, number];
}

const instantiate = async (
  bytes: Uint8Array,
  agg?: TraceAggregator,
  moduleId = "test-module",
): Promise<TestExports> => {
  const imports: WebAssembly.Imports = {
    env: { ext: (x: number) => x },
    __profiler: {
      enter: (idx: number) => agg?.enter(moduleId, idx, performance.now()),
      exit: (idx: number) => agg?.exit(idx, performance.now()),
    },
  };
  const { instance } = await WebAssembly.instantiate(
    bytes.slice().buffer,
    imports,
  );
  return instance.exports as unknown as TestExports;
};

const names = (): string[] => {
  const info = parseWasmSymbols(original);
  const list: string[] = [];
  for (const [idx, symbol] of info.symbols) list[idx] = symbol.name;
  return list;
};

const result = await instrumentModule(original);

describe("instrumentModule", () => {
  it("reports the original index space and instruments every defined function", () => {
    const info = parseWasmSymbols(original);
    expect(result.importedFunctionCount).toBe(info.importedFunctionCount);
    expect(result.definedFunctionCount).toBe(info.definedFunctionCount);
    const nameByIdx = names();
    for (const fn of result.instrumentedFunctions) {
      expect(nameByIdx[fn.funcIndex]).toBe(fn.name);
    }
    expect(result.instrumentedFunctions.map((f) => f.name).sort()).toEqual([
      "chain_a",
      "chain_b",
      "chain_c",
      "fib",
      "pair",
      "twice",
    ]);
    expect(result.instrumentedFunctions).toHaveLength(
      result.definedFunctionCount,
    );
  });

  it("keeps a name section in the rewritten binary", () => {
    expect(parseWasmSymbols(result.bytes).hasNameSection).toBe(true);
  });

  it("preserves observable behavior", async () => {
    const plain = await instantiate(original);
    const traced = await instantiate(result.bytes, new TraceAggregator());
    expect(traced.fib(10)).toBe(plain.fib(10));
    expect(traced.chain_a(10)).toBe(plain.chain_a(10));
    expect(traced.twice(3)).toBe(plain.twice(3));
    expect(traced.pair()).toEqual(plain.pair());
  });

  it("traces a multi-value function without disturbing its results", async () => {
    const agg = new TraceAggregator();
    const wasm = await instantiate(result.bytes, agg);
    expect(wasm.pair()).toEqual([7, 9]);
    expect(wasm.pair()).toEqual([7, 9]);
    const snapshot = agg.snapshot();
    const pairIdx = result.instrumentedFunctions.find(
      (f) => f.name === "pair",
    )!.funcIndex;
    const pairNodes = Object.values(snapshot.nodes).filter(
      (n) => n.funcIndex === pairIdx,
    );
    expect(pairNodes.reduce((a, n) => a + n.calls, 0)).toBe(2);
    expect(snapshot.unbalancedEvents).toBe(0);
  });

  it("counts fib(10) calls exactly", async () => {
    const agg = new TraceAggregator();
    const wasm = await instantiate(result.bytes, agg);
    expect(wasm.fib(10)).toBe(55);
    const snapshot = agg.snapshot();
    const fibIdx = result.instrumentedFunctions.find(
      (f) => f.name === "fib",
    )!.funcIndex;
    const fibCalls = Object.values(snapshot.nodes)
      .filter((n) => n.funcIndex === fibIdx)
      .reduce((acc, n) => acc + n.calls, 0);
    expect(fibCalls).toBe(177);
    expect(snapshot.unbalancedEvents).toBe(0);
    expect(snapshot.eventCount).toBe(2 * 177);
  });

  it("counts the call chain exactly and nests it correctly", async () => {
    const agg = new TraceAggregator();
    const wasm = await instantiate(result.bytes, agg);
    expect(wasm.chain_a(10)).toBe(316);
    const snapshot = agg.snapshot();
    const byName = new Map(
      result.instrumentedFunctions.map((f) => [f.name, f.funcIndex]),
    );
    const nodesOf = (name: string) =>
      Object.values(snapshot.nodes).filter(
        (n) => n.funcIndex === byName.get(name),
      );
    expect(nodesOf("chain_a").reduce((a, n) => a + n.calls, 0)).toBe(1);
    expect(nodesOf("chain_b").reduce((a, n) => a + n.calls, 0)).toBe(1);
    expect(nodesOf("chain_c").reduce((a, n) => a + n.calls, 0)).toBe(2);
    const [a] = nodesOf("chain_a");
    const [b] = nodesOf("chain_b");
    const [c] = nodesOf("chain_c");
    expect(b!.parentId).toBe(a!.id);
    expect(c!.parentId).toBe(b!.id);
  });

  it("produces a ProfileRun with exact counts and consistent times", async () => {
    const agg = new TraceAggregator();
    const funcNames = names();
    agg.addModule({
      id: "test-module",
      hash: "feedface",
      url: "http://localhost:8000/app.wasm",
      functionCount: result.definedFunctionCount,
      funcNames: funcNames.map((n) => n ?? ""),
    });
    const wasm = await instantiate(result.bytes, agg);
    wasm.fib(15);
    wasm.chain_a(100);
    const run = assembleTraceRun(agg.snapshot(), {
      startedAt: 0,
      endedAt: 1000,
    });
    expect(run.mode).toBe("tracing");
    const total = totalProfileMs(run);
    expect(total).toBeGreaterThan(0);
    let selfSum = 0;
    for (const node of Object.values(run.nodes)) {
      expect(node.quality).toBe("name");
      selfSum += node.selfMs;
      const childSum = node.children.reduce(
        (acc, id) => acc + run.nodes[id]!.totalMs,
        0,
      );
      expect(node.selfMs).toBeCloseTo(node.totalMs - childSum, 9);
    }
    expect(selfSum).toBeCloseTo(total, 9);
    const fibRoot = Object.values(run.nodes).find(
      (n) => n.label === "fib" && n.parentId === null,
    )!;
    expect(fibRoot.calls).toBe(1);
  });

  it("limits scope through the include predicate", async () => {
    const scoped = await instrumentModule(
      original,
      (_idx, name) => name === "fib",
    );
    expect(scoped.instrumentedFunctions.map((f) => f.name)).toEqual(["fib"]);
    const agg = new TraceAggregator();
    const wasm = await instantiate(scoped.bytes, agg);
    expect(wasm.chain_a(10)).toBe(316);
    expect(wasm.fib(5)).toBe(5);
    const snapshot = agg.snapshot();
    const kinds = new Set(
      Object.values(snapshot.nodes).map((n) => n.funcIndex),
    );
    expect(kinds.size).toBe(1);
    const fibCalls = Object.values(snapshot.nodes).reduce(
      (a, n) => a + n.calls,
      0,
    );
    expect(fibCalls).toBe(15);
  });
});
