// riscv-peephole.test.js — Tests for RISC-V peephole optimizer
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { peepholeOptimize } from './riscv-peephole.js';
import { RiscVCodeGen } from './monkey-codegen.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const lexer = new Lexer(input);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) throw new Error(parser.errors.join('\n'));
  return program;
}

function compileAndRun(input, optimize = false) {
  const program = parse(input);
  const codegen = new RiscVCodeGen();
  let asm = codegen.compile(program);
  let stats = null;
  if (optimize) {
    const result = peepholeOptimize(asm);
    asm = result.optimized;
    stats = result.stats;
  }
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm errors: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(1000000);
  return { output: cpu.output.join(''), cycles: cpu.cycles, stats, asm };
}

describe('Peephole optimizer — patterns', () => {
  it('removes self-move', () => {
    const { optimized, stats } = peepholeOptimize('  mv a0, a0\n  add a0, t0, a0');
    assert.ok(!optimized.includes('mv a0, a0'));
    assert.equal(stats.patterns['self-move'], 1);
  });

  it('removes push/pop same register', () => {
    const asm = [
      '  addi sp, sp, -4',
      '  sw a0, 0(sp)',
      '  lw a0, 0(sp)',
      '  addi sp, sp, 4',
    ].join('\n');
    const { optimized, stats } = peepholeOptimize(asm);
    assert.ok(!optimized.includes('addi sp'));
    assert.equal(stats.patterns['push-pop-same'], 1);
  });

  it('converts push/pop different regs to mv', () => {
    const asm = [
      '  addi sp, sp, -4',
      '  sw a0, 0(sp)',
      '  lw t0, 0(sp)',
      '  addi sp, sp, 4',
    ].join('\n');
    const { optimized, stats } = peepholeOptimize(asm);
    assert.ok(optimized.includes('mv t0, a0'));
    assert.ok(!optimized.includes('sw a0'));
    assert.equal(stats.patterns['push-pop-mv'], 1);
  });

  it('merges consecutive sp adjustments', () => {
    const asm = '  addi sp, sp, -8\n  addi sp, sp, -4';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.ok(optimized.includes('addi sp, sp, -12'));
    assert.equal(stats.patterns['merge-addi-sp'], 1);
  });

  it('eliminates canceling sp adjustments', () => {
    const asm = '  addi sp, sp, -4\n  addi sp, sp, 4';
    const { optimized } = peepholeOptimize(asm);
    assert.ok(!optimized.includes('addi'));
  });

  it('eliminates store-load same address', () => {
    const asm = '  sw a0, -12(s0)\n  lw a0, -12(s0)';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.ok(optimized.includes('sw a0, -12(s0)'));
    assert.ok(!optimized.includes('lw a0, -12(s0)'));
    assert.equal(stats.patterns['store-load-elim'], 1);
  });

  it('store-load different regs becomes mv', () => {
    const asm = '  sw a0, -12(s0)\n  lw t0, -12(s0)';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.ok(optimized.includes('sw a0, -12(s0)'));
    assert.ok(optimized.includes('mv t0, a0'));
    assert.ok(!optimized.includes('lw t0, -12(s0)'));
  });
});

describe('Peephole optimizer — correctness', () => {
  const programs = [
    ['simple arithmetic', 'puts(3 + 4)', '7'],
    ['let + use', 'let x = 10; puts(x)', '10'],
    ['compound expr', 'let x = 3; let y = 4; puts(x + y)', '7'],
    ['if/else', 'if (1 < 2) { puts(10) } else { puts(20) }', '10'],
    ['while loop', 'let i = 0; let s = 0; while (i < 5) { set s = s + i; set i = i + 1 }; puts(s)', '10'],
    ['function call', 'let double = fn(x) { return x * 2 }; puts(double(21))', '42'],
    ['recursive fib', `
      let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }
      puts(fib(10))
    `, '55'],
    ['factorial', `
      let fact = fn(n) { if (n <= 1) { return 1 }; return n * fact(n-1) }
      puts(fact(5))
    `, '120'],
    ['prime sieve', `
      let is_prime = fn(n) {
        if (n < 2) { return 0 }
        let i = 2
        while (i * i <= n) {
          if (n % i == 0) { return 0 }
          set i = i + 1
        }
        return 1
      }
      let n = 2
      while (n <= 20) {
        if (is_prime(n) == 1) { puts(n) }
        set n = n + 1
      }
    `, '235711131719'],
  ];

  for (const [name, code, expected] of programs) {
    it(`${name} — optimized output matches`, () => {
      const unopt = compileAndRun(code, false);
      const opt = compileAndRun(code, true);
      assert.equal(opt.output, expected, `Expected ${expected}, got ${opt.output}`);
      assert.equal(opt.output, unopt.output, 'Optimized output must match unoptimized');
    });

    it(`${name} — fewer cycles when optimized`, () => {
      const unopt = compileAndRun(code, false);
      const opt = compileAndRun(code, true);
      assert.ok(opt.cycles <= unopt.cycles, 
        `Optimized (${opt.cycles}) should use ≤ cycles than unoptimized (${unopt.cycles})`);
    });
  }
});

describe('Peephole optimizer — benchmarks', () => {
  it('reports cycle savings', () => {
    const programs = [
      ['sum 1..100', 'let s=0; let i=1; while(i<=100){set s=s+i; set i=i+1}; puts(s)'],
      ['fib(10)', 'let fib=fn(n){if(n<=1){return n}; return fib(n-1)+fib(n-2)}; puts(fib(10))'],
    ];

    for (const [name, code] of programs) {
      const unopt = compileAndRun(code, false);
      const opt = compileAndRun(code, true);
      const saved = unopt.cycles - opt.cycles;
      const pct = ((saved / unopt.cycles) * 100).toFixed(1);
      console.log(`  ${name}: ${unopt.cycles} → ${opt.cycles} cycles (saved ${saved}, ${pct}%)`);
      console.log(`    Patterns: ${JSON.stringify(opt.stats.patterns)}`);
    }
  });
});
