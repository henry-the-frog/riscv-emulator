// bench-riscv-vs-vm.js — Compare RISC-V native compilation vs Monkey VM
//
// Runs identical programs through both backends and compares:
// - Execution time (wall clock)
// - VM cycles / RISC-V cycles
// - Correctness (same output)

import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';
import { Compiler } from '/Users/henry/repos/monkey-lang/src/compiler.js';
import { VM } from '/Users/henry/repos/monkey-lang/src/vm.js';

function runRISCV(code, maxCycles = 10_000_000) {
  const p = new Parser(new Lexer(code));
  const prog = p.parseProgram();
  if (p.errors.length > 0) return { error: p.errors.join('\n') };
  
  const typeInfo = inferTypes(prog);
  const closureInfo = analyzeFreeVars(prog);
  const cg = new RiscVCodeGen();
  const asm = cg.compile(prog, typeInfo, closureInfo);
  if (cg.errors.length > 0) return { error: `Codegen: ${cg.errors.join(', ')}` };
  
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) return { error: `Asm: ${result.errors.map(e=>e.message).join(', ')}` };
  
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);  // stack pointer
  
  const start = performance.now();
  cpu.run(maxCycles);
  const elapsed = performance.now() - start;
  
  return {
    output: cpu.output.join(''),
    cycles: cpu.cycles,
    elapsed,
    instructions: result.words.length,
  };
}

function runVM(code) {
  const p = new Parser(new Lexer(code));
  const prog = p.parseProgram();
  if (p.errors.length > 0) return { error: p.errors.join('\n') };
  
  const compiler = new Compiler();
  compiler.compile(prog);
  const bytecode = compiler.bytecode();
  
  // Capture console.log output
  const captured = [];
  const origLog = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  
  const vm = new VM(bytecode);
  const start = performance.now();
  vm.run();
  const elapsed = performance.now() - start;
  
  console.log = origLog;
  
  return {
    output: captured.join('\n'),
    elapsed,
  };
}

// Benchmark programs
const benchmarks = [
  {
    name: 'fibonacci(20)',
    code: `
      let fib = fn(n) { if (n <= 1) { return n }; return fib(n - 1) + fib(n - 2) };
      puts(fib(20))
    `,
  },
  {
    name: 'fibonacci(25)',
    code: `
      let fib = fn(n) { if (n <= 1) { return n }; return fib(n - 1) + fib(n - 2) };
      puts(fib(25))
    `,
  },
  {
    name: 'sum 1..1000',
    code: `
      let sum = 0;
      let i = 1;
      while (i <= 1000) {
        set sum = sum + i;
        set i = i + 1;
      };
      puts(sum)
    `,
  },
  {
    name: 'factorial(12)',
    code: `
      let fact = fn(n) { if (n <= 1) { return 1 }; return n * fact(n - 1) };
      puts(fact(12))
    `,
  },
  {
    name: 'nested loops (20x20)',
    code: `
      let sum = 0;
      let i = 0;
      while (i < 20) {
        let j = 0;
        while (j < 20) {
          set sum = sum + i * j;
          set j = j + 1;
        };
        set i = i + 1;
      };
      puts(sum)
    `,
  },
  {
    name: 'Collatz(27)',
    code: `
      let collatz = fn(n) {
        let steps = 0;
        while (n != 1) {
          if (n % 2 == 0) { set n = n / 2 } else { set n = 3 * n + 1 };
          set steps = steps + 1;
        };
        return steps
      };
      puts(collatz(27))
    `,
  },
  {
    name: 'make_adder closure',
    code: `
      let make_adder = fn(x) { fn(y) { x + y } };
      let add5 = make_adder(5);
      let sum = 0;
      let i = 0;
      while (i < 100) {
        set sum = sum + add5(i);
        set i = i + 1;
      };
      puts(sum)
    `,
  },
  {
    name: 'higher-order apply',
    code: `
      let apply = fn(f, x) { f(x) };
      let double = fn(x) { x * 2 };
      let sum = 0;
      let i = 0;
      while (i < 100) {
        set sum = sum + apply(double, i);
        set i = i + 1;
      };
      puts(sum)
    `,
  },
  {
    name: 'is_even mutual recursion (RISC-V only)',
    code: `
      let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) };
      let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) };
      let count = 0;
      let i = 0;
      while (i < 50) {
        set count = count + is_even(i);
        set i = i + 1;
      };
      puts(count)
    `,
    rvOnly: true,
  },
];

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║        RISC-V Native vs Monkey VM — Performance Benchmark      ║');
console.log('╠══════════════════════════════════════════════════════════════════╣');
console.log('');

const results = [];

for (const bench of benchmarks) {
  if (bench.rvOnly) {
    const rv = runRISCV(bench.code);
    if (rv.error) {
      console.log(`  ${bench.name}: RISC-V ERROR: ${rv.error}`);
      continue;
    }
    console.log(`  📊 ${bench.name}`);
    console.log(`     RISC-V:  ${rv.elapsed.toFixed(2)}ms (${rv.cycles.toLocaleString()} cycles)`);
    console.log(`     Output:  ${rv.output}`);
    console.log('');
    continue;
  }
  
  const rv = runRISCV(bench.code);
  const vm = runVM(bench.code);
  
  if (rv.error) {
    console.log(`  ${bench.name}: RISC-V ERROR: ${rv.error}`);
    continue;
  }
  
  const rvOut = rv.output;
  const vmOut = vm.output;
  const match = rvOut === vmOut;
  
  const speedup = vm.elapsed / rv.elapsed;
  
  results.push({
    name: bench.name,
    rvTime: rv.elapsed,
    vmTime: vm.elapsed,
    rvCycles: rv.cycles,
    rvInstructions: rv.instructions,
    speedup,
    match,
  });
  
  console.log(`  📊 ${bench.name}`);
  console.log(`     RISC-V:  ${rv.elapsed.toFixed(2)}ms (${rv.cycles.toLocaleString()} cycles, ${rv.instructions} instructions)`);
  console.log(`     VM:      ${vm.elapsed.toFixed(2)}ms`);
  console.log(`     Speedup: ${speedup.toFixed(1)}x ${speedup > 1 ? '🚀' : '🐢'}`);
  console.log(`     Output:  ${match ? '✅ Match' : `❌ MISMATCH (rv=${rvOut}, vm=${vmOut})`}`);
  console.log('');
}

console.log('╠══════════════════════════════════════════════════════════════════╣');
const avgSpeedup = results.reduce((s, r) => s + r.speedup, 0) / results.length;
console.log(`  Average speedup: ${avgSpeedup.toFixed(1)}x`);
console.log(`  Benchmarks: ${results.length}/${benchmarks.length} passed`);
console.log(`  All outputs match: ${results.every(r => r.match) ? '✅' : '❌'}`);
console.log('╚══════════════════════════════════════════════════════════════════╝');
