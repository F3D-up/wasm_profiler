import type { CallTreeNode, CapturedModule, ProfileMode, ProfileRun } from './profile';
import { REPORT_KIND } from './report';

const fail = (message: string): never => {
  throw new Error(message);
};

export function isReportFile(text: string): boolean {

  try {

    const data: unknown = JSON.parse(text);

    return (
      typeof data === 'object' &&
      data !== null &&
      (data as Record<string, unknown>)['kind'] === REPORT_KIND
    );
  } catch {
    return false;
  }
}

export function importReport(text: string, filename?: string): ProfileRun {

  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    fail('Not valid JSON — expected a profiler JSON report.');
  }

  const raw = data as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || raw['kind'] !== REPORT_KIND) {
    fail(
      `Not a profiler JSON report (missing "kind": "${REPORT_KIND}"). Use a report exported by this extension, or a DevTools .cpuprofile file.`
    );
  }

  const profile = raw['profile'] as Record<string, unknown> | undefined;
  if (typeof profile !== 'object' || profile === null) fail('Report is missing its profile section.');

  if (profile!['version'] !== 3) {
    fail(`Report has profile version ${String(profile!['version'])}; this build reads version 3.`);
  }

  if (!Array.isArray(raw['callTree'])) fail('Report is missing callTree[].');

  const modules: Record<string, CapturedModule> = {};
  for (const entry of (raw['modules'] as CapturedModule[] | undefined) ?? []) {
    if (typeof entry?.id === 'string') modules[entry.id] = entry;
  }

  const nodes: Record<number, CallTreeNode> = {};
  const roots: number[] = [];

  for (const entry of raw['callTree'] as Record<string, unknown>[]) {

    const id = entry['id'];
    if (typeof id !== 'number') fail('Report has a callTree row without a numeric id.');

    const parentId = typeof entry['parentId'] === 'number' ? entry['parentId'] : null;
    const inferred = entry['inferredFuncIdx'] === true;
    const inferredSrc = entry['inferredSource'] === true;

    nodes[id as number] = {
      id: id as number,
      parentId,
      children: [],
      label: String(entry['label'] ?? entry['name'] ?? ''),
      moduleId: typeof entry['moduleId'] === 'string' ? entry['moduleId'] : undefined,
      funcIndex: !inferred && typeof entry['funcIndex'] === 'number' ? entry['funcIndex'] : undefined,
      source: !inferredSrc && typeof entry['source'] === 'string' ? entry['source'] : undefined,
      quality: (entry['quality'] as CallTreeNode['quality']) ?? 'fallback',
      calls: typeof entry['calls'] === 'number' ? entry['calls'] : undefined,
      samples: typeof entry['samples'] === 'number' ? entry['samples'] : undefined,
      selfSamples: typeof entry['selfSamples'] === 'number' ? entry['selfSamples'] : undefined,
      totalMs: typeof entry['totalMs'] === 'number' ? entry['totalMs'] : 0,
      selfMs: typeof entry['selfMs'] === 'number' ? entry['selfMs'] : 0
    };
  }

  for (const node of Object.values(nodes)) {
    if (node.parentId === null) roots.push(node.id);
    else if (nodes[node.parentId]) nodes[node.parentId]!.children.push(node.id);
    else fail(`Report row ${node.id} names parent ${node.parentId}, which is not in the file.`);
  }

  if (roots.length === 0 && Object.keys(nodes).length > 0) fail('Report has no root rows.');

  const num = (key: string): number | undefined =>
    typeof profile![key] === 'number' ? (profile![key] as number) : undefined;

  return {
    version: 3,
    mode: profile!['mode'] === 'tracing' ? 'tracing' : ('sampling' as ProfileMode),
    targetUrl: typeof profile!['targetUrl'] === 'string' ? (profile!['targetUrl'] as string) : filename,
    startedAt: num('startedAt') ?? 0,
    endedAt: num('endedAt') ?? 0,
    modules,
    roots,
    nodes,
    sampleIntervalMicroS: num('sampleIntervalMicroS'),
    sampleCount: num('sampleCount'),
    eventCount: num('eventCount'),
    unbalancedEvents: num('unbalancedEvents'),
    traceIssues: Array.isArray(profile!['traceIssues'])
      ? (profile!['traceIssues'] as string[])
      : undefined
  };
}
