import { sha256Hex } from './hash';
import {
  QUALITY_RANK,
  type ArtifactSymbols,
  type CallTreeNode,
  type CapturedModule,
  type FunctionSymbol,
  type SymbolQuality
} from './profile';
import { isWasmBytes, parseWasmSymbols } from './wasmSymbols';

//vrne samo file iz url
export function basename(path: string | undefined): string | undefined {

  if (!path) return undefined;
  return path.split(/[?#]/)[0]!.split('/').pop() || undefined;
}

//normalizira npr. foo.wasm, foo_bg.wasm, foo.debug.wasm, foo-dev.wasm -> "foo"
//  pripone se lahko nizajo (foo.wasm.map, foo_bg_opt.wasm) zato zanka
export function normalizedName(name: string): string {

  let s = (basename(name) ?? name).toLowerCase();
  let prev = '';

  while (s !== prev) {
    prev = s;
    s = s.replace(/\.(wasm|json|map)$/, '');
    s = s.replace(/[-_.](bg|dbg|debug|dev|opt|prod|release|stripped|symbols|sym)$/, '');
  }

  return s;
}

export function relatedNames(a: string, b: string): boolean {

  const stringA = normalizedName(a);
  const stringB = normalizedName(b);

  return stringA !== '' && stringA === stringB;
}




export async function parseArtifact(bytes: Uint8Array, filename: string): Promise<ArtifactSymbols> {

  const hash = await sha256Hex(bytes);

  if (isWasmBytes(bytes)) {

    const info = parseWasmSymbols(bytes);
    const symbols: Record<number, FunctionSymbol> = {};

    for (const [index, symbol] of info.symbols) symbols[index] = symbol;

    return {
      hash,
      filename,
      uploadName: filename,
      aliases: [filename, normalizedName(filename)],
      functionCount: info.importedFunctionCount + info.definedFunctionCount,
      symbolQuality: (info.hasNameSection ? 'name' : (info.exportedFunctionCount > 0 ? 'export-import' : 'stripped')),
      symbols,
      sources: [],
      createdAt: Date.now()
    };
  } else {

    return parseSymbolMapJson(bytes, filename, hash);
  }

}

function asQuality(value: unknown): SymbolQuality | undefined {
  return typeof value === 'string' && Object.hasOwn(QUALITY_RANK, value)
    ? (value as SymbolQuality)
    : undefined;
}

//symbol-map JSON ki ga ustvari tool container
function parseSymbolMapJson(bytes: Uint8Array, filename: string, uploadHash: string): ArtifactSymbols {

  let parsed;

  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));

  } catch {

    throw new Error(`${filename}: neither a wasm binary nor valid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${filename}: missing "symbols" object`);
  }

  const parsedObj = parsed as Record<string, unknown>;

  if (typeof parsedObj['symbols'] !== 'object' || parsedObj['symbols'] === null) {
    throw new Error(`${filename}: missing "symbols" object`);
  }

  //fallback nastavimo pred preverjanjem: manjkajoc symbolQuality je dovoljen, napacen ne
  const symbolQuality = asQuality(parsedObj['symbolQuality'] ?? 'debug');
  if (symbolQuality === undefined) {
    throw new Error(`${filename}: invalid symbolQuality ${JSON.stringify(parsedObj['symbolQuality'])}`);
  }

  const symbols: Record<number, FunctionSymbol> = {};

  for (const [key, value] of Object.entries(parsedObj['symbols'] as Record<string, unknown>)) {

    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;

    const entry = value as Record<string, unknown>;
    if (typeof entry?.['name'] !== 'string') continue;

    //napacno quality polje zavrze samo simbol ne celega artifacta
    const quality = asQuality(entry['quality'] ?? symbolQuality);
    if (quality === undefined) continue;

    symbols[index] = {
      name: entry['name'],
      mangled: (typeof entry['mangled'] === 'string') ? entry['mangled'] : undefined,
      source: (typeof entry['source'] === 'string') ? entry['source'] : undefined,
      line: (typeof entry['line'] === 'number') ? entry['line'] : undefined,
      quality
    };
  }

  const mapFilename = (typeof parsedObj['filename'] === 'string') ? parsedObj['filename'] : filename;

  return {
    hash: (typeof parsedObj['hash'] === 'string') ? parsedObj['hash'] : uploadHash,
    filename: mapFilename,
    uploadName: filename,
    aliases: [filename, mapFilename, normalizedName(mapFilename)],
    functionCount: (typeof parsedObj['functionCount'] === 'number') ? parsedObj['functionCount'] : undefined,
    symbolQuality,
    symbols,
    sources: Array.isArray(parsedObj['sources']) ? (parsedObj['sources'] as string[]) : [],
    createdAt: Date.now()
  };
}



export function artifactMatchesModule(artifact: ArtifactSymbols, module: CapturedModule): boolean {

  if (module.hash !== '' && artifact.hash === module.hash) return true;

  const urlBase = basename(module.url);

  if (urlBase !== undefined) {

    if (artifact.filename === urlBase) return true;
    if (relatedNames(artifact.filename, urlBase)) return true;
  }

  const aliases = artifact.aliases ?? [];

  return aliases.some(
    (a) => a === module.id || a === module.url || (urlBase !== undefined && relatedNames(a, urlBase))
  );
}

export function isRuntimeCompatible(artifact: ArtifactSymbols, module: CapturedModule): boolean {

  return module.hash !== '' && artifact.hash === module.hash;
}




export interface ResolvedFrame {
  name: string;
  source?: string;
  line?: number;
  quality: SymbolQuality;
  funcIndex?: number;
  inferredFuncIdx?: boolean;
  inferredSource?: boolean;
}

//osnova okvirja brez meritev samo kar resolver potrebuje
export type ResolvableFrame = Pick<
  CallTreeNode,
  'label' | 'funcIndex' | 'quality' | 'source' | 'moduleId'
>;

//kot interface le za funkcije
// pravi funkcije ki vzamejo kot vhod le izbrane atribute CallTreeNode vmesnika in vrnejo ResolvedFrame
export type ResolveFunc = (frame: ResolvableFrame) => ResolvedFrame;

interface SymbolWContext {
  artifact: ArtifactSymbols;
  index: number;
  symbol: FunctionSymbol;
}

function findByIndex(pool: ArtifactSymbols[], index: number): SymbolWContext | undefined {

  for (const artifact of pool) {
    const symbol = artifact.symbols[index];
    if (symbol) return { artifact, index, symbol };
  }

  return undefined;
}

function findByName(pool: ArtifactSymbols[], name: string): SymbolWContext | undefined {

  for (const artifact of pool) {
    for (const [key, symbol] of Object.entries(artifact.symbols)) {

      if (symbol.name === name || symbol.mangled === name) return { artifact, index: Number(key), symbol };
    }
  }

  return undefined;
}

//ime ni enolicno, ce ga v artefaktu nosi vec kot en indeks
function nameIsAmbiguous(artifact: ArtifactSymbols, name: string): boolean {

  let count = 0;

  for (const symbol of Object.values(artifact.symbols)) {
    if ((symbol.name === name || symbol.mangled === name) && ++count > 1) return true;
  }

  return false;
}

//kako smo prisli do zadetka
//  ne kaksne kvalitete jesam simbol
type Provenance = 'exact' | 'related' | 'coincidental';

interface DebugHit {
  hit: SymbolWContext;
  via: Provenance;
}

function findDebugHit(
  artifacts: ArtifactSymbols[],
  module: CapturedModule | undefined,
  runtimeHit: SymbolWContext | undefined,
  funcIndex: number | undefined,
  searchName: string
): DebugHit | undefined {

  const debugPool = artifacts.filter((a) => a.symbolQuality === 'debug');

  //enaka binarna datoteka kot runtime
  const sameBinary = debugPool.filter(
    (a) =>
      (runtimeHit !== undefined && a.hash !== '' && a.hash === runtimeHit.artifact.hash) ||
      (module !== undefined && isRuntimeCompatible(a, module))
  );

  const sameBinarySymbol = funcIndex !== undefined ? findByIndex(sameBinary, funcIndex) : undefined;
  if (sameBinarySymbol) return { hit: sameBinarySymbol, via: 'exact' };

  //artifakti ki se prilegajo glede na modul ali ime
  const preferredDebug = debugPool.filter(
    (a) =>
      (runtimeHit && relatedNames(a.filename, runtimeHit.artifact.filename)) ||
      (module !== undefined && artifactMatchesModule(a, module))
  );

  const relatedArtifactSymbol = findByName(preferredDebug, searchName);
  if (relatedArtifactSymbol) return { hit: relatedArtifactSymbol, via: 'related' };

  //edini dokaz je ujemanje imena, ki se lahko ujema z funkcijo cisto napacnega artifakta
  const unverifiedArtifactSymbol = preferredDebug.length === 0 ? findByName(debugPool, searchName) : undefined;
  if (unverifiedArtifactSymbol) return { hit: unverifiedArtifactSymbol, via: 'coincidental' };

  return undefined;
}

export function resolveFrame(frame: ResolvableFrame, module: CapturedModule | undefined, artifacts: ArtifactSymbols[]): ResolvedFrame {

  const base: ResolvedFrame = {
    name: frame.label,
    source: frame.source,
    quality: frame.quality,
    funcIndex: frame.funcIndex
  };

  if (artifacts.length === 0) return base;

  //vzamemo le tiste artifacte ki so navezujejo na profilirano kodo
  const strict = module ? artifacts.filter((a) => isRuntimeCompatible(a, module)) : [];
  const runtimeTrusted = strict.length > 0;
  const runtimePool = runtimeTrusted ? strict : (artifacts.filter((a) => a.symbolQuality !== 'debug'));

  const runtimeHit = (runtimeTrusted && frame.funcIndex !== undefined) ? findByIndex(runtimePool, frame.funcIndex) : findByName(runtimePool, frame.label);
  const funcIndex = frame.funcIndex ?? runtimeHit?.index;

  //indeks, izlusen po imenu iz runtime-zdruzljivega artefakta, je verodostojen,
  //razen ce isto ime v tem artefaktu nosi vec funkcij
  const indexAuthoritative =
    frame.funcIndex !== undefined ||
    (module !== undefined && runtimeHit !== undefined &&
      isRuntimeCompatible(runtimeHit.artifact, module) && !nameIsAmbiguous(runtimeHit.artifact, frame.label));

  const searchName = runtimeHit?.symbol.name ?? frame.label;
  const debugHit = findDebugHit(artifacts, module, runtimeHit, funcIndex, searchName);

  if (!runtimeHit && !debugHit) return base;

  //nakljucnemu debug zadetku zaupamo le ce runtime nima odgovora
  const trusted =
      debugHit !== undefined && (debugHit.via !== 'coincidental' || runtimeHit === undefined)
      ? debugHit
      : undefined;

  const winner = trusted?.hit ?? runtimeHit;

  //izvorno mesto je preverjeno le, kadar je artefakt z izvorom runtime-združljiv z modulom
  const sourceVerified =
    module !== undefined && trusted !== undefined && isRuntimeCompatible(trusted.hit.artifact, module);

  return {
    name: winner?.symbol.name ?? frame.label,
    source: trusted?.hit.symbol.source ?? frame.source,
    line: trusted?.hit.symbol.line,
    quality: winner?.symbol.quality ?? frame.quality,
    funcIndex,
    inferredFuncIdx: funcIndex !== undefined && !indexAuthoritative ? true : undefined,
    inferredSource: trusted?.hit.symbol.source !== undefined && !sourceVerified ? true : undefined
  };
}

const REGISTRY_KEY = 'artifactRegistry';

interface ArtifactRegistry {
  artifacts: Record<string, ArtifactSymbols>;
}

export async function loadArtifacts(): Promise<ArtifactSymbols[]> {

  const items = await chrome.storage.local.get(REGISTRY_KEY);
  const registry = items[REGISTRY_KEY] as ArtifactRegistry | undefined;

  return registry ? Object.values(registry.artifacts) : [];
}

// A symbol map deliberately carries the hash *and* declared filename of the
// binary it describes, so neither identifies an upload — the served .wasm and
// its map share both. What separates them is what each is allowed to grant.
export function artifactKey(artifact: ArtifactSymbols): string {
  return `${artifact.hash}|${artifact.symbolQuality}|${artifact.uploadName ?? artifact.filename}`;
}

export async function saveArtifact(artifact: ArtifactSymbols): Promise<void> {

  const items = await chrome.storage.local.get(REGISTRY_KEY);
  const registry = (items[REGISTRY_KEY] as ArtifactRegistry | undefined) ?? { artifacts: {} };

  registry.artifacts[artifactKey(artifact)] = artifact;

  try {
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });

  } catch (err) {

    if (/quota/i.test(String(err))) {
      throw new Error(
        `${artifact.filename} is too large for extension storage. Clear stored artifacts or upload a smaller symbol map.`
      );
    }

    throw err;
  }
}

export async function clearArtifacts(): Promise<void> {
  await chrome.storage.local.remove(REGISTRY_KEY);
}
