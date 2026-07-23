import { QUALITY_RANK, type FunctionSymbol, type SymbolQuality } from './profile';

export interface CodeRange {
  funcIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface WasmSymbolInfo {
  importedFunctionCount: number;
  definedFunctionCount: number;
  exportedFunctionCount: number;
  hasNameSection: boolean;
  symbols: Map<number, FunctionSymbol>;
  rawNames: Map<number, string>;
  codeRanges: CodeRange[];
  codeSectionOffset: number;
}

const decoder = new TextDecoder();

class Reader {


  constructor(
    public bytes: Uint8Array,
    public offset = 0,
    public end = bytes.length
  ) {}

  eof(): boolean {
    return this.offset >= this.end;
  }

  //ko se prebere bajt se cursor (offset) premakne na naslednji znak.
  byte(): number {

    if (this.offset >= this.end) throw new Error('unexpected end of wasm binary');

    return this.bytes[this.offset++]!;
  }

  //wasm binary format uporabi LEB128 za zapis stevilk
  //pretvorba unsigned LEB128 (little endian base) velikosti 32 bits
  u32(): number {

    let result = 0;
    let shift = 0;
    let b = this.byte();

    //javascript pretvori v signed 32bit za uporabo bitwise operacij(<<,>>,...) zato je tu ne uporabimo
    // ce je najvisji bit nastavljen (0x80) pomeni "sledi se vsaj en bajt"
    while ((b & 0x80) !== 0) {

      //odrstarino MSB in zamaknemo za trenutni offset
      result += (b & 0x7f) * (2 ** shift);

      //shift samo za 7 ker MSB kot ze omenjeno (0x80)
      shift += 7;
      if (shift >= 35) throw new Error('LEB128 value too long for u32');

      b = this.byte();
    }

    //zadnji bajt pristejemo sele tu
    // operacija >>> samo poravna na uint32
    return (result + (b & 0x7f) * (2 ** shift)) >>> 0;
  }

  string(): string {

    const length = this.u32();

    if (this.offset + length > this.end) throw new Error('string exceeds section bounds');

    const s = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return s;
  }

  subarrayReader(length: number): Reader {

    if (this.offset + length > this.end) throw new Error('subsection exceeds bounds');
    const reader = new Reader(this.bytes, this.offset, this.offset + length);
    this.offset += length;

    return reader;
  }

  //preskoci WASM "limits" zapis, ki ga imata table in memory import
  // (limits (flags,min,max) oznacujejo spodnjo in zgornjo mejo velikosti dodeljenega spomina in velikosti referencne tabele)
  //  vrednosti ne potrebujemo, beremo le zato da jih preskocimo
  skipLimits(): void {

    //bit 0 v flags pove ali je za min zapisan se max
    const flags = this.u32();
    this.u32(); // min
    if (flags & 1) this.u32(); // max

  }
}

//preveri ce brani zapis zacne z biti ki oznacujejo zacetek WASM binarne datoteke
export function isWasmBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
      bytes[0] === 0x00 &&
        bytes[1] === 0x61 &&
          bytes[2] === 0x73 &&
            bytes[3] === 0x6d
  );
}

const setSymbol = (index: number, symbol: FunctionSymbol, info: WasmSymbolInfo): void => {

  const prev = info.symbols.get(index);

  if (!prev || QUALITY_RANK[symbol.quality] > QUALITY_RANK[prev.quality]) {
    info.symbols.set(index, symbol);
  }
};

export function parseWasmSymbols(bytes: Uint8Array): WasmSymbolInfo {

  if (!isWasmBytes(bytes)) throw new Error('not a WebAssembly binary (bad magic)');

  //gre za verzijo WASM binarnega formata ne pa za dejansko WASM verzijo
  // WASM component model trenutno uporablja polje "version" za usklajevanje modulov
  // to za nas ni pomembno saj brskalniki ne podpirajo modulov
  const version = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
  if (version !== 1) throw new Error(`unsupported wasm version ${version}`);

  const info: WasmSymbolInfo = {
    importedFunctionCount: 0,
    definedFunctionCount: 0,
    exportedFunctionCount: 0,
    hasNameSection: false,
    symbols: new Map(),
    rawNames: new Map(),
    codeRanges: [],
    codeSectionOffset: 0
  };


  const reader = new Reader(bytes, 8);

  while (!reader.eof()) {

    const id = reader.byte();
    const size = reader.u32();
    const section = reader.subarrayReader(size);

    switch (id) {
      case 2: { //import
        parseImports(section, info);
        break;
      }

      case 3: { //function
        info.definedFunctionCount = section.u32();
        break;
      }

      case 7: { //export
        parseExports(section, info);
        break;
      }

      case 10: { //code
        parseCode(section, info);
        break;
      }

      case 0: { //custom
        try {
          parseCustom(section, info);
        } catch {}
        break;
      }

      default: {
        break;
      }
    }
  }

  return info;
}

function parseImports(reader: Reader, info: WasmSymbolInfo): void {

  const count = reader.u32();

  for (let i = 0; i < count; i++) {

    const module = reader.string();
    const field = reader.string();
    const kind = reader.byte();

    switch (kind) {
      case 0x00: { //function
        reader.u32(); //type index

        setSymbol(
          info.importedFunctionCount,
          { name: `import:${module}.${field}`, quality: 'export-import' },
          info);

        info.importedFunctionCount++;
        break;
      }

      case 0x01: { //table
        reader.byte(); //reftype
        reader.skipLimits();
        break;
      }

      case 0x02: { //memory
        reader.skipLimits();
        break;
      }

      case 0x03: { // global
        reader.byte(); //valtype
        reader.byte(); //mutability
        break;
      }

      case 0x04: { //tag
        reader.byte();//attribute
        reader.u32(); //type index
        break;
      }

      default: {
        throw new Error(`unknown import kind 0x${kind.toString(16)}`);
      }
    }
  }
}

function parseExports(reader: Reader, info: WasmSymbolInfo): void {

  const count = reader.u32();

  for (let i = 0; i < count; i++) {

    const name = reader.string();
    const kind = reader.byte();
    const index = reader.u32();


    //tu preverjamo samo za function saj imajo vsi exporti enako obliko
    // zato v primeru drugega tipa exporta ne potrebujemo spremeniti offset
    if (kind === 0x00) {
      info.exportedFunctionCount++;
      setSymbol(index, { name, quality: 'export-import' }, info);
    }
  }
}

function parseCode(reader: Reader, info: WasmSymbolInfo): void {

  info.codeSectionOffset = reader.offset;
  const count = reader.u32();

  for (let i = 0; i < count; i++) {

    const bodySize = reader.u32();
    const bodyStart = reader.offset;
    reader.subarrayReader(bodySize);

    info.codeRanges.push({
      funcIndex: info.importedFunctionCount + i,
      bodyStart,
      bodyEnd: bodyStart + bodySize
    });
  }
}

function parseCustom(reader: Reader, info: WasmSymbolInfo): void {

  if (reader.string() !== 'name') return;

  info.hasNameSection = true;

  while (!reader.eof()) {

    const subId = reader.byte();
    const subSize = reader.u32();
    const subReader = reader.subarrayReader(subSize);

    if (subId !== 1) continue; //samo "function names subsections" nas zanimajo

    const count = subReader.u32();

    for (let i = 0; i < count; i++) {

      const functionIndex = subReader.u32();
      const rawName = subReader.string();

      info.rawNames.set(functionIndex, rawName);
      setSymbol(functionIndex, { name: rawName, quality: 'name' }, info);
    }
  }
}
