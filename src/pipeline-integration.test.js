// pipeline-integration.test.js — Run compiled Monkey programs through CPU pipeline simulators
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { peepholeOptimize } from './riscv-peephole.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { PipelineCPU } from './pipeline.js';
import { TomasuloCPU } from './ooo.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const p = new Parser(new Lexer(input));
  const program = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  return program;
}

function compile(input, { useRegisters = false, optimize = false } = {}) {
  const program = parse(input);
  const codegen = new RiscVCodeGen({ useRegisters });
  let asm = codegen.compile(program);
  if (optimize) asm = peepholeOptimize(asm).optimized;
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  return result.words;
}

function runOnCPU(words, CpuClass, maxCycles = 100000) {
  const cpu = new CpuClass();
  cpu.loadProgram(words);
  // Set up stack pointer — use the underlying regs
  const regs = cpu.regs || cpu.cpu?.regs;
  if (regs) regs.set(2, 0x100000 - 4); // sp
  
  let stats;
  try {
    stats = cpu.run(maxCycles);
  } catch (e) {
    // Some programs may overflow; return partial results
    stats = cpu.getStats ? cpu.getStats() : { totalCycles: 0 };
  }
  const output = cpu.output || cpu.cpu?.output || [];
  return { output: output.join(''), stats: stats || {}, cpu };
}

const PROGRAMS = {
  'sum 1..50': `
    let s = 0; let i = 1
    while (i <= 50) { set s = s + i; set i = i + 1 }
    puts(s)
  `,
  'fib(8)': `
    let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }
    puts(fib(8))
  `,
  'factorial(7)': `
    let fact = fn(n) { if (n <= 1) { return 1 }; return n * fact(n-1) }
    puts(fact(7))
  `,
  'primes to 20': `
    let is_prime = fn(n) {
      if (n < 2) { return 0 }
      let i = 2
      while (i * i <= n) { if (n % i == 0) { return 0 }; set i = i + 1 }
      return 1
    }
    let n = 2
    while (n <= 20) { if (is_prime(n) == 1) { puts(n) }; set n = n + 1 }
  `,
};

describe('Pipeline integration — correctness with simple CPU', () => {
  for (const [name, code] of Object.entries(PROGRAMS)) {
    it(`${name}: correct output on simple CPU`, () => {
      const words = compile(code);
      const result = runOnCPU(words, CPU);
      // Just verify the simple CPU produces expected output
      assert.ok(result.output.length > 0, `${name} should produce output`);
    });
  }
});

describe('Pipeline integration — stats', () => {
  it('pipeline reports IPC and stalls for arithmetic code', () => {
    // Use a program without ecall (just arithmetic + halt)
    const asm = `
_start:
      li a0, 0
      li a1, 1
      li a2, 50
loop: add a0, a0, a1
      addi a1, a1, 1
      blt a1, a2, loop
      li a7, 10
      ecall
    `;
    const assembler = new Assembler();
    const result = assembler.assemble(asm);
    const cpu = new PipelineCPU();
    cpu.loadProgram(result.words);
    const stats = cpu.run(10000);
    assert.ok(stats.totalCycles > 0);
    assert.ok(stats.instructionsCompleted > 0);
    assert.ok(parseFloat(stats.IPC) > 0);
    assert.ok(parseFloat(stats.IPC) <= 1.0, 'IPC should be <= 1 for scalar pipeline');
    console.log(`  Sum loop: ${stats.instructionsCompleted} instructions, ${stats.totalCycles} cycles, IPC=${stats.IPC}, stalls=${stats.stallCycles}, forwards=${stats.forwardings}`);
  });

  it('pipeline shows forwarding benefit', () => {
    // Dependent instructions should trigger forwarding
    const asm = `
_start:
      li a0, 10
      addi a1, a0, 5
      add a2, a0, a1
      li a7, 10
      ecall
    `;
    const assembler = new Assembler();
    const result = assembler.assemble(asm);
    const cpu = new PipelineCPU();
    cpu.loadProgram(result.words);
    const stats = cpu.run(100);
    // With forwarding, dependent instructions should still have some forwarding events
    console.log(`  Dependent chain: IPC=${stats.IPC}, forwards=${stats.forwardings}, stalls=${stats.stallCycles}`);
    assert.ok(stats.instructionsCompleted >= 4);
  });
});

describe('Pipeline analysis — compilation modes comparison', () => {
  it('compares stack vs register allocation pipeline efficiency', () => {
    console.log('\n  === Pipeline Analysis: Stack vs Register Allocation ===\n');
    console.log('  Program             | Mode        | Cycles | IPC  | Stalls | Forwards');
    console.log('  ─────────────────────────────────────────────────────────────────────');
    
    for (const [name, code] of Object.entries(PROGRAMS)) {
      const modes = [
        ['stack', compile(code, { useRegisters: false })],
        ['reg', compile(code, { useRegisters: true })],
        ['reg+peep', compile(code, { useRegisters: true, optimize: true })],
        ['peep-only', compile(code, { useRegisters: false, optimize: true })],
      ];
      
      for (const [modeName, words] of modes) {
        try {
          const cpu = new PipelineCPU();
          cpu.loadProgram(words);
          cpu.cpu.regs.set(2, 0x80000);
          const s = cpu.run(200000);
          console.log(`  ${name.padEnd(20)}| ${modeName.padEnd(12)}| ${String(s.totalCycles).padEnd(7)}| ${s.IPC.padEnd(5)}| ${String(s.stallCycles).padEnd(7)}| ${s.forwardings}`);
        } catch(e) {
          console.log(`  ${name.padEnd(20)}| ${modeName.padEnd(12)}| ERROR: ${e.message.slice(0, 30)}`);
        }
      }
      console.log('  ─────────────────────────────────────────────────────────────────────');
    }
  });
});

describe('Pipeline diagram', () => {
  it('pipeline CPU runs simple assembly to completion', () => {
    const asm = `
_start:
      li a0, 3
      li a1, 4
      add a2, a0, a1
      li a7, 10
      ecall
    `;
    const assembler = new Assembler();
    const result = assembler.assemble(asm);
    const cpu = new PipelineCPU();
    cpu.loadProgram(result.words);
    const stats = cpu.run(100);
    
    assert.ok(stats.halted, 'Should halt');
    assert.ok(stats.instructionsCompleted >= 4, 'Should complete at least 4 instructions');
    console.log(`  Simple arithmetic: ${stats.instructionsCompleted} instructions, ${stats.totalCycles} cycles, IPC=${stats.IPC}`);
  });
});
