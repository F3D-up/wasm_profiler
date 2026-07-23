import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { totalProfileMs } from "../src/shared/callTree";
import { importCpuProfile, parseCpuProfile } from "../src/shared/cpuprofile";
import type { CallTreeNode, ProfileRun } from "../src/shared/profile";

const fixtureText = readFileSync(
  join(__dirname, "fixtures", "node-fib.cpuprofile"),
  "utf8",
);

const labelSet = (run: ProfileRun): Set<string> =>
  new Set(Object.values(run.nodes).map((n) => n.label));

const isFn = (label: string | undefined, name: string): boolean =>
  label === name || label?.endsWith(`${name.length}${name}`) === true;

describe("parseCpuProfile", () => {
  it("accepts a real node --cpu-prof recording", () => {
    const profile = parseCpuProfile(fixtureText);
    expect(profile.nodes.length).toBeGreaterThan(100);
    expect(profile.samples!.length).toBeGreaterThan(1000);
    expect(profile.timeDeltas!.length).toBe(profile.samples!.length);
    for (const node of profile.nodes) {
      expect(typeof node.callFrame.scriptId).toBe("string");
    }
  });

  it("normalizes numeric scriptIds to strings", () => {
    const profile = parseCpuProfile(
      JSON.stringify({
        startTime: 0,
        endTime: 1000,
        nodes: [
          { id: 1, callFrame: { functionName: "f", scriptId: 7, url: "" } },
        ],
        samples: [1],
        timeDeltas: [100],
      }),
    );
    expect(profile.nodes[0]!.callFrame.scriptId).toBe("7");
  });

  it("rejects non-JSON input", () => {
    expect(() => parseCpuProfile("not json")).toThrow(/valid JSON/);
  });

  it("rejects Performance-panel traces with a pointer to the right recorder", () => {
    expect(() => parseCpuProfile('{"traceEvents":[]}')).toThrow(
      /JavaScript Profiler/,
    );
    expect(() => parseCpuProfile("[]")).toThrow(/JavaScript Profiler/);
  });

  it("rejects JSON that is not a profile", () => {
    expect(() => parseCpuProfile("{}")).toThrow(/nodes/);
    expect(() =>
      parseCpuProfile('{"nodes":[{"id":1,"callFrame":{}}]}'),
    ).toThrow(/startTime/);
  });
});

describe("importCpuProfile", () => {
  const run = importCpuProfile(fixtureText, "node-fib.cpuprofile");

  it("produces a sampling ProfileRun through the shared converter", () => {
    expect(run.mode).toBe("sampling");
    expect(run.version).toBe(3);
    expect(run.targetUrl).toBe("node-fib.cpuprofile");
    expect(run.roots.length).toBeGreaterThan(0);
    expect(run.sampleCount).toBeGreaterThan(1000);
    expect(run.endedAt - run.startedAt).toBeGreaterThan(0);
  });

  it("keeps only WASM frames and finds the known workload functions", () => {
    const labels = [...labelSet(run)];
    for (const name of [
      "fib",
      "hot_loop",
      "hot_step",
      "chain_a",
      "chain_b",
      "chain_c",
    ]) {
      expect(labels.some((l) => isFn(l, name)), name).toBe(true);
    }
    for (const node of Object.values(run.nodes)) {
      expect(node.source).toMatch(/^wasm:/);
    }
  });

  it("preserves the known call shapes from the workload", () => {
    const nodes = Object.values(run.nodes);
    const byId = run.nodes;
    const parentLabel = (n: CallTreeNode): string | undefined =>
      n.parentId !== null ? byId[n.parentId]?.label : undefined;

    const chainC = nodes.find((n) => isFn(n.label, "chain_c"))!;
    expect(isFn(parentLabel(chainC), "chain_b")).toBe(true);
    expect(isFn(parentLabel(byId[chainC.parentId!]!), "chain_a")).toBe(true);

    const hotStepUnderLoop = nodes.find(
      (n) => isFn(n.label, "hot_step") && isFn(parentLabel(n), "hot_loop"),
    );
    expect(hotStepUnderLoop).toBeDefined();

    let deepest = 0;
    for (const node of nodes.filter((n) => isFn(n.label, "fib"))) {
      let depth = 0;
      let cur: CallTreeNode | undefined = node;
      while (cur !== undefined && isFn(cur.label, "fib")) {
        depth++;
        cur = cur.parentId !== null ? byId[cur.parentId] : undefined;
      }
      deepest = Math.max(deepest, depth);
    }
    expect(deepest).toBeGreaterThanOrEqual(10);
  });

  it("satisfies the call-tree accounting invariants", () => {
    const total = totalProfileMs(run);
    expect(total).toBeGreaterThan(0);
    let selfSum = 0;
    for (const node of Object.values(run.nodes)) {
      selfSum += node.selfMs;
      const childSum = node.children.reduce(
        (acc, id) => acc + run.nodes[id]!.totalMs,
        0,
      );
      expect(node.totalMs + 1e-9).toBeGreaterThanOrEqual(childSum);
      expect(node.selfMs).toBeCloseTo(node.totalMs - childSum, 9);
    }
    expect(selfSum).toBeCloseTo(total, 9);
    const rootSum = run.roots.reduce(
      (acc, id) => acc + run.nodes[id]!.totalMs,
      0,
    );
    expect(rootSum).toBeCloseTo(total, 9);
  });
});
