import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDebugInfo, parseDebugLine } from "../src/tool/dwarfdump";

const lineText = readFileSync(
  "tests/fixtures/dwarfdump-debug-line.txt",
  "utf8",
);
const infoText = readFileSync(
  "tests/fixtures/dwarfdump-debug-info.txt",
  "utf8",
);

const rawRows = lineText
  .split("\n")
  .filter((l) => /^0x[0-9a-f]{16}\s/.test(l));
const endSequences = rawRows.filter((l) => l.includes("end_sequence"));

describe("parseDebugLine (captured llvm-dwarfdump 14 output)", () => {
  const rows = parseDebugLine(lineText);

  it("extracts every row of the line table program", () => {
    expect(rows).toHaveLength(rawRows.length - endSequences.length);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("joins the include directory onto the file name", () => {
    for (const row of rows) {
      expect(row.file.startsWith("/")).toBe(true);
      expect(row.file).toMatch(/\.rs$/);
      expect(row.line).toBeGreaterThan(0);
      expect(Number.isInteger(row.address)).toBe(true);
    }
  });

  it("drops the end_sequence row", () => {
    expect(endSequences.length).toBeGreaterThan(0);
    for (const raw of endSequences) {
      const address = Number.parseInt(raw.slice(0, 18), 16);
      expect(rows.some((r) => r.address === address)).toBe(false);
    }
  });

  it("returns nothing for empty output", () => {
    expect(parseDebugLine("")).toEqual([]);
  });
});

describe("parseDebugInfo (captured llvm-dwarfdump 14 output)", () => {
  const subs = parseDebugInfo(infoText);
  const byName = (name: string) => subs.find((s) => s.name === name)!;

  it("extracts the subprograms of the fixture compile unit", () => {
    const names = subs.map((s) => s.name);
    for (const fn of [
      "fib",
      "hot_loop",
      "hot_step",
      "chain_a",
      "chain_b",
      "chain_c",
    ]) {
      expect(names, fn).toContain(fn);
    }
  });

  it("keeps low/high pc and decl lines", () => {
    const fib = byName("fib");
    expect(fib.declLine).toBe(2);
    expect(Number.isInteger(fib.lowPc)).toBe(true);
    expect(fib.highPc!).toBeGreaterThan(fib.lowPc);
  });

  it("strips comp_dir from decl files", () => {
    for (const s of subs) expect(s.declFile).toBe("src/lib.rs");
  });

  it("records linkage names only where DWARF has them", () => {
    expect(byName("chain_b").linkageName).toMatch(
      /^_RNvC\w+_16profiler_fixture7chain_b$/,
    );
    expect(byName("chain_a").linkageName).toBeUndefined();
  });

  it("ignores parameters, variables, and lexical blocks", () => {
    const locals = ["n", "x", "acc", "iter", "i", "depth"];
    for (const s of subs) {
      expect(locals).not.toContain(s.name);
      expect(Number.isInteger(s.lowPc)).toBe(true);
    }
  });
});
