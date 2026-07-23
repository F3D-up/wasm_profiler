import type { CallTreeNode, ProfileRun, SymbolQuality } from './profile';

export interface CallTreeRow {
  node: CallTreeNode;
  depth: number;
  hasChildren: boolean;
  recursive: boolean;
}

function sortedByTotal(ids: number[], nodes: ProfileRun['nodes']): number[] {
  return [...ids].sort((a, b) => (nodes[b]?.totalMs ?? 0) - (nodes[a]?.totalMs ?? 0));
}

function leavesFirst(ids: number[], nodes: ProfileRun['nodes']): number[] {

  return [...ids].sort((a, b) => {
    const al = (nodes[a]?.children.length ?? 0) === 0 ? 0 : 1;
    const bl = (nodes[b]?.children.length ?? 0) === 0 ? 0 : 1;
    if (al !== bl) return al - bl;
    return (nodes[b]?.totalMs ?? 0) - (nodes[a]?.totalMs ?? 0);
  });

}

export function flattenCallTree(run: ProfileRun, collapsed: ReadonlySet<number>): CallTreeRow[] {
  const rows: CallTreeRow[] = [];
  const visit = (id: number, depth: number, ancestors: string[]): void => {

    const node = run.nodes[id];
    if (!node) return;

    rows.push({
      node,
      depth,
      hasChildren: node.children.length > 0,
      recursive: ancestors.includes(node.label)
    });

    if (!collapsed.has(id)) {

      const childAncestors = [...ancestors, node.label];
      for (const child of leavesFirst(node.children, run.nodes)) {
        visit(child, depth + 1, childAncestors);
      }
    }
  };

  for (const root of sortedByTotal(run.roots, run.nodes)) visit(root, 0, []);
  return rows;
}

export interface FunctionRow {
  label: string;
  moduleId?: string;
  funcIndex?: number;
  quality: SymbolQuality;
  totalMs: number;
  selfMs: number;
  samples: number;
  selfSamples: number;
  calls: number;
  nodeCount: number;
}

export function aggregateFunctions(run: ProfileRun): FunctionRow[] {
  const byLabel = new Map<string, FunctionRow>();
  const visit = (id: number, ancestors: string[]): void => {

    const node = run.nodes[id];
    if (!node) return;
    let row = byLabel.get(node.label);

    if (!row) {
      row = {
        label: node.label,
        moduleId: node.moduleId,
        funcIndex: node.funcIndex,
        quality: node.quality,
        totalMs: 0,
        selfMs: 0,
        samples: 0,
        selfSamples: 0,
        calls: 0,
        nodeCount: 0
      };
      byLabel.set(node.label, row);
    }

    if (row.funcIndex !== undefined && row.funcIndex !== node.funcIndex) {
      row.funcIndex = undefined;
    }

    const topMost = !ancestors.includes(node.label);
    if (topMost) {
      row.totalMs += node.totalMs;
      row.samples += node.samples ?? 0;
    }

    row.selfMs += node.selfMs;
    row.selfSamples += node.selfSamples ?? 0;
    row.calls += node.calls ?? 0;
    row.nodeCount += 1;

    const childAncestors = [...ancestors, node.label];
    for (const child of node.children) visit(child, childAncestors);
  };

  for (const root of run.roots) visit(root, []);

  return [...byLabel.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function totalProfileMs(run: ProfileRun): number {
  return run.roots.reduce((sum, id) => sum + (run.nodes[id]?.totalMs ?? 0), 0);
}
