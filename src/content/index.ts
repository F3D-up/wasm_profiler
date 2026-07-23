import {
  EXT_TAG,
  PAGE_TAG,
  type BridgeToPage,
  type PageToBridge
} from '../shared/messages';

import { TraceAggregator, type TraceModuleMeta } from '../shared/traceConvert';


//shranimo originalne WASM entrypointe
const original = {
  instantiate: WebAssembly.instantiate.bind(WebAssembly),
  instantiateStreaming: WebAssembly.instantiateStreaming.bind(WebAssembly),
  compile: WebAssembly.compile.bind(WebAssembly),
  compileStreaming: WebAssembly.compileStreaming.bind(WebAssembly),
  Module: WebAssembly.Module,
  Instance: WebAssembly.Instance
};

const traceAggregator = new TraceAggregator();

//garbage-collected map drzi WASM Module dokler "nekdo" se drzi referenco nanj
const taggedModules = new WeakMap<WebAssembly.Module, string>();


//postMessage ne vrne odgovora
// tu hranimo resolve funkcije, da odgovor po requestId najde svojega klicatelja
const rewriteWaiters = new Map<number,
  { resolve: (resolveParam: { buffer: ArrayBuffer; meta: TraceModuleMeta } | null) => void }>();


let nextRequestId = 1;
let activeKnown: boolean | undefined;

//s tem preverimo ali je tracing vkljucen
let resolveActivation: ((active: boolean) => void) | undefined;

const activationPromise = new Promise<boolean>((resolve) => {
  resolveActivation = resolve;
  //ce bridge ne odgovori po 2s predvudevamo da tracing ni vkljucen
  setTimeout(() => resolve(false), 2000);
}).then((active) => {
  //upostevamo le prvi odgovor
  activeKnown = activeKnown ?? active;
  return activeKnown;
});

const post = (message: PageToBridge): void => {
  window.postMessage({ [PAGE_TAG]: message }, '*');
};

const reportIssue = (description: string): void => {
  if (activeKnown === true) post({ kind: 'issue', description });
};

window.addEventListener('message', (event: MessageEvent) => {

  if (event.source !== window) return;

  const message = (event.data as Record<string, unknown> | null)?.[EXT_TAG] as BridgeToPage | undefined;

  if (!message) return;

  switch (message.kind) {

    case 'active': {
      activeKnown = activeKnown ?? message.active;
      resolveActivation?.(message.active);
      break;
    }

    case 'rewritten': {
      rewriteWaiters.get(message.requestId)?.resolve({ buffer: message.buffer, meta: message.meta });
      rewriteWaiters.delete(message.requestId);
      break;
    }

    case 'rewrite-failed': {
      reportIssue(`instrumentation failed, module runs uninstrumented: ${message.error}`);
      rewriteWaiters.get(message.requestId)?.resolve(null);
      rewriteWaiters.delete(message.requestId);
      break;
    }

    case 'collect': {
      post({ kind: 'snapshot', requestId: message.requestId, snapshot: traceAggregator.snapshot() });
      break;
    }
  }
});

//vprasamo ce je tracing active
post({ kind: 'query-active' });


const toArrayBuffer = (source: BufferSource): ArrayBuffer => {

  if (source instanceof ArrayBuffer) return source.slice(0);

  const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return view.slice().buffer;
};

const rewriteBytes = (buffer: ArrayBuffer, url?: string): Promise<{ buffer: ArrayBuffer; meta: TraceModuleMeta } | null> => {

  const requestId = nextRequestId++;

  return new Promise((resolve) => {

    rewriteWaiters.set(requestId, { resolve });
    post({ kind: 'rewrite', requestId, url, buffer });

    //rewrite request waiterje zbrisemo ce se ne odzovejo
    setTimeout(() => {
      if (rewriteWaiters.has(requestId)) {
        rewriteWaiters.delete(requestId);
        reportIssue('instrumentation timed out, module runs uninstrumented');
        resolve(null);
      }
    }, 20000);
  });
};

function withHooks(imports: WebAssembly.Imports | undefined, moduleId: string): WebAssembly.Imports {

  const hooks: WebAssembly.ModuleImports = {
    enter(index: number): void {
      traceAggregator.enter(moduleId, index, performance.now());
    },
    exit(index: number): void {
      traceAggregator.exit(index, performance.now());
    }
  };

  return { ...imports, __profiler: hooks };
}

const prepareBytes = async (source: BufferSource, url?: string): Promise<{ bytes: BufferSource; moduleId?: string }> => {

  if (!(await activationPromise)) return { bytes: source };

  const rewritten = await rewriteBytes(toArrayBuffer(source), url);
  if (!rewritten) return { bytes: source };

  traceAggregator.addModule(rewritten.meta);
  return { bytes: rewritten.buffer, moduleId: rewritten.meta.id };
};

//izlusci binarno datoteko iz network responsa
const resolveResponse = async (source: Response | PromiseLike<Response>): Promise<{ bytes: ArrayBuffer; url?: string }> => {

  const response = await source;
  return { bytes: await response.arrayBuffer(), url: response.url || undefined };
};

//prepisemo WASM instantiate z nasim
// ce instantiate prejme nepreveden vhod ga bo implicitno tudi prevedel
WebAssembly.instantiate = async function patchedInstantiate(source: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) {

  //preverimo ce je "source" ze preveden
  if (source instanceof original.Module) {
    //preveden
    const moduleId = taggedModules.get(source);

    if (moduleId !== undefined) return original.instantiate(source, withHooks(imports, moduleId));
    if (activeKnown === true) {
      reportIssue(
        'a precompiled WebAssembly.Module (cache or postMessage) was instantiated without instrumentation'
      );
    }

    return original.instantiate(source, imports);
  } else {
    //ni preveden
    const { bytes, moduleId } = await prepareBytes(source);
    const result = (await original.instantiate(
      bytes,
      moduleId !== undefined ? withHooks(imports, moduleId) : imports
    )) as WebAssembly.WebAssemblyInstantiatedSource;

    if (moduleId !== undefined) taggedModules.set(result.module, moduleId);

    return result;
  }

} as typeof WebAssembly.instantiate;

//prepismo WASM compile z nasim
WebAssembly.compile = async function patchedCompile(source: BufferSource) {

  const { bytes, moduleId } = await prepareBytes(source);
  const module = await original.compile(bytes);

  if (moduleId !== undefined) taggedModules.set(module, moduleId);

  return module;
};

//steaming verzija compile(), ki namesto bajtov sprejme Response
WebAssembly.compileStreaming = async function patchedCompileStreaming(source: Response | PromiseLike<Response>) {

  const { bytes, url } = await resolveResponse(source);
  const prepared = await prepareBytes(bytes, url);
  const module = await original.compile(prepared.bytes);

  if (prepared.moduleId !== undefined) taggedModules.set(module, prepared.moduleId);

  return module;
};

//steaming verzija instantiate(), ki namesto bajtov sprejme Response
// le da ta streaming instantiate() nikoli ne bo sprejme ze prevedenih modulov
WebAssembly.instantiateStreaming = async function patchedInstantiateStreaming(source: Response | PromiseLike<Response>, imports?: WebAssembly.Imports) {

  const { bytes, url } = await resolveResponse(source);
  const prepared = await prepareBytes(bytes, url);
  const result = (await original.instantiate(
    prepared.bytes,
    prepared.moduleId !== undefined ? withHooks(imports, prepared.moduleId) : imports
  )) as WebAssembly.WebAssemblyInstantiatedSource;

  if (prepared.moduleId !== undefined) taggedModules.set(result.module, prepared.moduleId);

  return result;
};

//sprozi se ce stran poklice new WebAssembly.Module(bytes) namesto compile()
// sinhroni konstruktor ne more cakati na nas async rewrite, zato javimo le opozorilo
WebAssembly.Module = new Proxy(original.Module, {

  construct(target, args, newTarget) {

    reportIssue(
      'new WebAssembly.Module (synchronous path) was used; that module is not instrumented'
    );

    return Reflect.construct(target, args, newTarget);
  }
});

//sprozi se ce stran poklice new WebAssembly.Instance(module, imports)
// ce je modul ze bil prepisan (tagged) mu podtaknemo enter/exit hooke, sicer javimo opozorilo
WebAssembly.Instance = new Proxy(original.Instance, {

  construct(target, args, newTarget) {

    const [module, imports] = args as [WebAssembly.Module, WebAssembly.Imports?];
    const moduleId = taggedModules.get(module);

    if (moduleId !== undefined) {
      return Reflect.construct(target, [module, withHooks(imports, moduleId)], newTarget);
    }

    reportIssue(
      'new WebAssembly.Instance (synchronous path) was used; that module is not instrumented'
    );

    return Reflect.construct(target, args, newTarget);
  }
});
