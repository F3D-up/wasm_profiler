import { describe, expect, it } from "vitest";
import { totalProfileMs } from "../src/shared/callTree";
import {
  TraceAggregator,
  assembleTraceRun,
  type TraceModuleMeta,
} from "../src/shared/traceConvert";

const meta: TraceModuleMeta = {
  id: "wasm://wasm/abc123",
  hash: "cafe1234",
  url: "wasm://wasm/abc123",
  functionCount: 3,
  funcNames: ["fib", "hot_step", ""],
};

const aggregate = (
  events: Array<["enter" | "exit", number, number]>,
): ReturnType<TraceAggregator["snapshot"]> => {
  const agg = new TraceAggregator();
  agg.addModule(meta);
  for (const [kind, funcIndex, at] of events) {
    if (kind === "enter") agg.enter(meta.id, funcIndex, at);
    else agg.exit(funcIndex, at);
  }
  return agg.snapshot();
};

describe("TraceAggregator", () => {
  it("measures a nested call with exact self/total split", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 1, 2],
      ["exit", 1, 5],
      ["exit", 0, 10],
    ]);
    expect(snapshot.roots).toHaveLength(1);
    const outer = snapshot.nodes[snapshot.roots[0]!]!;
    const inner = snapshot.nodes[outer.children[0]!]!;
    expect(outer.calls).toBe(1);
    expect(outer.totalMs).toBe(10);
    expect(outer.selfMs).toBe(7);
    expect(inner.calls).toBe(1);
    expect(inner.totalMs).toBe(3);
    expect(inner.selfMs).toBe(3);
    expect(snapshot.eventCount).toBe(4);
    expect(snapshot.unbalancedEvents).toBe(0);
  });

  it("folds repeated calls into one node with summed counts and times", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 1, 1],
      ["exit", 1, 2],
      ["enter", 1, 3],
      ["exit", 1, 5],
      ["exit", 0, 6],
    ]);
    const outer = snapshot.nodes[snapshot.roots[0]!]!;
    expect(outer.children).toHaveLength(1);
    const inner = snapshot.nodes[outer.children[0]!]!;
    expect(inner.calls).toBe(2);
    expect(inner.totalMs).toBe(3);
    expect(outer.selfMs).toBe(3);
  });

  it("keeps recursive calls as distinct depth nodes", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 0, 1],
      ["exit", 0, 3],
      ["exit", 0, 6],
    ]);
    const outer = snapshot.nodes[snapshot.roots[0]!]!;
    const inner = snapshot.nodes[outer.children[0]!]!;
    expect(outer.funcIndex).toBe(0);
    expect(inner.funcIndex).toBe(0);
    expect(outer.totalMs).toBe(6);
    expect(outer.selfMs).toBe(4);
    expect(inner.totalMs).toBe(2);
  });

  it("creates a new root after the stack empties", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["exit", 0, 1],
      ["enter", 1, 2],
      ["exit", 1, 4],
    ]);
    expect(snapshot.roots).toHaveLength(2);
    expect(snapshot.nodes[snapshot.roots[1]!]!.totalMs).toBe(2);
  });

  it("ignores an exit that matches nothing on the stack", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["exit", 2, 1],
      ["exit", 0, 2],
    ]);
    expect(snapshot.unbalancedEvents).toBe(1);
    expect(snapshot.nodes[snapshot.roots[0]!]!.totalMs).toBe(2);
  });

  it("unwinds frames whose exits were skipped by a trap", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 1, 1],
      ["exit", 0, 4],
    ]);
    expect(snapshot.unbalancedEvents).toBe(1);
    const outer = snapshot.nodes[snapshot.roots[0]!]!;
    const inner = snapshot.nodes[outer.children[0]!]!;
    expect(inner.totalMs).toBe(3);
    expect(outer.totalMs).toBe(4);
    expect(outer.selfMs).toBe(1);
  });

  it("closes frames still open at snapshot time at the last seen timestamp", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 1, 2],
      ["exit", 1, 5],
    ]);
    expect(snapshot.unbalancedEvents).toBe(1);
    expect(snapshot.nodes[snapshot.roots[0]!]!.totalMs).toBe(5);
  });
});

describe("assembleTraceRun", () => {
  it("produces a tracing ProfileRun satisfying the call-tree invariants", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["enter", 0, 1],
      ["enter", 1, 2],
      ["exit", 1, 4],
      ["exit", 0, 5],
      ["exit", 0, 8],
      ["enter", 2, 9],
      ["exit", 2, 10],
    ]);
    const run = assembleTraceRun(snapshot, {
      targetUrl: "http://localhost:8000",
      startedAt: 100,
      endedAt: 200,
    });
    expect(run.mode).toBe("tracing");
    expect(run.eventCount).toBe(8);
    expect(run.unbalancedEvents).toBeUndefined();
    expect(totalProfileMs(run)).toBe(9);
    let selfSum = 0;
    for (const node of Object.values(run.nodes)) {
      selfSum += node.selfMs;
      const childSum = node.children.reduce(
        (acc, id) => acc + run.nodes[id]!.totalMs,
        0,
      );
      expect(node.selfMs).toBeCloseTo(node.totalMs - childSum, 9);
    }
    expect(selfSum).toBeCloseTo(totalProfileMs(run), 9);
  });

  it("labels nodes from funcNames with quality name, else fallback", () => {
    const snapshot = aggregate([
      ["enter", 0, 0],
      ["exit", 0, 1],
      ["enter", 2, 2],
      ["exit", 2, 3],
    ]);
    const run = assembleTraceRun(snapshot, { startedAt: 0, endedAt: 10 });
    const labels = Object.values(run.nodes).map((n) => [
      n.label,
      n.quality,
      n.funcIndex,
    ]);
    expect(labels).toContainEqual(["fib", "name", 0]);
    expect(labels).toContainEqual(["wasm-function[2]", "fallback", 2]);
    const module = run.modules[meta.id]!;
    expect(module.symbolQuality).toBe("name");
    expect(module.hash).toBe("cafe1234");
  });

  it("flags unbalanced runs and marks stripped modules", () => {
    const agg = new TraceAggregator();
    agg.addModule({ ...meta, funcNames: ["", "", ""] });
    agg.enter(meta.id, 0, 0);
    const run = assembleTraceRun(agg.snapshot(), { startedAt: 0, endedAt: 1 });
    expect(run.unbalancedEvents).toBe(1);
    expect(run.modules[meta.id]!.symbolQuality).toBe("stripped");
  });
});
