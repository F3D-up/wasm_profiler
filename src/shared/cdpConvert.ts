import { INSTRUMENTED_PAGE_NOTICE, ORIG_SUFFIX } from './instrumentNames';
import type { WasmModuleMeta } from './moduleMeta';
import type { CallTreeNode, CapturedModule, ProfileRun, SymbolQuality } from './profile';

//cdp pomeni Chrome Dev tools Protocol
//
//kako cdp predstavi funkcijo
export interface CdpCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
}

//node v call drevesu
export interface CdpProfileNode {
  id: number;
  callFrame: CdpCallFrame;
  children?: number[];
}

//profiler run
export interface CdpProfile {
  nodes: CdpProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface ConvertOptions {
  targetUrl?: string;
  startedAt: number;
  endedAt: number;
  sampleIntervalMicroS?: number;
  wasmModules?: Map<string, WasmModuleMeta>;
}

const WASM_FUNCTION_RE = /wasm-function\[(\d+)\]/;

//V8 ovojnice na meji med JS in wasm nosijo url modula, a niso funkcije modula
const V8_WRAPPER_RE = /^(js-to-wasm|wasm-to-js)[:.]/;


export function isWasmFrame(frame: CdpCallFrame): boolean {

  if (V8_WRAPPER_RE.test(frame.functionName)) return false;

  return (
    WASM_FUNCTION_RE.test(frame.functionName) ||
    WASM_FUNCTION_RE.test(frame.url) ||
    frame.url.startsWith('wasm:') ||
    /\.wasm(\?|$)/.test(frame.url)

  );
}


//rekonstrukcija call tree-ja iz call stacka s pomocjo linkov
export function convertCdpProfile(profile: CdpProfile, opts: ConvertOptions): ProfileRun {

  const mapByID = new Map<number, CdpProfileNode>();
  const mapChildParent = new Map<number, number>();

  for (const node of profile.nodes) {

    mapByID.set(node.id, node);

    for (const child of node.children ?? []) mapChildParent.set(child, node.id);
  }

  const modules: Record<string, CapturedModule> = {};
  const nodes: Record<number, CallTreeNode> = {};
  const roots: number[] = [];

  const childIndex = new Map<string, number>();
  let nextNodeId = 1;

  //lambda ki ustvari id modula
  // in ga inicializira ce se ne obstaja
  const moduleIdFor = (frame: CdpCallFrame): string => {

    const id = frame.url || `script:${frame.scriptId}`;
    const meta = opts.wasmModules?.get(frame.url);

    modules[id] ??= {
      id,
      hash: meta?.hash ?? '',
      url: frame.url || undefined,
      functionCount: meta?.functionCount ?? 0,
      funcNames: meta?.funcNames ?? [],
      symbolQuality: meta?.funcNames.some((name) => name !== '') ? 'name' : 'stripped'
    };

    return id;
  };

  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];

  for (let i = 0; i < samples.length; i++) {

    const deltaMs = Math.max(0, timeDeltas[i] ?? 0) / 1000;
    const sampledNode = mapByID.get(samples[i]!);

    //kriticna linija, saj le ta zavrze vse sample ki so js runtime
    if (!sampledNode || !isWasmFrame(sampledNode.callFrame)) continue;



    const path: CdpProfileNode[] = [];
    let current: CdpProfileNode | undefined = sampledNode;

    while (current) {
      if (isWasmFrame(current.callFrame)) path.push(current);

      const parentId = mapChildParent.get(current.id);
      current = parentId === undefined ? undefined : mapByID.get(parentId);
    }

    path.reverse();



    let parentId: number | null = null;

    for (let depth = 0; depth < path.length; depth++) {

      const frame = path[depth]!.callFrame;
      const key = `${parentId ?? 0}|${frame.scriptId}|${frame.functionName}|${frame.url}`;
      let nodeId = childIndex.get(key);

      if (nodeId === undefined) {

        nodeId = nextNodeId++;

        //indexMatch s pomocjo regexa proba izluscit function index
        const indexMatch =
          frame.functionName.match(WASM_FUNCTION_RE) ?? frame.url.match(WASM_FUNCTION_RE);

        //preveri ali je chrome vrnil ime al samo placeholder kot recimo wasm-function[2]
        const named = frame.functionName !== '' && !WASM_FUNCTION_RE.test(frame.functionName);

        //iz wasm-fucntion[7] vzame "7" in jo pretvori v stevilko
        const funcIndex = indexMatch ? Number(indexMatch[1]) : undefined;
        const moduleId = moduleIdFor(frame);

        //ime iz name sectiona modula prevlada nad placeholderjem
        const nameFromModule = (funcIndex !== undefined ? modules[moduleId]?.funcNames[funcIndex] : undefined) || undefined;
        const quality: SymbolQuality = (nameFromModule !== undefined || named) ? 'name' : 'fallback';

        nodes[nodeId] = {
          id: nodeId,
          parentId,
          children: [],
          label: nameFromModule ?? (frame.functionName || (indexMatch ? `wasm-function[${indexMatch[1]}]` : '(wasm)')),
          moduleId,
          funcIndex,
          source: frame.url || undefined,
          quality,
          samples: 0,
          selfSamples: 0,
          totalMs: 0,
          selfMs: 0
        };

        childIndex.set(key, nodeId);

        if (parentId === null) roots.push(nodeId);
        else nodes[parentId]!.children.push(nodeId);
      }

      const node = nodes[nodeId]!;
      node.totalMs += deltaMs;
      node.samples! += 1;

      // ce je leaf/zadnja funkcija na call stacku
      if (depth === path.length - 1) {
        node.selfMs += deltaMs;
        node.selfSamples! += 1;
      }

       parentId = nodeId;
    }
  }

  const instrumented = Object.values(nodes).some((node) => node.label.includes(ORIG_SUFFIX));

  return {
    version: 3,
    mode: 'sampling',
    targetUrl: opts.targetUrl,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    modules,
    roots,
    nodes,
    sampleIntervalMicroS: opts.sampleIntervalMicroS,
    sampleCount: samples.length,
    traceIssues: instrumented ? [INSTRUMENTED_PAGE_NOTICE] : undefined
  };
}
