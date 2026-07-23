import binaryen from 'binaryen';
import { writeFileSync, mkdirSync } from 'node:fs';

const m = new binaryen.Module();
const { i32, f64 } = binaryen;

m.addFunction('parse_header', i32, i32, [],
  m.return(m.i32.mul(m.local.get(0, i32), m.i32.const(3)))
);

m.addFunction('checksum', i32, i32, [i32],
  m.block(null, [
    m.local.set(1, m.i32.const(0)),
    m.loop('acc', m.block(null, [
      m.local.set(1, m.i32.add(m.local.get(1, i32), m.local.get(0, i32))),
      m.local.set(0, m.i32.sub(m.local.get(0, i32), m.i32.const(1))),
      m.br('acc', m.i32.gt_s(m.local.get(0, i32), m.i32.const(0)))
    ])),
    m.return(m.local.get(1, i32))
  ])
);

m.addFunction('normalize', f64, f64, [],
  m.return(m.f64.div(m.local.get(0, f64), m.f64.const(255)))
);

m.setFeatures(binaryen.Features.All);

for (const name of ['parse_header', 'checksum', 'normalize']) {
  m.addFunctionExport(name, name);
}

binaryen.setDebugInfo(true);
if (!m.validate()) {
  throw new Error('generated module failed binaryen validation');
}

const bytes = m.emitBinary();
mkdirSync('test-site', { recursive: true });
writeFileSync('test-site/unrelated.wasm', bytes);
console.log(`test-site/unrelated.wasm written (${bytes.length} bytes)`);
