import { resolveFrame } from './artifacts';
import { aggregateFunctions, flattenCallTree, totalProfileMs } from './callTree';
import type { ArtifactSymbols, ProfileRun } from './profile';

const TOP_FUNCTIONS_CAP = 250;

export const REPORT_KIND = 'wasm-profiler-report';

export function buildReport(run: ProfileRun, artifacts: ArtifactSymbols[] = []): object {

  const totalMs = totalProfileMs(run);
  const pct = (ms: number): number => (totalMs > 0 ? +((ms / totalMs) * 100).toFixed(2) : 0);
  const moduleFor = (moduleId?: string) =>
    moduleId !== undefined ? run.modules[moduleId] : undefined;

  const functions = aggregateFunctions(run);
  const rows = flattenCallTree(run, new Set());

  return {
    kind: REPORT_KIND,
    exportedAt: new Date().toISOString(),
    truncated: functions.length > TOP_FUNCTIONS_CAP,
    profile: {
      version: run.version,
      mode: run.mode,
      targetUrl: run.targetUrl,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.endedAt - run.startedAt,
      sampleIntervalMicroS: run.sampleIntervalMicroS,
      sampleCount: run.sampleCount,
      eventCount: run.eventCount,
      unbalancedEvents: run.unbalancedEvents,
      traceIssues: run.traceIssues,
      moduleCount: Object.keys(run.modules).length
    },
    artifacts: artifacts.map((a) => ({
      filename: a.filename,
      hash: a.hash,
      symbolQuality: a.symbolQuality,
      functionCount: a.functionCount,
      symbolCount: Object.keys(a.symbols).length,
      sourceCount: a.sources?.length ?? 0
    })),
    modules: Object.values(run.modules),
    topFunctions: functions.slice(0, TOP_FUNCTIONS_CAP).map((f) => {
      const resolved = resolveFrame(
        { label: f.label, funcIndex: undefined, quality: f.quality, source: undefined },
        moduleFor(f.moduleId),
        artifacts
      );
      return {
        name: resolved.name,
        moduleId: f.moduleId,
        quality: resolved.quality,
        source: resolved.source,
        line: resolved.line,
        funcIndex: resolved.funcIndex,
        inferredFuncIdx: resolved.inferredFuncIdx,
        inferredSource: resolved.inferredSource,
        totalMs: +f.totalMs.toFixed(3),
        selfMs: +f.selfMs.toFixed(3),
        totalPercent: pct(f.totalMs),
        selfPercent: pct(f.selfMs),
        samples: f.samples,
        selfSamples: f.selfSamples,
        calls: f.calls
      };
    }),
    callTree: rows.map((r) => {
      const resolved = resolveFrame(r.node, moduleFor(r.node.moduleId), artifacts);
      return {
        id: r.node.id,
        parentId: r.node.parentId,
        depth: r.depth,
        name: resolved.name,
        label: r.node.label,
        source: resolved.source ?? r.node.source,
        line: resolved.line,
        quality: resolved.quality,
        moduleId: r.node.moduleId,
        funcIndex: resolved.funcIndex,
        inferredFuncIdx: resolved.inferredFuncIdx,
        inferredSource: resolved.inferredSource,
        samples: r.node.samples,
        selfSamples: r.node.selfSamples,
        calls: r.node.calls,
        totalMs: +r.node.totalMs.toFixed(3),
        selfMs: +r.node.selfMs.toFixed(3),
        totalPercent: pct(r.node.totalMs),
        selfPercent: pct(r.node.selfMs),
        recursive: r.recursive
      };
    })
  };
}
