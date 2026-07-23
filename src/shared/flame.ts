import type { ResolveFunc } from './artifacts';
import { totalProfileMs } from './callTree';
import type { ProfileRun, SymbolQuality } from './profile';

export interface FlameFrame {
  name: string;
  value: number;
  children: FlameFrame[];
  selfMs: number;
  quality?: SymbolQuality;
  source?: string;
  funcIndex?: number;
  inferredFuncIdx?: boolean;
  inferredSource?: boolean;
  samples?: number;
  calls?: number;
  root?: boolean;
}

export function buildFlameGraph(run: ProfileRun, resolve?: ResolveFunc): FlameFrame {

  const build = (id: number): FlameFrame | undefined => {

    const node = run.nodes[id];
    if (!node) return undefined;

    const r = resolve?.(node);

    const source =
      r?.source !== undefined
        ? r.source + (r.line !== undefined ? `:${r.line}` : '')
        : node.source;

    const children = node.children
      .map(build)
      .filter((c): c is FlameFrame => c !== undefined)
      .sort((a, b) => b.value - a.value);

    return {
      name: r?.name ?? node.label,
      value: node.totalMs,
      children,
      selfMs: node.selfMs,
      quality: r?.quality ?? node.quality,
      source,
      funcIndex: r?.funcIndex ?? node.funcIndex,
      inferredFuncIdx: r?.inferredFuncIdx,
      inferredSource: r?.inferredSource,
      samples: node.samples,
      calls: node.calls
    };
  };

  const roots = run.roots
    .map(build)
    .filter((c): c is FlameFrame => c !== undefined)
    .sort((a, b) => b.value - a.value);

  return {
    name: 'all WASM',
    value: totalProfileMs(run),
    children: roots,
    selfMs: 0,
    root: true
  };
}
