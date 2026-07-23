import { sha256Hex } from './hash';
import { parseWasmSymbols } from './wasmSymbols';

export interface WasmModuleMeta {
  hash: string;
  functionCount: number;
  funcNames: string[];
}

export async function describeWasm(bytes: Uint8Array): Promise<WasmModuleMeta> {

  const info = parseWasmSymbols(bytes);
  const functionCount = info.importedFunctionCount + info.definedFunctionCount;

  const funcNames: string[] = [];

  for (let index = 0; index < functionCount; index++) {
    const symbol = info.symbols.get(index);
    funcNames.push(symbol ? symbol.name : '');
  }

  return {
    hash: await sha256Hex(bytes),
    functionCount,
    funcNames
  };
}
