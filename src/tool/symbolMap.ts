import type { CodeRange } from '../shared/wasmSymbols';
import type { LineEntry, Subprogram } from './dwarfdump';

export interface SymbolMapJson {
  filename: string;
  hash: string;
  functionCount: number;
  symbolQuality: 'debug';
  symbols: Record<string, { name: string; mangled?: string; source?: string; line?: number }>;
  sources: string[];
}

export interface JoinDiagnostics {
  convention: 'code-section-relative' | 'file-relative';
  matched: number;
  unmatched: string[];
  collisions: number;
  lineFallbacks: number;
  runtimeMatched?: number;
  runtimeUnmatched?: string[];
  ambiguous?: string[];
}

export interface RuntimeInput {
  filename: string;
  hash: string;
  importedFunctionCount: number;
  definedFunctionCount: number;
  names: Map<number, string>;
}

export interface JoinInput {
  filename: string;
  hash: string;
  importedFunctionCount: number;
  definedFunctionCount: number;
  codeSectionOffset: number;
  codeRanges: CodeRange[];
  subprograms: Subprogram[];
  lineEntries: LineEntry[];
  runtimeInput?: RuntimeInput;
  demangledNames?: Map<string, string>;
}

type RuntimeDiagnostics = Pick<JoinDiagnostics, 'runtimeMatched' | 'runtimeUnmatched' | 'ambiguous'>;

interface DebugEntry {
  key: string;
  name: string;
  mangled?: string;
  source?: string;
  line?: number;
}

export function buildSymbolMap(input: JoinInput): {map: SymbolMapJson; diagnostics: JoinDiagnostics;} {

  const codeRanges = input.codeRanges;
  const codeSectionOffset = input.codeSectionOffset;

  //najde code range ki vsebuje offset
  const codeRangeAt = (fileOffset: number): CodeRange | undefined => {

    if (codeRanges.length === 0 || fileOffset < codeSectionOffset) return undefined;

    let low = 0;
    let high = codeRanges.length - 1;
    let found = -1;

    while (low <= high) {

      //celostevilsko deljenje z 2
      const mid = (low + high) >> 1;


      if (fileOffset < codeRanges[mid]!.bodyEnd) {
        found = mid;
        high = mid - 1;

      } else {
        low = mid + 1;
      }
    }

    return found >= 0 ? codeRanges[found] : undefined;
  };

  //oceni koliko subprogram-ov je znotraj coderanga ce zmaknemo naslov za "delta"
  const score = (delta: number): number =>
    input.subprograms.filter((s) => codeRangeAt(s.lowPc + delta) !== undefined).length;

  //ne vemo ali so naslovi subprogram-ov glede na zacetek fila ali glede na zacetek odseka kode
  const fileRelScore = score(0);
  const codeRelScore = score(codeSectionOffset);

  if (input.subprograms.length > 0 && codeRelScore === 0 && fileRelScore === 0) {
    throw new Error(
      'no DWARF subprogram lands inside any function body under either address convention (code-section-relative or file-relative)'
    );
  }

  const offsetDelta = codeRelScore >= fileRelScore ? codeSectionOffset : 0;
  const convention = (offsetDelta === 0 && codeSectionOffset !== 0) ? 'file-relative' : 'code-section-relative';

  const sortedEntries = [...input.lineEntries].sort((a, b) => a.address - b.address);

  //najde prvi lineEntry katerega adress se zacne na/po zacetku funkcije ("range".bodyStart)
  const lineFor = (range: CodeRange): LineEntry | undefined => {

    const target = range.bodyStart - offsetDelta;
    let low = 0;
    let high = sortedEntries.length;

    while (low < high) {

      const mid = (low + high) >> 1;

      if (sortedEntries[mid]!.address < target) low = mid + 1;
      else high = mid;
    }

    const entry = sortedEntries[low];

    return entry && ((entry.address + offsetDelta) < range.bodyEnd) ? entry : undefined;
  };

  const entries = new Map<number, DebugEntry>();
  const unmatched: string[] = [];

  let collisions = 0;
  let lineFallbacks = 0;
  let matched = 0;

  for (const subprogram of input.subprograms) {

    const label = subprogram.linkageName ?? subprogram.name ?? `0x${subprogram.lowPc.toString(16)}`;
    const range = codeRangeAt(subprogram.lowPc + offsetDelta);

    if (!range) {
      unmatched.push(label);
      continue;
    }

    if (entries.has(range.funcIndex)) {
      collisions++;
      continue;
    }

    matched++;
    let source = subprogram.declFile;
    let line = subprogram.declLine;

    //ce subprogram nima "source" in "line" se zanesemo na Line Table
    if (source === undefined || line === undefined) {

      const fromLineTable = lineFor(range);
      if (fromLineTable) {
        lineFallbacks++;
        source ??= fromLineTable.file;
        line ??= fromLineTable.line;
      }
    }

    const demangledLinkageName = readableName(subprogram, input.demangledNames);
    const fallbackLabel = `func[${range.funcIndex}]`;

    //uporabimo demangled linkage name preden se zanesemo na subprogram.name, saj nam to omogoci join
    entries.set(range.funcIndex, {
      key: demangledLinkageName ?? subprogram.name ?? fallbackLabel,
      name: demangledLinkageName ?? subprogram.name ?? fallbackLabel,
      mangled: subprogram.linkageName,
      source,
      line
    });
  }



  const { symbols, runtimeDiagnostics } = input.runtimeInput ?
    projectOntoRuntime(entries, input.runtimeInput, input.demangledNames) :
    { symbols: emitDebugSpace(entries), runtimeDiagnostics: {} };

  const target = input.runtimeInput ?? input;
  return {
    map: {
      filename: target.filename,
      hash: target.hash,
      functionCount: target.importedFunctionCount + target.definedFunctionCount,
      symbolQuality: 'debug',
      symbols,
      sources: uniqueSources(symbols)
    },
    diagnostics: {
      convention,
      matched,
      unmatched,
      collisions,
      lineFallbacks,
      ...runtimeDiagnostics
    }
  };
}

function readableName(subprogram: Subprogram, demangled: Map<string, string> | undefined): string | undefined {

  if (subprogram.linkageName === undefined) return undefined;
  const demangledName = demangled?.get(subprogram.linkageName);

  return (demangledName !== undefined && demangledName !== subprogram.linkageName) ? demangledName : undefined;
}

//v primeru da runtimeInput manjka se predvideva da je runtimeInput == input (debug)
function emitDebugSpace(entries: Map<number, DebugEntry>): SymbolMapJson['symbols'] {

  const symbols: SymbolMapJson['symbols'] = {};

  for (const [funcIndex, entry] of entries) {

    const source = entry.source !== undefined ? { source: entry.source } : {}
    const line = entry.line !== undefined ? { line: entry.line } : {}
    const mangled = (entry.mangled !== undefined && entry.mangled !== entry.name) ? { mangled: entry.mangled } : {}

    symbols[String(funcIndex)] = {
      name: entry.name,
      ...mangled,
      ...source,
      ...line
    };
  }

  return symbols;
}

function projectOntoRuntime(
  entries: Map<number, DebugEntry>,
  runtime: RuntimeInput,
  demangled: Map<string, string> | undefined
): { symbols: SymbolMapJson['symbols']; runtimeDiagnostics: RuntimeDiagnostics } {

  const mapByKey = new Map<string, DebugEntry>();
  const ambiguous = new Set<string>();

  //klasifikacija dvoumnih entryjev
  for (const entry of entries.values()) {

    if (ambiguous.has(entry.key)) continue;

    if (mapByKey.has(entry.key)) {
      mapByKey.delete(entry.key);
      ambiguous.add(entry.key);
      continue;
    }

    mapByKey.set(entry.key, entry);
  }

  const symbols: SymbolMapJson['symbols'] = {};
  const runtimeUnmatched: string[] = [];
  let runtimeMatched = 0;

  const sortedNames = [...runtime.names].sort((a, b) => a[0] - b[0])

  for (const [funcIndex, raw] of sortedNames) {

    const key = demangled?.get(raw) ?? raw;
    const hit = mapByKey.get(key);

    if (hit) runtimeMatched++;
    else runtimeUnmatched.push(key);


    const source = hit?.source !== undefined ? { source: hit.source } : {}
    const line = hit?.line !== undefined ? { line: hit.line } : {}
    const mangled = raw !== key ? { mangled: raw } : {}

    symbols[String(funcIndex)] = {
      name: key,
      ...mangled,
      ...source,
      ...line
    };
  }
  return { symbols, runtimeDiagnostics: { runtimeMatched, runtimeUnmatched, ambiguous: [...ambiguous] } };
}

function uniqueSources(symbols: SymbolMapJson['symbols']): string[] {

  //deduplikacija s Setom
  const sources = new Set( Object.values(symbols)
      .map((s) => s.source)
      .filter((s): s is string => s !== undefined)
  )

  return [
    ...sources
  ].sort();
}
