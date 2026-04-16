// string-ops.test.js — String equality + indexing tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function run(input) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  const typeInfo = inferTypes(prog);
  const closureInfo = analyzeFreeVars(prog);
  const cg = new RiscVCodeGen();
  const asm = cg.compile(prog, typeInfo, closureInfo);
  if (cg.errors.length > 0) throw new Error(`Codegen: ${cg.errors.join(', ')}`);
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(500000);
  return cpu.output.join('');
}

describe('String equality', () => {
  it('equal strings (literal)', () => {
    assert.equal(run('puts("hello" == "hello")'), '1');
  });

  it('unequal strings (literal)', () => {
    assert.equal(run('puts("hello" == "world")'), '0');
  });

  it('string != (not equal)', () => {
    assert.equal(run('puts("abc" != "def")'), '1');
  });

  it('string != (equal)', () => {
    assert.equal(run('puts("abc" != "abc")'), '0');
  });

  it('different lengths', () => {
    assert.equal(run('puts("ab" == "abc")'), '0');
  });

  it('empty strings equal', () => {
    assert.equal(run('puts("" == "")'), '1');
  });

  it('empty vs non-empty', () => {
    assert.equal(run('puts("" == "x")'), '0');
  });

  it('variable comparison', () => {
    assert.equal(run('let a = "test"; let b = "test"; puts(a == b)'), '1');
  });

  it('variable comparison (different)', () => {
    assert.equal(run('let a = "foo"; let b = "bar"; puts(a == b)'), '0');
  });

  it('comparison in if', () => {
    assert.equal(run('let cmd = "quit"; if (cmd == "quit") { puts(1) } else { puts(0) }'), '1');
  });

  it('comparison in if (false)', () => {
    assert.equal(run('let cmd = "run"; if (cmd == "quit") { puts(1) } else { puts(0) }'), '0');
  });

  it('concat then compare', () => {
    assert.equal(run('let s = "hel" + "lo"; puts(s == "hello")'), '1');
  });
});

describe('String indexing', () => {
  it('first character code', () => {
    // 'h' = 104
    assert.equal(run('puts("hello"[0])'), '104');
  });

  it('second character code', () => {
    // 'e' = 101
    assert.equal(run('puts("hello"[1])'), '101');
  });

  it('with variable', () => {
    assert.equal(run('let s = "ABC"; puts(s[0])'), '65');
  });

  it('iterate string chars', () => {
    assert.equal(run(`
      let s = "hi"
      let i = 0
      while (i < len(s)) {
        puts(s[i])
        puts(" ")
        set i = i + 1
      }
    `), '104 105 ');
  });
});

describe('String operations — advanced', () => {
  it('empty string comparison', () => { assert.equal(run('puts("" == "")'), '1'); });
  it('string not equal', () => { assert.equal(run('puts("abc" != "def")'), '1'); });
  it('string in hash key', () => { assert.equal(run('let h = {"hello": 42}; puts(h["hello"])'), '42'); });
  it('long string equality', () => { assert.equal(run('puts("abcdefghij" == "abcdefghij")'), '1'); });
  it('long string inequality', () => { assert.equal(run('puts("abcdefghij" == "abcdefghik")'), '0'); });
  it('string length after concat', () => { assert.equal(run('let s = "abc" + "def"; puts(len(s))'), '6'); });
  it('string from function', () => { assert.equal(run('let f = fn() { "result" }; puts(f())'), 'result'); });
});
