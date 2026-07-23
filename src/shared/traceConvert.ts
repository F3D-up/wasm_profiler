import type { CallTreeNode, CapturedModule, ProfileRun } from './profile';

export interface TraceSnapshot {
  modules: TraceModuleMeta[];
  nodes: Record<number, TraceNode>;
  roots: number[];
  eventCount: number;
  unbalancedEvents: number;
}
export interface TraceModuleMeta {
  id: string;
  hash: string;
  url?: string;
  functionCount: number;
  funcNames: string[];
}


export interface TraceNode {
  id: number;
  parentId: number | null;
  children: number[];
  moduleId: string;
  funcIndex: number;
  calls: number;
  totalMs: number;
  selfMs: number;
}

interface OpenFrame {
  nodeId: number;
  funcIndex: number;
  start: number;
  childMs: number;
}
export class TraceAggregator {
  private modules = new Map<string, TraceModuleMeta>();
  // record ker se nodes prenese izven konteksta kjer je nastal
  private nodes: Record<number, TraceNode> = {};
  private roots: number[] = [];
  private childIndex = new Map<string, number>();
  private stack: OpenFrame[] = [];
  private nextId = 1;
  private eventCount = 0;
  private unbalancedEvents = 0;
  private lastAt = 0;

  addModule(metadata: TraceModuleMeta): void {this.modules.set(metadata.id, metadata);}

  enter(moduleId: string, funcIndex: number, at: number): void {
    this.eventCount++;
    this.lastAt = at;

    let parentId: number | null = null;
    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1]!;
      parentId = parent.nodeId;
    }
    const key = `${parentId ?? 0}|${moduleId}|${funcIndex}`;

    //poglej ce node ze obstaja, ce ne ga dodaj
    let nodeId = this.childIndex.get(key);
    if (nodeId === undefined) {

      nodeId = this.nextId++;
      this.nodes[nodeId] = {
        id: nodeId,
        parentId,
        children: [],
        moduleId,
        funcIndex,
        calls: 0,
        totalMs: 0,
        selfMs: 0
      };

      this.childIndex.set(key, nodeId);

      if (parentId === null) this.roots.push(nodeId);
      else this.nodes[parentId]!.children.push(nodeId);
    }

    this.nodes[nodeId]!.calls++;
    this.stack.push({ nodeId, funcIndex, start: at, childMs: 0 });
  }

  exit(funcIndex: number, at: number): void {
    this.eventCount++;
    this.lastAt = at;

    //ce se slucajno zgodi exit na funkciji ki je ne poznamo
    if (!this.stack.some((f) => f.funcIndex === funcIndex)) {
      this.unbalancedEvents++;
      return;
    }

    while (true) {
      const frame = this.stack[this.stack.length - 1]!;
      this.closeTop(at);

      if (frame.funcIndex === funcIndex) return;
      else this.unbalancedEvents++;
    }
  }

  private closeTop(at: number): void {
    const frame = this.stack.pop()!;
    const duration = at - frame.start;
    const node = this.nodes[frame.nodeId]!;

    node.totalMs += duration;
    node.selfMs += duration - frame.childMs;

    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1]!;
      parent.childMs += duration;
    }
  }

  snapshot(): TraceSnapshot {

    while (this.stack.length > 0) {
      this.closeTop(this.lastAt);
      this.unbalancedEvents++;
    }

    return {
      modules: [...this.modules.values()],
      nodes: this.nodes,
      roots: this.roots,
      eventCount: this.eventCount,
      unbalancedEvents: this.unbalancedEvents
    };
  }
}



//funkcija za service worker-ja (bacjground.js)
export interface AssembleOptions {
  targetUrl?: string;
  startedAt: number;
  endedAt: number;
  traceIssues?: string[];
}

export function assembleTraceRun(snapshot: TraceSnapshot, opts: AssembleOptions): ProfileRun {
  const modules: Record<string, CapturedModule> = {};
  for (const meta of snapshot.modules) {
    modules[meta.id] = {
      id: meta.id,
      hash: meta.hash,
      url: meta.url,
      functionCount: meta.functionCount,
      funcNames: meta.funcNames,
      symbolQuality: meta.funcNames.some((n) => n !== '') ? 'name' : 'stripped'
    };
  }

  const names = new Map(snapshot.modules.map((m) => [m.id, m.funcNames]));
  const nodes: Record<number, CallTreeNode> = {};
  for (const node of Object.values(snapshot.nodes)) {
    const name = names.get(node.moduleId)?.[node.funcIndex] || '';
    nodes[node.id] = {
      id: node.id,
      parentId: node.parentId,
      children: node.children,
      label: name || `wasm-function[${node.funcIndex}]`,
      moduleId: node.moduleId,
      funcIndex: node.funcIndex,
      source: modules[node.moduleId]?.url,
      quality: name ? 'name' : 'fallback',
      calls: node.calls,
      totalMs: node.totalMs,
      selfMs: node.selfMs
    };
  }

  return {
    version: 3,
    mode: 'tracing',
    targetUrl: opts.targetUrl,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    modules,
    roots: snapshot.roots,
    nodes,
    eventCount: snapshot.eventCount,
    unbalancedEvents: snapshot.unbalancedEvents > 0 ? snapshot.unbalancedEvents : undefined,
    traceIssues: opts.traceIssues && opts.traceIssues.length > 0 ? opts.traceIssues : undefined
  };
}
