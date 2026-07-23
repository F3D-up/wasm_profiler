import { readFileSync } from 'node:fs';

const bytes = readFileSync('test-site/profiler_fixture.wasm');
const { instance } = await WebAssembly.instantiate(bytes);
const { fib, hot_loop, chain_a } = instance.exports;

const t0 = performance.now();
let last = 0;
while (performance.now() - t0 < 400) {
  last = fib(24) + Number(chain_a(20000)) + hot_loop(100000);
}
console.log(`workload done (last result: ${last})`);
