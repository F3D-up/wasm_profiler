export interface LineEntry {
  address: number; //offset v binarni datoteki kjer se funkcija zacne
  line: number; //linija datoteke "file" je se je prevedla v instruction na "address"
  file: string; //datoteka iz katere se je instruction na "address" prevedel
}

export interface Subprogram {
  lowPc: number; //offset v binarni datoteki kjer se funkcija zacne
  highPc?: number; //nevkljucujoc ending offset
  name?: string; //ime funkcije v izvorni kodi
  linkageName?: string; //ime funkcije ki ga vporabi linker
  declFile?: string; //datoteka kjer je funkcija definirana
  declLine?: number; //vrstaivca v datoteki kjer se funkcija nahaja
}

function stripDir(path: string, dir: string | undefined): string {

  if (!dir) return path;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;

  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function parseDebugLine(text: string): LineEntry[] {

  const entries: LineEntry[] = [];

  let dirs = new Map<number, string>();
  let files = new Map<number, { name: string; dirIndex?: number }>();
  let pending: { index: number; name?: string; dirIndex?: number } | undefined;

  const flushPending = (): void => {

    if (pending?.name !== undefined) {
      files.set(pending.index, { name: pending.name, dirIndex: pending.dirIndex });
    }
    pending = undefined;
  };

  for (const raw of text.split('\n')) {

    const line = raw.trim();
    let m: RegExpMatchArray | null;

    if (/^debug_line\[0x[0-9a-fA-F]+\]/.test(line)) {
      flushPending();
      dirs = new Map();
      files = new Map();
      continue;
    }

    if ((m = line.match(/^include_directories\[\s*(\d+)\]\s*=\s*"(.*)"/))) {
      dirs.set(Number(m[1]), m[2]!);
      continue;
    }

    if ((m = line.match(/^file_names\[\s*(\d+)\]:/))) {
      flushPending();
      pending = { index: Number(m[1]) };
      continue;
    }

    if (pending && (m = line.match(/^name:\s*"(.*)"/))) {
      pending.name = m[1];
      continue;
    }

    if (pending && (m = line.match(/^dir_index:\s*(\d+)/))) {
      pending.dirIndex = Number(m[1]);
      continue;
    }

    if ((m = line.match(/^0x([0-9a-fA-F]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))) {
      flushPending();

      if (/end_sequence/.test(m[5]!)) continue;

      const address = parseInt(m[1]!, 16)
      const line = Number(m[2])
      const file = files.get(Number(m[4]));
      if (!file) continue;

      const dir = file.dirIndex !== undefined ? dirs.get(file.dirIndex) : undefined;
      const rootDir = dirs.get(0);
      let path = file.name;

      if (dir && !path.startsWith('/')) path = `${dir}/${path}`;
      if (rootDir?.startsWith('/')) path = stripDir(path, rootDir);

      entries.push({ address, line, file: path });
    }
  }

  flushPending();
  return entries;
}

interface PendingSubprogram {
  lowPc?: number;
  highPc?: number;
  name?: string;
  linkageName?: string;
  declFile?: string;
  declLine?: number;
  declaration?: boolean;
}

export function parseDebugInfo(text: string): Subprogram[] {

  const subs: Subprogram[] = [];
  let compilationDir: string | undefined;
  let current: PendingSubprogram | undefined;

  const finalize = (): void => {

    if (current?.lowPc !== undefined && !current.declaration) {

      subs.push({
        lowPc: current.lowPc,
        highPc: current.highPc,
        name: current.name,
        linkageName: current.linkageName,
        declFile: current.declFile !== undefined ? stripDir(current.declFile, compilationDir) : undefined,
        declLine: current.declLine
      });
    }
    current = undefined;
  };

  for (const raw of text.split('\n')) {

    const line = raw.trim();
    let m: RegExpMatchArray | null;

    if ((m = line.match(/^0x[0-9a-fA-F]+:\s+(DW_TAG_\w+|NULL)/))) {
      finalize();
      if (m[1] === 'DW_TAG_subprogram') current = {};
      continue;
    }

    if ((m = line.match(/DW_AT_comp_dir\s+\("(.*)"\)/))) {
      compilationDir = m[1];
      continue;
    }

    if (!current) continue;

    if ((m = line.match(/DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)/))) {
      current.lowPc = parseInt(m[1]!, 16);
      continue;
    }

    if ((m = line.match(/DW_AT_high_pc\s+\(0x([0-9a-fA-F]+)\)/))) {
      current.highPc = parseInt(m[1]!, 16);
      continue;
    }

    if ((m = line.match(/DW_AT_name\s+\("(.*)"\)/))) {
      current.name = m[1];
      continue;
    }

    if ((m = line.match(/DW_AT_(?:linkage_name|MIPS_linkage_name)\s+\("(.*)"\)/))) {
      current.linkageName = m[1];
      continue;
    }

    if ((m = line.match(/DW_AT_decl_file\s+\("(.*)"\)/))) {
      current.declFile = m[1];
      continue;
    }

    if ((m = line.match(/DW_AT_decl_line\s+\((\d+)\)/))) {
      current.declLine = Number(m[1]);
      continue;
    }

    if (/DW_AT_declaration\s+\(true\)/.test(line)) {
      current.declaration = true;
    }
  }
  finalize();
  return subs;
}
