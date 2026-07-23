import binaryen from 'binaryen';
import { ENTER_HOOK, EXIT_HOOK, ORIG_SUFFIX } from './instrumentNames';

type Binaryen = typeof binaryen;

const loadBinaryen = async (): Promise<Binaryen> =>
  await (binaryen as Binaryen | Promise<Binaryen>);

export interface InstrumentedFunction {
  funcIndex: number;
  name: string;
}

export interface InstrumentResult {
  bytes: Uint8Array;
  importedFunctionCount: number;
  definedFunctionCount: number;
  instrumentedFunctions: InstrumentedFunction[];
}

export type IncludeFunc = (funcIndex: number, name: string) => boolean;

const ENTER = ENTER_HOOK;
const EXIT = EXIT_HOOK;

interface FunctionRecord {
  funcIndex: number;
  name: string;
  imported: boolean;
  params: binaryen.Type;
  results: binaryen.Type;
  vars: binaryen.Type[];
  body: binaryen.ExpressionRef;
}


//deluje tako da vkrademo entrypoint neke funkcije
// tisti funkciji spremenimo ime in jo klicemo ko se nas ukraden entrypoint sprozi
export async function instrumentModule(bytes: Uint8Array, includeScope?: IncludeFunc): Promise<InstrumentResult> {

  const binaryen = await loadBinaryen();
  binaryen.setDebugInfo(true);
  const module = binaryen.readBinary(bytes);

  try {
    module.setFeatures(binaryen.Features.All);

    const functionRecords: FunctionRecord[] = [];
    let importedCount = 0;

    //konstrukcija functionRecords
    for (let i = 0; i < module.getNumFunctions(); i++) {

      const functionInfo = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
      const imported = Boolean(functionInfo.module);

      if (imported) importedCount++;
      functionRecords.push({
        funcIndex: -1,
        name: functionInfo.name,
        imported,
        params: functionInfo.params,
        results: functionInfo.results,
        vars: functionInfo.vars,
        body: functionInfo.body
      });
    }

    let importSeen = 0;
    let definedSeen = 0;

    //izracunamo function index ce je imported ali defined v tem filu
    for (const record of functionRecords) {
      record.funcIndex = record.imported ? importSeen++ : importedCount + definedSeen++;
    }

    module.addFunctionImport(ENTER, '__profiler', 'enter', binaryen.i32, binaryen.none);
    module.addFunctionImport(EXIT, '__profiler', 'exit', binaryen.i32, binaryen.none);

    const instrumentedFunctions: InstrumentedFunction[] = [];

    for (const record of functionRecords) {

      if (record.imported) continue;
      //ce je definiran scope in funkcija ne pade v scope
      if (includeScope && !includeScope(record.funcIndex, record.name)) continue;

      const origName = record.name + ORIG_SUFFIX;

      //kot omenjeno funkciji spremenimo ime, saj smo ji izvorno ime "ukradli"
      module.removeFunction(record.name);
      module.addFunction(origName, record.params, record.results, record.vars, record.body);

      const paramTypes = record.params === binaryen.none ? [] : binaryen.expandType(record.params);
      const args = paramTypes.map((type, index) => module.local.get(index, type));

      const enter = module.call(ENTER, [module.i32.const(record.funcIndex)], binaryen.none);
      const exit = module.call(EXIT, [module.i32.const(record.funcIndex)], binaryen.none);
      //nastavimo hook da klicemo izvorno funkcijo ko se sprozi njen entrypoint
      const inner = module.call(origName, args, record.results);

      let vars: binaryen.Type[] = [];
      let funcBody: binaryen.ExpressionRef;

      if (record.results === binaryen.none) {
        funcBody = module.block(null, [enter, inner, exit]);
      } else {

        const resultLocalIndex = paramTypes.length;
        vars = [record.results];

        funcBody = module.block(
          null,
          [enter, module.local.set(resultLocalIndex, inner), exit, module.local.get(resultLocalIndex, record.results)],
          record.results
        );
      }

      module.addFunction(record.name, record.params, record.results, vars, funcBody);
      instrumentedFunctions.push({ funcIndex: record.funcIndex, name: record.name });
    }

    if (!module.validate()) {
      throw new Error('instrumented module failed binaryen validation');
    }

    return {
      bytes: module.emitBinary(),
      importedFunctionCount: importedCount,
      definedFunctionCount: functionRecords.length - importedCount,
      instrumentedFunctions: instrumentedFunctions
    };

  } finally {
    module.dispose();
  }
}
