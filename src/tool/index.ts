import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256Hex } from '../shared/hash';
import { parseWasmSymbols } from '../shared/wasmSymbols';
import { parseDebugInfo, parseDebugLine } from './dwarfdump';
import { buildSymbolMap, type RuntimeInput } from './symbolMap';

function usage(): never {
  console.error(
    'usage: symbol-tool <debug.wasm> [--runtime <served.wasm>] [-o out.json] ' +
      '[--dwarfdump <binary>] [--cxxfilt <binary>]\n' +
      '       symbol-tool --dump-names <file.wasm>'
  );
  process.exit(2);
}

function run(bin: string, args: string[], stdin?: string): string {

  const res = spawnSync(bin, args, { input: stdin, encoding: 'utf8', maxBuffer: 1 << 28 });

  if (res.error) {
    throw new Error(
      `failed to run ${bin}: ${res.error.message}`
    );
  }

  if (res.status !== 0) {
    throw new Error(`${bin} exited with ${res.status}: ${(res.stderr ?? '').slice(0, 400)}`);
  }

  return res.stdout;
}

function demangleAll(names: string[], bin: string): Map<string, string> {

  const map = new Map<string, string>();

  if (names.length === 0) return map;

  const stdout = run(bin, [], `${names.join('\n')}\n`);
  const lines = stdout.split('\n');

  names.forEach((name, index) => {

    const demangled = lines[index]?.trim();
    if (demangled !== undefined && demangled !== '') map.set(name, demangled);
  });

  return map;
}

async function main(): Promise<void> {

  const args = process.argv.slice(2);
  let input: string | undefined;
  let runtimePath: string | undefined;
  let out: string | undefined;
  let dwarfdump = 'llvm-dwarfdump';
  let cxxfilt = 'llvm-cxxfilt';
  let dumpNames = false;

  for (let i = 0; i < args.length; i++) {

    const arg = args[i]!;

    if (arg === '-o' || arg === '--out') out = args[++i];
    else if (arg === '--dump-names') dumpNames = true;
    else if (arg === '--runtime') runtimePath = args[++i];
    else if (arg === '--dwarfdump') dwarfdump = args[++i] ?? dwarfdump;
    else if (arg === '--cxxfilt') cxxfilt = args[++i] ?? cxxfilt;
    else if (arg === '-h' || arg === '--help') usage();
    else if (input === undefined) input = arg;
    else usage();
  }

  if (input === undefined) usage();

  const bytes = new Uint8Array(readFileSync(input));
  const info = parseWasmSymbols(bytes);

  //samo za izpis imen ki so v input binary-ju
  if (dumpNames) {

    for (const [funcIndex, name] of [...info.rawNames].sort((a, b) => a[0] - b[0])) {
      process.stdout.write(`${funcIndex}\t${name}\n`);
    }

    return;
  }

  const subprograms = parseDebugInfo(run(dwarfdump, ['--debug-info', input]));
  if (subprograms.length === 0) {
    throw new Error(`${input}: no DWARF subprograms found. Is this a debug build?`);
  }

  const lineEntries = parseDebugLine(run(dwarfdump, ['--debug-line', input]));

  let runtimeInput: RuntimeInput | undefined;

  if (runtimePath !== undefined) {

    const runtimeBytes = new Uint8Array(readFileSync(runtimePath));
    const runtimeInfo = parseWasmSymbols(runtimeBytes);

    if (runtimeInfo.rawNames.size === 0) {
      throw new Error(
        `${runtimePath}: no name section in runtime binary, cannot recover the runtime index space.`
      );
    }

    runtimeInput = {
      filename: basename(runtimePath),
      hash: await sha256Hex(runtimeBytes),
      importedFunctionCount: runtimeInfo.importedFunctionCount,
      definedFunctionCount: runtimeInfo.definedFunctionCount,
      names: runtimeInfo.rawNames
    };
  }

  const mangledNames = new Set<string>();

  for (const subprogram of subprograms) if (subprogram.linkageName !== undefined) mangledNames.add(subprogram.linkageName);
  for (const name of runtimeInput?.names.values() ?? []) mangledNames.add(name);

  const demangledNames = demangleAll([...mangledNames], cxxfilt);

  const { map, diagnostics } = buildSymbolMap({
    filename: basename(input),
    hash: await sha256Hex(bytes),
    importedFunctionCount: info.importedFunctionCount,
    definedFunctionCount: info.definedFunctionCount,
    codeSectionOffset: info.codeSectionOffset,
    codeRanges: info.codeRanges,
    subprograms,
    lineEntries,
    runtimeInput,
    demangledNames
  });

  const outPath = out ?? `${(runtimePath ?? input).replace(/\.wasm$/, '')}.symbols.json`;

  //nastavimo tab indent na 2 zato da je berljivo
  writeFileSync(outPath, JSON.stringify(map, null, 2));

  let runtimeNote: string;

  if (runtimeInput !== undefined) {

    const ambiguousNum = diagnostics.ambiguous?.length ?? 0;
    const ambiguousNote = ambiguousNum > 0 ? `, ${ambiguousNum} ambiguous names skipped` : '';

    runtimeNote =
      `; projected onto ${runtimeInput.filename}: ` +
      `${diagnostics.runtimeMatched}/${runtimeInput.names.size} ` +
      `runtime functions carry source lines${ambiguousNote}`;
  } else {

    runtimeNote =
      `; no --runtime: keyed in ${basename(input)}'s own index space — joins only ` +
      `if that is the binary you serve, otherwise pass --runtime <served.wasm>`;
  }

  console.error(
    `${outPath}: ${diagnostics.matched}/${subprograms.length} subprograms mapped, ` +
      `${map.sources.length} source files, ${diagnostics.convention}, ` +
      `${diagnostics.lineFallbacks} line-table fallbacks, ${diagnostics.collisions} collisions, ` +
      `${diagnostics.unmatched.length} unmatched` +
      runtimeNote
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
