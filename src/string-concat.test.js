// string-concat.test.js — String concatenation tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function run(input) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  const typeInfo = inferTypes(prog);
  const cg = new RiscVCodeGen();
  const asm = cg.compile(prog, typeInfo);
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(500000);
  return cpu.output.join('');
}

describe('String concatenation', () => {
  it('two literals', () => {
    assert.equal(run('puts("hello" + " world")'), 'hello world');
  });

  it('three literals (chained)', () => {
    assert.equal(run('puts("a" + "b" + "c")'), 'abc');
  });

  it('variable + literal', () => {
    assert.equal(run('let s = "hello"; puts(s + "!")'), 'hello!');
  });

  it('variable + variable', () => {
    assert.equal(run('let a = "foo"; let b = "bar"; puts(a + b)'), 'foobar');
  });

  it('empty string concat', () => {
    assert.equal(run('puts("" + "hello")'), 'hello');
  });

  it('concat result assigned to variable', () => {
    assert.equal(run('let msg = "hi" + " there"; puts(msg)'), 'hi there');
  });

  it('concat in function with type inference', () => {
    assert.equal(run(`
      let greet = fn(name) { puts("Hello, " + name + "!") }
      greet("Alice")
    `), 'Hello, Alice!');
  });

  it('concat len', () => {
    assert.equal(run('let s = "abc" + "de"; puts(len(s))'), '5');
  });

  it('multiple concats in sequence', () => {
    assert.equal(run('puts("a" + "b"); puts("c" + "d")'), 'abcd');
  });

  it('concat preserves originals', () => {
    assert.equal(run(`
      let a = "hello"
      let b = " world"
      let c = a + b
      puts(a)
      puts(b)
      puts(c)
    `), 'hello worldhello world');
  });

  it('integer addition still works', () => {
    assert.equal(run('puts(3 + 4)'), '7');
  });

  it('mixed: int and string in same program', () => {
    assert.equal(run('puts("sum: "); puts(3 + 4)'), 'sum: 7');
  });
});
