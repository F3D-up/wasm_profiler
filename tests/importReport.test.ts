import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importCpuProfile } from "../src/shared/cpuprofile";
import { importReport } from "../src/shared/importReport";
import { buildReport } from "../src/shared/report";

const original = importCpuProfile(
  readFileSync(join(__dirname, "fixtures", "node-fib.cpuprofile"), "utf8"),
  "node-fib.cpuprofile",
);

describe("importReport", () => {
  it("round-trips a captured run through buildReport", () => {
    const back = importReport(JSON.stringify(buildReport(original)));
    expect(back.mode).toBe(original.mode);
    expect(back.sampleCount).toBe(original.sampleCount);
    expect(Object.keys(back.modules)).toEqual(Object.keys(original.modules));
    expect([...back.roots].sort()).toEqual([...original.roots].sort());
    expect(Object.keys(back.nodes)).toHaveLength(
      Object.keys(original.nodes).length,
    );
    for (const node of Object.values(original.nodes)) {
      const copy = back.nodes[node.id]!;
      expect(copy.label).toBe(node.label);
      expect(copy.parentId).toBe(node.parentId);
      expect([...copy.children].sort()).toEqual([...node.children].sort());
      expect(copy.samples).toBe(node.samples);
      expect(copy.totalMs).toBeCloseTo(node.totalMs, 3);
      expect(copy.selfMs).toBeCloseTo(node.selfMs, 3);
    }
  });

  it("rejects a file that is not a report", () => {
    expect(() => importReport('{"nodes":[]}')).toThrow(/wasm-profiler-report/);
  });
});
