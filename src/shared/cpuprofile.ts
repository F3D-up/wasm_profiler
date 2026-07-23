import { convertCdpProfile, type CdpProfile, type CdpProfileNode } from './cdpConvert';
import type { ProfileRun } from './profile';

export function parseCpuProfile(text: string): CdpProfile {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON — expected a DevTools .cpuprofile file.');
  }

  if (Array.isArray(data) || (typeof data === 'object' && data !== null && 'traceEvents' in data)) {
    throw new Error(
      'This looks like a Performance-panel trace, not a .cpuprofile. Record with the DevTools "JavaScript Profiler" panel (or node --cpu-prof) and save that file instead.'
    );
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Not a .cpuprofile: expected a JSON object with nodes, samples and timeDeltas.');
  }

  const raw = data as Record<string, unknown>;
  if (!Array.isArray(raw['nodes']) || raw['nodes'].length === 0) {
    throw new Error('Not a .cpuprofile: missing nodes[].');
  }

  if (typeof raw['startTime'] !== 'number' || typeof raw['endTime'] !== 'number') {
    throw new Error('Not a .cpuprofile: missing startTime/endTime.');
  }

  for (const field of ['samples', 'timeDeltas']) {

    const value = raw[field];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`Not a .cpuprofile: ${field} is not an array.`);
    }
  }

  const nodes: CdpProfileNode[] = raw['nodes'].map((element: unknown) => {

    const node = element as Record<string, unknown>;
    const callFrame = node['callFrame'] as Record<string, unknown> | undefined;

    if (typeof node['id'] !== 'number' || typeof callFrame !== 'object' || callFrame === null) {
      throw new Error('Not a .cpuprofile: node without numeric id and callFrame.');
    }

    const children = Array.isArray(node['children'])
      ? node['children'].filter((child): child is number => typeof child === 'number')
      : [];

    return {
      id: node['id'],
      callFrame: {
        functionName: typeof callFrame['functionName'] === 'string' ? callFrame['functionName'] : '',
        scriptId: String(callFrame['scriptId'] ?? ''),
        url: typeof callFrame['url'] === 'string' ? callFrame['url'] : ''
      },
      children
    };
  });

  return {
    nodes,
    startTime: raw['startTime'],
    endTime: raw['endTime'],
    samples: (raw['samples'] as number[] | undefined)?.filter((sample) => typeof sample === 'number'),
    timeDeltas: (raw['timeDeltas'] as number[] | undefined)?.filter((delta) => typeof delta === 'number')
  };
}

export function importCpuProfile(text: string, filename?: string): ProfileRun {

  const profile = parseCpuProfile(text);
  return convertCdpProfile(profile, {
    targetUrl: filename,
    startedAt: profile.startTime / 1000,
    endedAt: profile.endTime / 1000
  });
}
