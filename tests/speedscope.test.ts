import { describe, expect, it } from "vitest";
import { totalProfileMs } from "../src/shared/callTree";
import { convertCdpProfile, type CdpProfile } from "../src/shared/cdpConvert";
import type { ArtifactSymbols } from "../src/shared/profile";
import {
  buildSpeedscopeFile,
  type SpeedscopeEvent,
  type SpeedscopeFile,
} from "../src/shared/speedscope";

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

interface ReplayNode {
  name: string;
  start: number;
  end: number;
  children: ReplayNode[];
}

const replay = (file: SpeedscopeFile): ReplayNode[] => {
  const { events } = file.profiles[0]!;
  const roots: ReplayNode[] = [];
  const stack: ReplayNode[] = [];
  let lastAt = -Infinity;
  for (const event of events) {
    expect(event.at).toBeGreaterThanOrEqual(lastAt);
    lastAt = event.at;
    const name = file.shared.frames[event.frame]!.name;
    if (event.type === "O") {
      const node: ReplayNode = {
        name,
        start: event.at,
        end: NaN,
        children: [],
      };
      (stack.length > 0 ? stack[stack.length - 1]!.children : roots).push(node);
      stack.push(node);
    } else {
      const open = stack.pop()!;
      expect(open.name).toBe(name);
      open.end = event.at;
    }
  }
  expect(stack).toHaveLength(0);
  return roots;
};

describe("buildSpeedscopeFile", () => {
  it("emits a valid evented speedscope file spanning the profile total", () => {
    const file = buildSpeedscopeFile(run);
    expect(file.$schema).toBe(
      "https://www.speedscope.app/file-format-schema.json",
    );
    expect(file.exporter).toBe("wasm-profiler");
    expect(file.activeProfileIndex).toBe(0);
    const profile = file.profiles[0]!;
    expect(profile.type).toBe("evented");
    expect(profile.unit).toBe("milliseconds");
    expect(profile.startValue).toBe(0);
    expect(profile.endValue).toBeCloseTo(totalProfileMs(run));
    expect(profile.events).toHaveLength(2 * Object.keys(run.nodes).length);
  });

  it("deduplicates frames by name, file and line", () => {
    const file = buildSpeedscopeFile(run);
    expect(file.shared.frames.map((f) => f.name).sort()).toEqual([
      "fib",
      "hot_step",
      "wasm-function[7]",
    ]);
    for (const event of file.profiles[0]!.events) {
      expect(file.shared.frames[event.frame]).toBeDefined();
    }
  });

  it("replays into properly nested intervals matching call-tree totals", () => {
    const roots = replay(buildSpeedscopeFile(run));
    expect(roots.map((r) => [r.name, r.end - r.start])).toEqual([
      ["fib", 2.5],
      ["wasm-function[7]", 0.25],
    ]);
    const outer = roots[0]!;
    const inner = outer.children[0]!;
    expect(inner.name).toBe("fib");
    expect(inner.end - inner.start).toBeCloseTo(2.0);
    expect(inner.start).toBeGreaterThanOrEqual(outer.start);
    expect(inner.end).toBeLessThanOrEqual(outer.end);
    const leaf = inner.children[0]!;
    expect(leaf.name).toBe("hot_step");
    expect(leaf.end - leaf.start).toBeCloseTo(2.0);
  });

  it("bakes resolved names, files and lines into exported frames", () => {
    const artifact: ArtifactSymbols = {
      hash: "deadbeef",
      filename: "app.debug.wasm",
      symbolQuality: "debug",
      symbols: {
        3: { name: "fib", source: "src/lib.rs", line: 2, quality: "debug" },
      },
      createdAt: 0,
    };
    const file = buildSpeedscopeFile(run, [artifact]);
    const fib = file.shared.frames.find((f) => f.name === "fib")!;
    expect(fib.file).toBe("src/lib.rs");
    expect(fib.line).toBe(2);
  });

  it("round-trips through JSON without loss", () => {
    const file = buildSpeedscopeFile(run);
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe("speedscope event ordering", () => {
  it("keeps at values non-decreasing across sibling subtrees", () => {
    const file = buildSpeedscopeFile(run);
    const ats = file.profiles[0]!.events.map((e: SpeedscopeEvent) => e.at);
    for (let i = 1; i < ats.length; i++) {
      expect(ats[i]!).toBeGreaterThanOrEqual(ats[i - 1]!);
    }
  });
});
