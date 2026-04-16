// self-hosting.test.js — Complex real-world programs compiled to RISC-V
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { peepholeOptimize } from './riscv-peephole.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function run(input, { useRegisters = false, optimize = false } = {}) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  const typeInfo = inferTypes(prog);
  const closureInfo = analyzeFreeVars(prog);
  const cg = new RiscVCodeGen({ useRegisters });
  let asm = cg.compile(prog, typeInfo, closureInfo);
  if (cg.errors.length > 0) throw new Error(`Codegen: ${cg.errors.join(', ')}`);
  if (optimize) asm = peepholeOptimize(asm).optimized;
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(5000000);
  return { output: cpu.output.join(''), cycles: cpu.cycles };
}

describe('Self-hosting: Complex programs on RISC-V', () => {
  it('Expression evaluator', () => {
    const { output } = run(`
      let a = 3
      let b = 4
      let sum = a + b
      let c = 5
      let result = sum * c
      puts(result)
    `);
    assert.equal(output, '35');
  });

  it('Linked list traversal', () => {
    const { output } = run(`
      let nodes = [10, 2, 20, 4, 30, 6, 40, -1]
      let sum = 0
      let idx = 0
      while (idx != -1) {
        let val = nodes[idx]
        set sum = sum + val
        set idx = nodes[idx + 1]
      }
      puts(sum)
    `);
    assert.equal(output, '100');
  });

  it('Matrix multiplication (2x2)', () => {
    const { output } = run(`
      let A = [1, 2, 3, 4]
      let B = [5, 6, 7, 8]
      let mat_mul = fn(a, b) {
        let c00 = a[0] * b[0] + a[1] * b[2]
        let c01 = a[0] * b[1] + a[1] * b[3]
        let c10 = a[2] * b[0] + a[3] * b[2]
        let c11 = a[2] * b[1] + a[3] * b[3]
        return [c00, c01, c10, c11]
      }
      let C = mat_mul(A, B)
      puts(C[0])
      puts(" ")
      puts(C[1])
      puts(" ")
      puts(C[2])
      puts(" ")
      puts(C[3])
    `);
    assert.equal(output, '19 22 43 50');
  });

  it('Find min and max', () => {
    const { output } = run(`
      let find_min = fn(arr, n) {
        let min = arr[0]
        let i = 1
        while (i < n) {
          if (arr[i] < min) { set min = arr[i] }
          set i = i + 1
        }
        return min
      }
      let find_max = fn(arr, n) {
        let max = arr[0]
        let i = 1
        while (i < n) {
          if (arr[i] > max) { set max = arr[i] }
          set i = i + 1
        }
        return max
      }
      let data = [38, 27, 43, 3, 9, 82, 10]
      puts("min=")
      puts(find_min(data, 7))
      puts(" max=")
      puts(find_max(data, 7))
    `);
    assert.ok(output.includes('min=3'));
    assert.ok(output.includes('max=82'));
  });

  it('Performance: fib(15) optimized', () => {
    const { output, cycles } = run(`
      let fib = fn(n) {
        if (n <= 1) { return n }
        return fib(n - 1) + fib(n - 2)
      }
      puts(fib(15))
    `, { useRegisters: true, optimize: true });
    assert.equal(output, '610');
    console.log(`  fib(15): ${cycles} cycles (optimized)`);
  });

  it('Collatz conjecture checker', () => {
    const { output } = run(`
      let collatz = fn(n) {
        let steps = 0
        while (n != 1) {
          if (n % 2 == 0) {
            set n = n / 2
          } else {
            set n = 3 * n + 1
          }
          set steps = steps + 1
        }
        return steps
      }
      let max_steps = 0
      let max_n = 0
      let i = 1
      while (i <= 20) {
        let steps = collatz(i)
        if (steps > max_steps) {
          set max_steps = steps
          set max_n = i
        }
        set i = i + 1
      }
      puts("longest: n=")
      puts(max_n)
      puts(" steps=")
      puts(max_steps)
    `);
    assert.ok(output.includes('longest: n='));
    assert.ok(output.includes('steps='));
  });

  it('Bubble sort on small array', () => {
    const { output } = run(`
      let sort3 = fn(a, b, c) {
        if (a > b) { let t = a; set a = b; set b = t }
        if (b > c) { let t = b; set b = c; set c = t }
        if (a > b) { let t = a; set a = b; set b = t }
        puts(a)
        puts(" ")
        puts(b)
        puts(" ")
        puts(c)
      }
      sort3(30, 10, 20)
    `);
    assert.equal(output, '10 20 30');
  });

  it('Closure with captured array', () => {
    const { output } = run(`
      let data = [5, 10, 15, 20, 25]
      let sum_data = fn() {
        let s = 0
        let i = 0
        while (i < 5) {
          set s = s + data[i]
          set i = i + 1
        }
        return s
      }
      puts(sum_data())
    `);
    assert.equal(output, '75');
  });

  it('Greeting formatter with closures + strings + arrays', () => {
    const { output } = run(`
      let prefix = "Hello, "
      let greet = fn(name) { puts(prefix + name + "!") }
      let names = ["Alice", "Bob", "Charlie"]
      for (name in names) {
        greet(name)
      }
    `);
    assert.ok(output.includes('Hello, Alice!'));
    assert.ok(output.includes('Hello, Bob!'));
    assert.ok(output.includes('Hello, Charlie!'));
  });
});
