// tco.test.js — Tail Call Optimization tests for Monkey → RISC-V codegen
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';

import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const lexer = new Lexer(input);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) throw new Error(`Parse errors: ${parser.errors.join('\n')}`);
  return program;
}

function compileToAsm(input) {
  const program = parse(input);
  return new RiscVCodeGen().compile(program, inferTypes(program), analyzeFreeVars(program));
}

function run(input, maxCycles = 500000) {
  const asm = compileToAsm(input);
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors?.length > 0) throw new Error(`Assembly errors: ${result.errors.map(e => e.message || e).join('\n')}\n\nASM:\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4); // sp = near top of memory
  cpu.run(maxCycles);
  return cpu.output.join('');
}

describe('Tail Call Optimization', () => {
  describe('self-recursive TCO', () => {
    it('factorial with accumulator (self tail call)', () => {
      const output = run(`
        let fact = fn(n, acc) { if (n <= 1) { return acc }; return fact(n - 1, n * acc) };
        puts(fact(10, 1))
      `);
      assert.equal(output.trim(), '3628800');
    });

    it('countdown (self tail call)', () => {
      const output = run(`
        let countdown = fn(n) { if (n == 0) { return 0 }; return countdown(n - 1) };
        puts(countdown(500))
      `);
      assert.equal(output.trim(), '0');
    });
  });

  describe('general TCO (mutual recursion)', () => {
    it('is_even/is_odd mutual recursion', () => {
      const output = run(`
        let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) };
        let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) };
        puts(is_even(100))
      `);
      assert.equal(output.trim(), '1');
    });

    it('is_odd returns true for odd numbers', () => {
      const output = run(`
        let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) };
        let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) };
        puts(is_odd(99))
      `);
      assert.equal(output.trim(), '1');
    });

    it('mutual recursion at depth 1000 (no stack overflow)', () => {
      const output = run(`
        let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) };
        let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) };
        puts(is_even(1000))
      `);
      assert.equal(output.trim(), '1');
    });

    it('three-way mutual recursion (A→B→C→A)', () => {
      const output = run(`
        let a = fn(n) { if (n == 0) { return 1 }; return b(n - 1) };
        let b = fn(n) { if (n == 0) { return 2 }; return c(n - 1) };
        let c = fn(n) { if (n == 0) { return 3 }; return a(n - 1) };
        puts(a(6))
      `);
      // a(6)→b(5)→c(4)→a(3)→b(2)→c(1)→a(0) = 1
      assert.equal(output.trim(), '1');
    });

    it('tail call to a function with different argument count', () => {
      const output = run(`
        let sum = fn(a, b) { return a + b };
        let double_and_add = fn(x) { return sum(x, x) };
        puts(double_and_add(21))
      `);
      assert.equal(output.trim(), '42');
    });
  });

  describe('TCO correctness', () => {
    it('tail call preserves return value', () => {
      const output = run(`
        let identity = fn(x) { return x };
        let f = fn(n) { return identity(n * 2) };
        puts(f(21))
      `);
      assert.equal(output.trim(), '42');
    });

    it('non-tail position calls are NOT optimized (still work correctly)', () => {
      const output = run(`
        let double = fn(x) { return x * 2 };
        let f = fn(n) { return double(n) + 1 };
        puts(f(20))
      `);
      // double(n) is NOT in tail position (+ 1 after), so this is a regular call
      assert.equal(output.trim(), '41');
    });

    it('mixed tail and non-tail calls', () => {
      const output = run(`
        let add = fn(a, b) { return a + b };
        let f = fn(n) { if (n > 0) { return add(n, f(n - 1)) }; return 0 };
        puts(f(5))
      `);
      // f(5) = add(5, f(4)) = add(5, add(4, f(3))) = ... = 5+4+3+2+1+0 = 15
      assert.equal(output.trim(), '15');
    });
  });

  describe('TCO assembly verification', () => {
    it('generates j instruction (not jal) for general tail call', () => {
      const asm = compileToAsm(`
        let f = fn(n) { return 0 };
        let g = fn(n) { return f(n) };
        puts(g(1))
      `);
      // Should contain "j f" for the tail call
      assert.ok(asm.includes('j f'), `Expected 'j f' in assembly:\n${asm}`);
    });

    it('generates j instruction for self tail call', () => {
      const asm = compileToAsm(`
        let f = fn(n) { if (n == 0) { return 0 }; return f(n - 1) };
        puts(f(1))
      `);
      // Should contain "j f_tco_entry" for self tail call
      assert.ok(asm.includes('j f_tco_entry'), `Expected 'j f_tco_entry' in assembly:\n${asm}`);
    });
  });
});
