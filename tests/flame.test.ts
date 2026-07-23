import flamegraph from "d3-flame-graph";
import { select } from "d3-selection";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { convertCdpProfile, type CdpProfile } from "../src/shared/cdpConvert";
import { totalProfileMs } from "../src/shared/callTree";
import { buildFlameGraph, type FlameFrame } from "../src/shared/flame";
import type { ArtifactSymbols } from "../src/shared/profile";
import { resolveFrame } from "../src/shared/artifacts";

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

const sumSelf = (node: FlameFrame): number =>
  node.selfMs + node.children.reduce((acc, child) => acc + sumSelf(child), 0);

describe("buildFlameGraph", () => {
  it("roots the tree at the profile total with children ordered by total time", () => {
    const root = buildFlameGraph(run);
    expect(root.value).toBeCloseTo(totalProfileMs(run));
    expect(root.value).toBeCloseTo(2.75);
    expect(root.children.map((c) => [c.name, c.value])).toEqual([
      ["fib", 2.5],
      ["wasm-function[7]", 0.25],
    ]);
  });

  it("carries each node total as an inclusive value that covers its children", () => {
    const root = buildFlameGraph(run);
    const check = (node: FlameFrame): void => {
      const childSum = node.children.reduce(
        (acc, child) => acc + child.value,
        0,
      );
      expect(node.value + 1e-9).toBeGreaterThanOrEqual(childSum);
      node.children.forEach(check);
    };
    check(root);
    expect(sumSelf(root)).toBeCloseTo(totalProfileMs(run));
  });

  it("keeps recursive frames as distinct nodes rather than merging them", () => {
    const root = buildFlameGraph(run);
    const outer = root.children[0]!;
    const inner = outer.children[0]!;
    expect(outer.name).toBe("fib");
    expect(inner.name).toBe("fib");
    expect(outer.value).toBeCloseTo(2.5);
    expect(outer.selfMs).toBeCloseTo(0.5);
    expect(inner.value).toBeCloseTo(2.0);
    expect(inner.selfMs).toBeCloseTo(0);
  });

  it("labels frames with resolved symbols when a resolver is supplied", () => {
    const artifact: ArtifactSymbols = {
      hash: "deadbeef",
      filename: "app.debug.wasm",
      symbolQuality: "debug",
      symbols: {
        3: { name: "fib", source: "src/lib.rs", line: 2, quality: "debug" },
      },
      createdAt: 0,
    };
    const root = buildFlameGraph(run, (node) =>
      resolveFrame(node, undefined, [artifact]),
    );
    const outer = root.children[0]!;
    expect(outer.name).toBe("fib");
    expect(outer.source).toBe("src/lib.rs:2");
    expect(outer.quality).toBe("debug");
  });
});

describe("d3-flame-graph rendering", () => {
  const render = (width: number): Map<string, number[]> => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    const host = dom.window.document.querySelector("#host")!;
    const chart = flamegraph()
      .width(width)
      .transitionDuration(0)
      .tooltip(false);
    select(host).datum(buildFlameGraph(run)).call(chart);

    const widths = new Map<string, number[]>();
    for (const g of host.querySelectorAll("g.frame")) {
      const name = g.getAttribute("name")!;
      const value = Number(g.getAttribute("width"));
      widths.set(name, [...(widths.get(name) ?? []), value]);
    }
    return widths;
  };

  it("gives every frame a width proportional to its call-tree total", () => {
    const chartWidth = 1000;
    const widths = render(chartWidth);
    const scale = chartWidth / totalProfileMs(run);

    const expectWidths = (name: string, expected: number[]): void => {
      const actual = [...widths.get(name)!].sort((a, b) => b - a);
      expect(actual).toHaveLength(expected.length);
      expected.forEach((ms, i) =>
        expect(actual[i]!).toBeCloseTo(ms * scale, 6),
      );
    };

    expectWidths("all WASM", [totalProfileMs(run)]);
    expectWidths("fib", [2.5, 2.0]);
    expectWidths("hot_step", [2.0]);
    expectWidths("wasm-function[7]", [0.25]);
  });

  it("renders one frame per call-tree node plus the synthetic root", () => {
    const widths = render(800);
    const rendered = [...widths.values()].reduce(
      (acc, list) => acc + list.length,
      0,
    );
    expect(rendered).toBe(Object.keys(run.nodes).length + 1);
  });
});
