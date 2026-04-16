// riscv-peephole-stress.test.js — Verify peephole optimizations are semantically correct
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { peepholeOptimize } from './riscv-peephole.js';
import { RiscVCodeGen } from './monkey-codegen.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';

function run(code, { useRegisters = false, optimize = false } = {}) {
  const lexer = new Lexer(code);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  const cg = new RiscVCodeGen({ useRegisters });
  let asm = cg.compile(program);
  if (optimize) asm = peepholeOptimize(asm).optimized;
  const binary = new Assembler().assemble(asm);
  const cpu = new CPU();
  cpu.loadProgram(binary);
  cpu.regs.set(2, 0x100000 - 4);
  let output = '';
  cpu.ecallHandler = (c) => {
    const syscall = c.regs.get(17);
    if (syscall === 1) output += c.regs.get(10).toString();
    if (syscall === 11) output += String.fromCharCode(c.regs.get(10));
  };
  try { cpu.run(1000000); } catch(e) { output += 'ERROR:' + e.message; }
  return output;
}

describe('Peephole Optimizer Correctness', () => {
  // For each test: verify optimized output matches unoptimized output
  const programs = [
    { name: 'simple arithmetic', code: 'puts(1 + 2 + 3)' },
    { name: 'variable assignment', code: 'let x = 42; puts(x)' },
    { name: 'multiple variables', code: 'let x = 10; let y = 20; puts(x + y)' },
    { name: 'function call', code: 'let f = fn(x) { return x * 2 }; puts(f(21))' },
    { name: 'conditional', code: 'if (5 > 3) { puts(1) } else { puts(0) }' },
    { name: 'while loop', code: 'let i = 0; while (i < 5) { set i = i + 1 }; puts(i)' },
    { name: 'recursion', code: 'let f = fn(n) { if (n <= 1) { return 1 } return n * f(n - 1) }; puts(f(5))' },
    { name: 'array', code: 'let a = [10, 20, 30]; puts(a[1])' },
    { name: 'string', code: 'let s = "hello"; puts(s)' },
    { name: 'nested calls', code: 'let add = fn(a, b) { return a + b }; let mul = fn(a, b) { return a * b }; puts(add(mul(2, 3), 4))' },
    { name: 'boolean logic', code: 'if (true && false) { puts(1) } else { puts(0) }' },
    { name: 'comparison chain', code: 'let x = 5; if (x > 3 && x < 10) { puts(1) } else { puts(0) }' },
  ];

  for (const { name, code } of programs) {
    it(`${name}: stack-based opt=off matches opt=on`, () => {
      const unopt = run(code, { useRegisters: false, optimize: false });
      const opt = run(code, { useRegisters: false, optimize: true });
      assert.equal(opt, unopt, `Mismatch for "${name}": unopt="${unopt}", opt="${opt}"`);
    });

    it(`${name}: register-based opt=off matches opt=on`, () => {
      const unopt = run(code, { useRegisters: true, optimize: false });
      const opt = run(code, { useRegisters: true, optimize: true });
      assert.equal(opt, unopt, `Mismatch for "${name}": unopt="${unopt}", opt="${opt}"`);
    });
  }

  // Verify each pattern fires
  it('pattern: self-move eliminated', () => {
    const asm = '  mv a0, a0\n  mv a1, a0';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['self-move'], 1);
    assert.ok(!optimized.includes('mv a0, a0'), 'Self-move should be removed');
    assert.ok(optimized.includes('mv a1, a0'), 'Other moves should remain');
  });

  it('pattern: push-pop-same eliminated', () => {
    const asm = '  addi sp, sp, -4\n  sw a0, 0(sp)\n  lw a0, 0(sp)\n  addi sp, sp, 4';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['push-pop-same'], 1);
    assert.ok(!optimized.includes('sw'), 'Push should be removed');
  });

  it('pattern: push-pop-different becomes mv', () => {
    const asm = '  addi sp, sp, -4\n  sw a0, 0(sp)\n  lw t0, 0(sp)\n  addi sp, sp, 4';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['push-pop-mv'], 1);
    assert.ok(optimized.includes('mv t0, a0'), 'Should become mv t0, a0');
  });

  it('pattern: store-load elimination', () => {
    const asm = '  sw a0, 4(sp)\n  lw t0, 4(sp)';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['store-load-elim'], 1);
    assert.ok(optimized.includes('sw a0, 4(sp)'), 'Store should remain');
    assert.ok(optimized.includes('mv t0, a0'), 'Load replaced with mv');
    assert.ok(!optimized.includes('lw t0, 4(sp)'), 'Load should be removed');
  });

  it('pattern: merge consecutive sp adjustments', () => {
    const asm = '  addi sp, sp, -8\n  addi sp, sp, -4';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['merge-addi-sp'], 1);
    assert.ok(optimized.includes('addi sp, sp, -12'), 'Should merge to -12');
  });

  it('pattern: canceling sp adjustments eliminated', () => {
    const asm = '  addi sp, sp, -4\n  addi sp, sp, 4';
    const { optimized, stats } = peepholeOptimize(asm);
    assert.equal(stats.patterns['merge-addi-sp'], 1);
    assert.ok(!optimized.includes('addi sp'), 'Should eliminate both');
  });

  // Optimizer should reduce instruction count
  it('optimizer produces valid assembly', () => {
    const code = 'let x = 1; let y = 2; let z = x + y; puts(z)';
    const lexer = new Lexer(code);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    const cg = new RiscVCodeGen({ useRegisters: false });
    const asm = cg.compile(program);
    const { optimized } = peepholeOptimize(asm);
    
    // Should still be non-empty and valid text
    assert.ok(optimized.length > 0, 'Optimized assembly should be non-empty');
    assert.ok(optimized.includes('_start'), 'Should still have _start label');
  });
});
