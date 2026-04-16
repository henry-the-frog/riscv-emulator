// heap-arrays.test.js — Tests for heap-allocated arrays in RISC-V codegen
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { peepholeOptimize } from './riscv-peephole.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function run(input, { useRegisters = false, optimize = false } = {}) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(`Parse: ${p.errors.join('\n')}`);
  const cg = new RiscVCodeGen({ useRegisters });
  let asm = cg.compile(prog);
  if (optimize) asm = peepholeOptimize(asm).optimized;
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(500000);
  return cpu.output.join('');
}

describe('Heap — bump allocator', () => {
  it('initializes gp register', () => {
    const p = new Parser(new Lexer('let arr = [1]'));
    const cg = new RiscVCodeGen();
    const asm = cg.compile(p.parseProgram());
    assert.ok(asm.includes('li gp, 65536'));
  });

  it('multiple allocations use different heap addresses', () => {
    const output = run(`
      let a = [10, 20]
      let b = [30, 40]
      puts(a[0])
      puts(b[0])
    `);
    assert.equal(output, '1030');
  });
});

describe('Array literals', () => {
  it('empty array', () => {
    const output = run('let arr = []; puts(len(arr))');
    assert.equal(output, '0');
  });

  it('single element', () => {
    const output = run('let arr = [42]; puts(arr[0])');
    assert.equal(output, '42');
  });

  it('three elements', () => {
    const output = run('let arr = [10, 20, 30]; puts(arr[0]); puts(arr[1]); puts(arr[2])');
    assert.equal(output, '102030');
  });

  it('computed elements', () => {
    const output = run('let x = 5; let arr = [x, x * 2, x * 3]; puts(arr[1])');
    assert.equal(output, '10');
  });

  it('nested expressions in array', () => {
    const output = run('let arr = [1 + 2, 3 * 4, 10 - 3]; puts(arr[0]); puts(arr[1]); puts(arr[2])');
    assert.equal(output, '3127');
  });
});

describe('Array indexing', () => {
  it('index 0', () => {
    assert.equal(run('puts([100, 200, 300][0])'), '100');
  });

  it('index 1', () => {
    assert.equal(run('puts([100, 200, 300][1])'), '200');
  });

  it('index 2', () => {
    assert.equal(run('puts([100, 200, 300][2])'), '300');
  });

  it('computed index', () => {
    const output = run('let arr = [10, 20, 30]; let i = 1; puts(arr[i])');
    assert.equal(output, '20');
  });

  it('index in loop', () => {
    const output = run(`
      let arr = [1, 2, 3, 4, 5]
      let sum = 0
      let i = 0
      while (i < 5) {
        set sum = sum + arr[i]
        set i = i + 1
      }
      puts(sum)
    `);
    assert.equal(output, '15');
  });
});

describe('len() builtin', () => {
  it('len of empty array', () => {
    assert.equal(run('puts(len([]))'), '0');
  });

  it('len of 3-element array', () => {
    assert.equal(run('puts(len([1, 2, 3]))'), '3');
  });

  it('len of variable array', () => {
    assert.equal(run('let arr = [10, 20, 30, 40, 50]; puts(len(arr))'), '5');
  });
});

describe('Arrays with functions', () => {
  it('array as function argument', () => {
    const output = run(`
      let sum_arr = fn(arr, n) {
        let s = 0
        let i = 0
        while (i < n) {
          set s = s + arr[i]
          set i = i + 1
        }
        return s
      }
      let data = [3, 7, 11, 5, 2]
      puts(sum_arr(data, 5))
    `);
    assert.equal(output, '28');
  });

  it('function returning array (via variable)', () => {
    const output = run(`
      let make_pair = fn(a, b) {
        let arr = [a, b]
        return arr
      }
      let p = make_pair(10, 20)
      puts(p[0])
      puts(p[1])
    `);
    assert.equal(output, '1020');
  });

  it('array of results from function calls', () => {
    const output = run(`
      let double = fn(x) { return x * 2 }
      let results = [double(1), double(2), double(3)]
      puts(results[0])
      puts(results[1])
      puts(results[2])
    `);
    assert.equal(output, '246');
  });
});

describe('Arrays — register mode', () => {
  it('basic array (register mode)', () => {
    assert.equal(run('let arr = [10, 20, 30]; puts(arr[1])', { useRegisters: true }), '20');
  });

  it('array sum (register mode)', () => {
    const output = run(`
      let arr = [1, 2, 3, 4, 5]
      let sum = 0
      let i = 0
      while (i < 5) {
        set sum = sum + arr[i]
        set i = i + 1
      }
      puts(sum)
    `, { useRegisters: true });
    assert.equal(output, '15');
  });

  it('array with peephole', () => {
    assert.equal(run('let arr = [10, 20, 30]; puts(arr[2])', { useRegisters: true, optimize: true }), '30');
  });
});

describe('Arrays — complex programs', () => {
  it('find max in array', () => {
    const output = run(`
      let find_max = fn(arr, n) {
        let max = arr[0]
        let i = 1
        while (i < n) {
          if (arr[i] > max) { set max = arr[i] }
          set i = i + 1
        }
        return max
      }
      puts(find_max([3, 7, 2, 9, 4], 5))
    `);
    assert.equal(output, '9');
  });

  it('dot product', () => {
    const output = run(`
      let dot = fn(a, b, n) {
        let sum = 0
        let i = 0
        while (i < n) {
          set sum = sum + a[i] * b[i]
          set i = i + 1
        }
        return sum
      }
      puts(dot([1, 2, 3], [4, 5, 6], 3))
    `);
    assert.equal(output, '32');
  });

  it('multiple arrays', () => {
    const output = run(`
      let a = [1, 2, 3]
      let b = [10, 20, 30]
      let c = [100, 200, 300]
      puts(a[0] + b[1] + c[2])
    `);
    assert.equal(output, '321');
  });

  it('array used in conditional', () => {
    const output = run(`
      let flags = [0, 1, 0, 1, 1]
      let count = 0
      let i = 0
      while (i < 5) {
        if (flags[i] == 1) { set count = count + 1 }
        set i = i + 1
      }
      puts(count)
    `);
    assert.equal(output, '3');
  });
});

describe('Array operations — advanced', () => {
  it('array of arrays', () => {
    assert.equal(run('let m = [[1,2],[3,4]]; puts(m[0][0]); puts(m[1][1])'), '14');
  });
  it('push multiple times', () => {
    assert.equal(run('let a = push(push(push([], 10), 20), 30); puts(a[0]); puts(a[2])'), '1030');
  });
  it('first of singleton', () => {
    assert.equal(run('puts(first([42]))'), '42');
  });
  it('last of singleton', () => {
    assert.equal(run('puts(last([99]))'), '99');
  });
  it('array length after push', () => {
    assert.equal(run('let a = push([1,2,3], 4); puts(len(a))'), '4');
  });
  it('array in hash value', () => {
    assert.equal(run('let h = {"data": [10, 20, 30]}; puts(h["data"][1])'), '20');
  });
});

describe('Array operations — extensive', () => {
  it('nested array access', () => { assert.equal(run('puts([[1,2],[3,4]][1][0])'), '3'); });
  it('push preserves original', () => { assert.equal(run('let a = [1,2]; let b = push(a, 3); puts(len(a)); puts(len(b))'), '23'); });
  it('empty array length', () => { assert.equal(run('puts(len([]))'), '0'); });
  it('single element array', () => { assert.equal(run('let a = [42]; puts(first(a)); puts(last(a))'), '4242'); });
  it('array in function', () => { assert.equal(run('let f = fn() { [1,2,3] }; let a = f(); puts(a[1])'), '2'); });
  it('array element arithmetic', () => { assert.equal(run('let a = [10,20]; puts(a[0] + a[1])'), '30'); });
  it('range to array', () => { assert.equal(run('let a = 1..6; puts(len(a)); puts(a[2])'), '53'); });
  it('slice preserves values', () => { assert.equal(run('let a = [1,2,3,4,5]; let s = a[1:4]; puts(s[0]); puts(s[2])'), '24'); });
  it('array comparison', () => { assert.equal(run('puts(len([1,2,3]) == 3)'), '1'); });
  it('array in conditional', () => { assert.equal(run('let a = [1]; if (len(a) > 0) { puts(1) } else { puts(0) }'), '1'); });
});
