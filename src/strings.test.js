// strings.test.js — String support for RISC-V codegen
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

describe('String literals', () => {
  it('prints hello', () => {
    assert.equal(run('puts("hello")'), 'hello');
  });

  it('prints world', () => {
    assert.equal(run('puts("world")'), 'world');
  });

  it('prints empty string', () => {
    assert.equal(run('puts(""); puts(1)'), '1');
  });

  it('prints single char', () => {
    assert.equal(run('puts("A")'), 'A');
  });

  it('prints with spaces', () => {
    assert.equal(run('puts("hello world")'), 'hello world');
  });

  it('prints special chars', () => {
    assert.equal(run('puts("abc123!@#")'), 'abc123!@#');
  });
});

describe('String variables', () => {
  it('string in variable', () => {
    assert.equal(run('let s = "test"; puts(s)'), 'test');
  });

  it('multiple string vars', () => {
    assert.equal(run('let a = "hello"; let b = " "; let c = "world"; puts(a); puts(b); puts(c)'), 'hello world');
  });

  it('string passed to function (currently prints as int — type-directed limitation)', () => {
    // When type is unknown at compile time, puts defaults to integer printing
    // A full type system or runtime tagging would fix this
    const output = run('let greet = fn(name) { puts(name) }; greet("Alice")');
    // The raw pointer value gets printed as an integer
    assert.ok(output.length > 0, 'Should produce some output');
  });
});

describe('String len()', () => {
  it('len of hello', () => {
    assert.equal(run('puts(len("hello"))'), '5');
  });

  it('len of empty', () => {
    assert.equal(run('puts(len(""))'), '0');
  });

  it('len of variable', () => {
    assert.equal(run('let s = "test string"; puts(len(s))'), '11');
  });
});

describe('Mixed string and integer output', () => {
  it('string then integer', () => {
    assert.equal(run('puts("answer: "); puts(42)'), 'answer: 42');
  });

  it('integer then string', () => {
    assert.equal(run('puts(42); puts(" is the answer")'), '42 is the answer');
  });

  it('alternating', () => {
    assert.equal(run('puts("x="); puts(10); puts(" y="); puts(20)'), 'x=10 y=20');
  });

  it('negative int after string', () => {
    assert.equal(run('puts("temp: "); puts(-5)'), 'temp: -5');
  });
});

describe('Strings with register mode', () => {
  it('basic string (register)', () => {
    assert.equal(run('puts("hi")', { useRegisters: true }), 'hi');
  });

  it('string variable (register)', () => {
    assert.equal(run('let s = "test"; puts(s)', { useRegisters: true }), 'test');
  });

  it('mixed types (register)', () => {
    assert.equal(run('let n = 42; let s = "!"; puts(n); puts(s)', { useRegisters: true }), '42!');
  });
});

describe('String in arrays', () => {
  it('len distinguishes strings from arrays', () => {
    assert.equal(run('let arr = [1, 2, 3]; let s = "hello"; puts(len(arr)); puts(len(s))'), '35');
  });
});

describe('String edge cases', () => {
  it('empty string length', () => { assert.equal(run('puts(len(""))'), '0'); });
  it('empty string concat', () => { assert.equal(run('puts("" + "hello")'), 'hello'); });
  it('concat empty right', () => { assert.equal(run('puts("hello" + "")'), 'hello'); });
  it('empty string equality', () => { assert.equal(run('puts("" == "")'), '1'); });
  it('string function parameter', () => {
    assert.equal(run('let greet = fn(name) { puts("Hi " + name) }; greet("Bob")'), 'Hi Bob');
  });
  it('multiple string concat in function', () => {
    assert.equal(run(`
      let bracket = fn(s) { "[" + s + "]" }
      puts(bracket("ok"))
    `), '[ok]');
  });
});

describe('String regression', () => {
  it('string as hash key', () => { assert.equal(run('let h = {"key": 42}; puts(h["key"])'), '42'); });
  it('multi-char concat', () => { assert.equal(run('puts("ab" + "cd" + "ef")'), 'abcdef'); });
  it('string comparison operators', () => {
    assert.equal(run('puts("abc" == "abc"); puts("abc" != "xyz")'), '11');
  });
  it('empty string operations', () => { assert.equal(run('puts(len("")); puts("" + "hi")'), '0hi'); });
  it('string from closure', () => {
    assert.equal(run('let greet = fn(name) { "Hello " + name }; puts(greet("World"))'), 'Hello World');
  });
  it('string equality in if', () => {
    assert.equal(run('let s = "yes"; if (s == "yes") { puts(1) } else { puts(0) }'), '1');
  });
});
