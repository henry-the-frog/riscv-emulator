// forin-builtins.test.js — for-in loops and array builtins for RISC-V codegen
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function run(input, opts = {}) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(`Parse: ${p.errors.join('\n')}`);
  const cg = new RiscVCodeGen(opts);
  const asm = cg.compile(prog);
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(500000);
  return cpu.output.join('');
}

describe('for-in loops', () => {
  it('iterates array elements', () => {
    assert.equal(run('let arr = [10, 20, 30]; for (x in arr) { puts(x) }'), '102030');
  });

  it('sum with for-in', () => {
    assert.equal(run('let arr = [1, 2, 3, 4, 5]; let s = 0; for (x in arr) { set s = s + x }; puts(s)'), '15');
  });

  it('for-in with empty array', () => {
    assert.equal(run('for (x in []) { puts(x) }; puts(0)'), '0');
  });

  it('for-in with single element', () => {
    assert.equal(run('for (x in [42]) { puts(x) }'), '42');
  });

  it('for-in with computed array', () => {
    assert.equal(run('let a = 10; for (x in [a, a*2, a*3]) { puts(x) }'), '102030');
  });

  it('nested for-in (outer array)', () => {
    assert.equal(run(`
      let sum = 0
      for (x in [1, 2, 3]) {
        for (y in [10, 20]) {
          set sum = sum + x * y
        }
      }
      puts(sum)
    `), '180');
  });

  it('for-in with if in body', () => {
    assert.equal(run(`
      for (x in [1, 2, 3, 4, 5, 6]) {
        if (x % 2 == 0) { puts(x) }
      }
    `), '246');
  });

  it('for-in with variable array', () => {
    assert.equal(run('let data = [5, 10, 15, 20]; let count = 0; for (v in data) { if (v > 10) { set count = count + 1 } }; puts(count)'), '2');
  });

  it('for-in in register mode', () => {
    assert.equal(run('for (x in [7, 8, 9]) { puts(x) }', { useRegisters: true }), '789');
  });
});

describe('first() builtin', () => {
  it('first of array', () => {
    assert.equal(run('puts(first([10, 20, 30]))'), '10');
  });

  it('first of single element', () => {
    assert.equal(run('puts(first([42]))'), '42');
  });
});

describe('last() builtin', () => {
  it('last of array', () => {
    assert.equal(run('puts(last([10, 20, 30]))'), '30');
  });

  it('last of single element', () => {
    assert.equal(run('puts(last([99]))'), '99');
  });
});

describe('push() builtin', () => {
  it('push to array', () => {
    assert.equal(run('let a = [1, 2]; let b = push(a, 3); puts(len(b))'), '3');
  });

  it('push preserves original', () => {
    assert.equal(run('let a = [1, 2]; let b = push(a, 3); puts(len(a)); puts(len(b))'), '23');
  });

  it('push creates correct array', () => {
    assert.equal(run('let a = push([10, 20], 30); puts(a[0]); puts(a[1]); puts(a[2])'), '102030');
  });

  it('push empty array', () => {
    assert.equal(run('let a = push([], 42); puts(a[0]); puts(len(a))'), '421');
  });

  it('chained push', () => {
    assert.equal(run('let a = push(push(push([], 1), 2), 3); for (x in a) { puts(x) }'), '123');
  });

  it('build array with push loop', () => {
    assert.equal(run(`
      let arr = []
      let i = 0
      while (i < 5) {
        set arr = push(arr, i * i)
        set i = i + 1
      }
      for (x in arr) { puts(x) }
    `), '014916');
  });
});

describe('Combined array operations', () => {
  it('map-like pattern', () => {
    assert.equal(run(`
      let double = fn(x) { return x * 2 }
      let input = [1, 2, 3, 4, 5]
      let output = []
      for (x in input) {
        set output = push(output, double(x))
      }
      for (y in output) { puts(y) }
    `), '246810');
  });

  it('filter-like pattern', () => {
    assert.equal(run(`
      let evens = []
      for (x in [1, 2, 3, 4, 5, 6, 7, 8]) {
        if (x % 2 == 0) {
          set evens = push(evens, x)
        }
      }
      puts(len(evens))
      for (e in evens) { puts(e) }
    `), '42468');
  });

  it('reduce-like pattern', () => {
    assert.equal(run(`
      let sum = fn(arr, n) {
        let s = 0
        let i = 0
        while (i < n) {
          set s = s + arr[i]
          set i = i + 1
        }
        return s
      }
      puts(sum([10, 20, 30, 40], 4))
    `), '100');
  });

  it('fibonacci sequence via arrays', () => {
    assert.equal(run(`
      let fibs = [0, 1]
      let i = 2
      while (i < 10) {
        let next = fibs[i - 1] + fibs[i - 2]
        set fibs = push(fibs, next)
        set i = i + 1
      }
      for (f in fibs) { puts(f) }
    `), '0112358132134');
  });
});

describe('For-in — advanced', () => {
  it('for-in with function call', () => {
    assert.equal(run('let double = fn(x) { x * 2 }; let arr = [1,2,3]; for (x in arr) { puts(double(x)) }'), '246');
  });
  it('for-in accumulate string', () => {
    assert.equal(run('let words = ["Hello", " ", "World"]; for (w in words) { puts(w) }'), 'Hello World');
  });
  it('nested for-in counts', () => {
    assert.equal(run('let c = 0; for (i in [1,2]) { for (j in [1,2,3]) { set c = c + 1 } }; puts(c)'), '6');
  });
});

describe('Builtin operations — extensive', () => {
  it('push creates new array', () => { assert.equal(run('let a = push([1], 2); let b = push(a, 3); puts(b[0]); puts(b[1]); puts(b[2])'), '123'); });
  it('first of range', () => { assert.equal(run('puts(first(1..10))'), '1'); });
  it('last of range', () => { assert.equal(run('puts(last(1..10))'), '9'); });
  it('len of empty', () => { assert.equal(run('puts(len([]))'), '0'); });
  it('len of pushed', () => { assert.equal(run('puts(len(push(push([], 1), 2)))'), '2'); });
  it('first after push', () => { assert.equal(run('puts(first(push([5], 10)))'), '5'); });
  it('last after push', () => { assert.equal(run('puts(last(push([5], 10)))'), '10'); });
});
