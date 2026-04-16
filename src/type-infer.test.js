// type-infer.test.js — Tests for type inference + codegen integration
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferTypes } from './type-infer.js';
import { RiscVCodeGen } from './monkey-codegen.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  return prog;
}

function runWithInference(input) {
  const prog = parse(input);
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

describe('Type inference — basic', () => {
  it('infers int type for integer literal', () => {
    const types = inferTypes(parse('let x = 42'));
    assert.equal(types.varTypes.get('x'), 'int');
  });

  it('infers string type for string literal', () => {
    const types = inferTypes(parse('let s = "hello"'));
    assert.equal(types.varTypes.get('s'), 'string');
  });

  it('infers array type for array literal', () => {
    const types = inferTypes(parse('let arr = [1, 2, 3]'));
    assert.equal(types.varTypes.get('arr'), 'array');
  });

  it('infers function parameter types from call sites', () => {
    const types = inferTypes(parse('let f = fn(x) { puts(x) }; f("hello")'));
    assert.equal(types.funcTypes.get('f').params.get('x'), 'string');
  });

  it('infers int parameter from int argument', () => {
    const types = inferTypes(parse('let f = fn(n) { puts(n) }; f(42)'));
    assert.equal(types.funcTypes.get('f').params.get('n'), 'int');
  });

  it('infers multiple parameter types', () => {
    const types = inferTypes(parse('let f = fn(name, age) { puts(name); puts(age) }; f("Alice", 30)'));
    const params = types.funcTypes.get('f').params;
    assert.equal(params.get('name'), 'string');
    assert.equal(params.get('age'), 'int');
  });

  it('infers array parameter', () => {
    const types = inferTypes(parse('let sum = fn(arr) { puts(arr) }; sum([1, 2, 3])'));
    assert.equal(types.funcTypes.get('sum').params.get('arr'), 'array');
  });
});

describe('Type inference — codegen integration', () => {
  it('string parameter printed correctly', () => {
    assert.equal(runWithInference('let greet = fn(name) { puts(name) }; greet("Alice")'), 'Alice');
  });

  it('int parameter printed correctly', () => {
    assert.equal(runWithInference('let show = fn(n) { puts(n) }; show(42)'), '42');
  });

  it('multiple typed parameters', () => {
    assert.equal(runWithInference(`
      let describe = fn(name, age) { puts(name); puts(age) }
      describe("Bob", 25)
    `), 'Bob25');
  });

  it('string variable in function', () => {
    assert.equal(runWithInference(`
      let print_msg = fn(msg) { puts(msg) }
      let message = "hello world"
      print_msg(message)
    `), 'hello world');
  });

  it('existing integer programs still work', () => {
    assert.equal(runWithInference('let x = 3; let y = 4; puts(x + y)'), '7');
  });

  it('existing array programs still work', () => {
    assert.equal(runWithInference('let arr = [10, 20, 30]; puts(arr[1])'), '20');
  });

  it('mixed types in same program', () => {
    assert.equal(runWithInference(`
      let label = fn(s) { puts(s) }
      let value = fn(n) { puts(n) }
      label("x = ")
      value(42)
    `), 'x = 42');
  });

  it('function with string and array', () => {
    assert.equal(runWithInference(`
      let show_arr = fn(label, arr) {
        puts(label)
        for (x in arr) { puts(x) }
      }
      show_arr("values: ", [1, 2, 3])
    `), 'values: 123');
  });

  it('recursive function with int param', () => {
    assert.equal(runWithInference(`
      let fib = fn(n) {
        if (n <= 1) { return n }
        return fib(n - 1) + fib(n - 2)
      }
      puts(fib(10))
    `), '55');
  });
});
