// GC stress tests for RISC-V backend
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

function run(input, maxCycles = 500000, heapSize = 0x10000) {
  const program = parse(input);
  const codegen = new RiscVCodeGen({ heapSize });
  const asm = codegen.compile(program, inferTypes(program), analyzeFreeVars(program));
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Assembly errors: ${result.errors.map(e => e.message || e).join('\n')}`);
  }
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4); // sp
  cpu.run(maxCycles);
  return {
    output: cpu.output.join(''),
    gcCollections: cpu.gcCollections || 0,
    cycles: cpu.cycles
  };
}

describe('GC - basic functionality', () => {
  it('no GC needed for small programs', () => {
    const result = run('puts(42);');
    assert.equal(result.output, '42');
    assert.equal(result.gcCollections, 0);
  });

  it('string allocation without GC', () => {
    const result = run('let s = "hello"; puts(s);');
    assert.equal(result.output, 'hello');
    assert.equal(result.gcCollections, 0);
  });

  it('array allocation without GC', () => {
    const result = run('let a = [1, 2, 3]; puts(a[0]); puts(a[2]);');
    assert.equal(result.output, '13');
    assert.equal(result.gcCollections, 0);
  });
});

describe('GC - programs that should survive GC', () => {
  it('many string allocations (GC should reclaim dead strings)', () => {
    // With small heap, this would need GC
    const result = run(`
      let result = 0;
      let i = 0;
      while (i < 50) {
        let s = "test";
        set result = result + len(s);
        set i = i + 1;
      }
      puts(result);
    `, 2000000);
    assert.equal(result.output, '200');
  });

  it('long-lived variable survives GC', () => {
    // 'keep' should survive while temp strings are collected
    const result = run(`
      let keep = "alive";
      let i = 0;
      while (i < 20) {
        let temp = "dead";
        set i = i + 1;
      }
      puts(keep);
    `, 1000000);
    assert.equal(result.output, 'alive');
  });

  it('array survives GC', () => {
    const result = run(`
      let arr = [10, 20, 30];
      let i = 0;
      while (i < 10) {
        let temp = [1, 2, 3, 4, 5];
        set i = i + 1;
      }
      puts(arr[0]);
      puts(arr[1]);
      puts(arr[2]);
    `, 1000000);
    assert.equal(result.output, '102030');
  });

  it('closure captures survive GC', () => {
    const result = run(`
      let make = fn(x) {
        fn() { x }
      };
      let getter = make(42);
      let i = 0;
      while (i < 5) {
        let temp = "garbage";
        set i = i + 1;
      }
      puts(getter());
    `, 1000000);
    assert.equal(result.output, '42');
  });
});

describe('GC - functional correctness', () => {
  it('fibonacci with GC pressure', () => {
    const result = run(`
      let fib = fn(n) {
        if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }
      };
      puts(fib(10));
    `, 5000000);
    assert.equal(result.output, '55');
  });

  it('push creates new arrays (old ones should be collected)', () => {
    const result = run(`
      let arr = [];
      let i = 0;
      while (i < 10) {
        set arr = push(arr, i);
        set i = i + 1;
      }
      puts(len(arr));
      puts(arr[0]);
      puts(arr[9]);
    `, 2000000);
    assert.equal(result.output, '1009');
  });

  it('string concatenation with GC', () => {
    const result = run(`
      let s = "";
      let i = 0;
      while (i < 5) {
        set s = s + "a";
        set i = i + 1;
      }
      puts(len(s));
    `, 2000000);
    assert.equal(result.output, '5');
  });
});

describe('GC - edge cases', () => {
  it('empty heap after all temps collected', () => {
    const result = run(`
      let i = 0;
      while (i < 20) {
        let a = [i, i + 1, i + 2];
        set i = i + 1;
      }
      puts(i);
    `, 2000000);
    assert.equal(result.output, '20');
  });

  it('nested closures survive', () => {
    const result = run(`
      let adder = fn(x) { fn(y) { x + y } };
      let add5 = adder(5);
      let add10 = adder(10);
      puts(add5(3));
      puts(add10(3));
    `, 1000000);
    assert.equal(result.output, '813');
  });

  it('hash allocation and access', () => {
    const result = run(`
      let h = {"a": 1, "b": 2};
      puts(h["a"]);
      puts(h["b"]);
    `, 500000);
    assert.equal(result.output, '12');
  });
});
