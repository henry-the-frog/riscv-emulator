// riscv-regalloc.test.js — Tests for register allocation in RISC-V codegen
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { peepholeOptimize } from './riscv-peephole.js';
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

function compileAndRun(input, { useRegisters = false, optimize = false } = {}) {
  const program = parse(input);
  const codegen = new RiscVCodeGen({ useRegisters });
  let asm = codegen.compile(program);
  if (optimize) {
    asm = peepholeOptimize(asm).optimized;
  }
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm errors: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(1000000);
  return { output: cpu.output.join(''), cycles: cpu.cycles, words: result.words.length, asm };
}

describe('Register allocation — correctness', () => {
  const programs = [
    ['simple let', 'let x = 42; puts(x)', '42'],
    ['two variables', 'let x = 3; let y = 4; puts(x + y)', '7'],
    ['compound expr', 'let x = 2 + 3; let y = x * 2; puts(y)', '10'],
    ['set mutation', 'let x = 1; set x = x + 1; puts(x)', '2'],
    ['boolean', 'let x = true; puts(x)', '1'],
    ['comparison', 'let x = 5; puts(x > 3)', '1'],
    ['if/else', 'let x = 10; if (x > 5) { puts(1) } else { puts(0) }', '1'],
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
    ['GCD', `
      let gcd = fn(a, b) { if (b == 0) { return a }; return gcd(b, a % b) }
      puts(gcd(48, 18))
    `, '6'],
    ['sum 1..100', `
      let s = 0; let i = 1
      while (i <= 100) { set s = s + i; set i = i + 1 }
      puts(s)
    `, '5050'],
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
    ['multiple functions', `
      let square = fn(x) { return x * x }
      let double = fn(x) { return x + x }
      puts(square(5))
      puts(double(7))
      puts(square(double(3)))
    `, '251436'],
  ];

  for (const [name, code, expected] of programs) {
    it(`${name} — correct output with registers`, () => {
      const result = compileAndRun(code, { useRegisters: true });
      assert.equal(result.output, expected, `Expected '${expected}', got '${result.output}'`);
    });

    it(`${name} — matches stack-based output`, () => {
      const stack = compileAndRun(code, { useRegisters: false });
      const reg = compileAndRun(code, { useRegisters: true });
      assert.equal(reg.output, stack.output);
    });
  }
});

describe('Register allocation — performance', () => {
  it('uses callee-saved registers', () => {
    const program = parse('let x = 1; let y = 2; puts(x + y)');
    const codegen = new RiscVCodeGen({ useRegisters: true });
    const asm = codegen.compile(program);
    assert.ok(asm.includes('mv s1, a0') || asm.includes('mv s1,'), `Should use s1, got:\n${asm}`);
  });

  it('saves/restores used registers in prologue/epilogue', () => {
    const program = parse('let x = 1; puts(x)');
    const codegen = new RiscVCodeGen({ useRegisters: true });
    const asm = codegen.compile(program);
    assert.ok(asm.includes('sw s1'), `Should save s1`);
    assert.ok(asm.includes('lw s1'), `Should restore s1`);
  });

  const benchmarks = [
    ['sum 1..100', 'let s=0; let i=1; while(i<=100){set s=s+i; set i=i+1}; puts(s)'],
    ['fib(10)', 'let fib=fn(n){if(n<=1){return n}; return fib(n-1)+fib(n-2)}; puts(fib(10))'],
    ['fact(10)', 'let fact=fn(n){if(n<=1){return 1}; return n*fact(n-1)}; puts(fact(10))'],
    ['prime sieve', `
      let is_prime=fn(n){if(n<2){return 0}; let i=2; while(i*i<=n){if(n%i==0){return 0}; set i=i+1}; return 1}
      let n=2; while(n<=30){if(is_prime(n)==1){puts(n)}; set n=n+1}
    `],
  ];

  it('reports cycle improvements', { skip: 'heap overflow in benchmark — needs GC' }, () => {
    for (const [name, code] of benchmarks) {
      const stack = compileAndRun(code, { useRegisters: false });
      const reg = compileAndRun(code, { useRegisters: true });
      const both = compileAndRun(code, { useRegisters: true, optimize: true });
      const savedReg = stack.cycles - reg.cycles;
      const savedBoth = stack.cycles - both.cycles;
      console.log(`  ${name}:`);
      console.log(`    stack: ${stack.cycles} | reg: ${reg.cycles} (${savedReg > 0 ? '-' : '+'}${Math.abs(savedReg)}) | reg+peep: ${both.cycles} (${savedBoth > 0 ? '-' : '+'}${Math.abs(savedBoth)})`);
    }
  });
});
