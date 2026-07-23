import { describe, expect, it } from "vitest";
import {
  aggregateFunctions,
  flattenCallTree,
  totalProfileMs,
} from "../src/shared/callTree";
import { convertCdpProfile, type CdpProfile } from "../src/shared/cdpConvert";
import type { ProfileRun } from "../src/shared/profile";

const frame = (functionName: string, url: string, scriptId = "42") => ({
  functionName,
  scriptId,
  url,
});

const fixture: CdpProfile = {
  startTime: 0,
  endTime: 3_000_000,
  nodes: [
    { id: 1, callFrame: frame("(root)", "", "1"), children: [4, 7] },
    { id: 4, callFrame: frame("fib", "wasm://wasm/abc123"), children: [5] },
    { id: 5, callFrame: frame("fib", "wasm://wasm/abc123"), children: [6] },
    { id: 6, callFrame: frame("hot_step", "wasm://wasm/abc123") },
    { id: 7, callFrame: frame("wasm-function[7]", "wasm://wasm/abc123") },
  ],
  samples: [6, 6, 4, 7],
  timeDeltas: [1000, 1000, 500, 250],
};

const run = convertCdpProfile(fixture, { startedAt: 0, endedAt: 3000 });

describe("flattenCallTree", () => {
  it("orders roots and children by total time, tracking depth", () => {
    const rows = flattenCallTree(run, new Set());
    expect(rows.map((r) => [r.node.label, r.depth])).toEqual([
      ["fib", 0],
      ["fib", 1],
      ["hot_step", 2],
      ["wasm-function[7]", 0],
    ]);
  });

  it("marks nested same-label frames as recursive", () => {
    const rows = flattenCallTree(run, new Set());
    expect(rows.map((r) => r.recursive)).toEqual([false, true, false, false]);
  });

  it("hides descendants of collapsed nodes", () => {
    const fibRootId = run.roots.find((id) => run.nodes[id]!.label === "fib")!;
    const rows = flattenCallTree(run, new Set([fibRootId]));
    expect(rows.map((r) => r.node.label)).toEqual(["fib", "wasm-function[7]"]);
  });
});

describe("aggregateFunctions", () => {
  it("merges recursive frames without double-counting total time", () => {
    const rows = aggregateFunctions(run);
    expect(rows.map((r) => r.label)).toEqual([
      "fib",
      "hot_step",
      "wasm-function[7]",
    ]);

    const fib = rows[0]!;
    expect(fib.totalMs).toBeCloseTo(2.5);
    expect(fib.selfMs).toBeCloseTo(0.5);
    expect(fib.nodeCount).toBe(2);

    const hotStep = rows[1]!;
    expect(hotStep.totalMs).toBeCloseTo(2.0);
    expect(hotStep.selfMs).toBeCloseTo(2.0);
  });

  it("carries funcIndex when every node under a label agrees", () => {
    const row = aggregateFunctions(run).find(
      (r) => r.label === "wasm-function[7]",
    )!;
    expect(row.funcIndex).toBe(7);
  });

  it("drops funcIndex when nodes under one label disagree", () => {
    const node = (
      id: number,
      parentId: number | null,
      children: number[],
      funcIndex: number,
    ) => ({
      id,
      parentId,
      children,
      label: "shared",
      quality: "name" as const,
      funcIndex,
      totalMs: 1,
      selfMs: 1,
    });
    const conflicted: ProfileRun = {
      ...run,
      roots: [100],
      nodes: { 100: node(100, null, [101], 7), 101: node(101, 100, [], 9) },
    };
    const row = aggregateFunctions(conflicted).find(
      (r) => r.label === "shared",
    )!;
    expect(row.nodeCount).toBe(2);
    expect(row.funcIndex).toBeUndefined();
  });
});

describe("totalProfileMs", () => {
  it("sums root totals", () => {
    expect(totalProfileMs(run)).toBeCloseTo(2.75);
  });
});
