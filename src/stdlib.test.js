// stdlib.test.js — Tests for the monkey-lang standard library
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

const stdlibPath = new URL('./stdlib.monkey', import.meta.url).pathname;
const stdlib = readFileSync(stdlibPath, 'utf-8');

function run(code) {
  const fullCode = stdlib + '\n' + code;
  const p = new Parser(new Lexer(fullCode));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  const cg = new RiscVCodeGen();
  const asm = cg.compile(prog, inferTypes(prog), analyzeFreeVars(prog));
  const result = new Assembler().assemble(asm);
  if (result.errors.length > 0) throw new Error(result.errors.map(e=>e.message).join('\n'));
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(10000000);
  return cpu.output.join('');
}

describe('Standard Library: Higher-Order Functions', () => {
  it('map doubles array', () => {
    assert.equal(run('let d = map([1,2,3], make_multiplier(2)); puts(d[0]); puts(d[1]); puts(d[2])'), '246');
  });

  it('filter evens', () => {
    const r = run('let is_even = fn(x) { x % 2 == 0 }; let evens = filter(range(1, 11), is_even); puts(len(evens))');
    assert.equal(r, '5');
  });

  it('reduce sum', () => {
    assert.equal(run('puts(reduce([1,2,3,4,5], 0, _add))'), '15');
  });

  it('foreach (side effects)', () => {
    assert.equal(run('let print = fn(x) { puts(x) }; foreach([10, 20, 30], print)'), '102030');
  });
});

describe('Standard Library: Math', () => {
  it('abs positive', () => { assert.equal(run('puts(abs(42))'), '42'); });
  it('abs negative', () => { assert.equal(run('puts(abs(0 - 17))'), '17'); });
  it('max', () => { assert.equal(run('puts(max(3, 7))'), '7'); });
  it('min', () => { assert.equal(run('puts(min(3, 7))'), '3'); });
  it('gcd', () => { assert.equal(run('puts(gcd(48, 18))'), '6'); });
  it('power', () => { assert.equal(run('puts(power(2, 10))'), '1024'); });
  it('is_prime true', () => { assert.equal(run('puts(is_prime(97))'), '1'); });
  it('is_prime false', () => { assert.equal(run('puts(is_prime(100))'), '0'); });
});

describe('Standard Library: Array Utilities', () => {
  it('range', () => {
    assert.equal(run('let r = range(1, 4); puts(r[0]); puts(r[1]); puts(r[2])'), '123');
  });
  it('sum', () => { assert.equal(run('puts(sum(range(1, 11)))'), '55'); });
  it('product', () => { assert.equal(run('puts(product([1,2,3,4,5]))'), '120'); });
  it('arr_max', () => { assert.equal(run('puts(arr_max([3, 7, 2, 9, 1]))'), '9'); });
  it('arr_min', () => { assert.equal(run('puts(arr_min([3, 7, 2, 9, 1]))'), '1'); });
  it('contains true', () => { assert.equal(run('puts(contains([1,2,3], 2))'), '1'); });
  it('contains false', () => { assert.equal(run('puts(contains([1,2,3], 5))'), '0'); });
  it('count_if primes', () => { assert.equal(run('puts(count_if(range(1, 51), is_prime))'), '15'); });
});

describe('Standard Library: Linked List', () => {
  it('cons/car/cdr', () => {
    assert.equal(run('let l = cons(1, cons(2, cons(3, []))); puts(car(l)); puts(car(cdr(l))); puts(car(cdr(cdr(l))))'), '123');
  });
  it('list_len', () => {
    assert.equal(run('puts(list_len(cons(1, cons(2, cons(3, [])))))'), '3');
  });
  it('is_nil empty', () => { assert.equal(run('puts(is_nil([]))'), '1'); });
  it('is_nil non-empty', () => { assert.equal(run('puts(is_nil(cons(1, [])))'), '0'); });
});

describe('Standard Library: Closure Factories', () => {
  it('make_adder', () => { assert.equal(run('let add5 = make_adder(5); puts(add5(3))'), '8'); });
  it('make_multiplier', () => { assert.equal(run('let triple = make_multiplier(3); puts(triple(7))'), '21'); });
  it('make_checker', () => { assert.equal(run('let gt10 = make_checker(10); puts(gt10(15))'), '1'); });
  it('compose factories', () => {
    assert.equal(run('puts(compose(make_adder(5), make_multiplier(3), 4))'), '17');
  });
});

describe('Standard Library: New Functions', () => {
  it('reverse', () => {
    const r = run('let rev = reverse([1,2,3]); puts(rev[0]); puts(rev[1]); puts(rev[2])');
    assert.equal(r, '321');
  });
  it('any with primes', () => { assert.equal(run('puts(any(range(2, 10), is_prime))'), '1'); });
  it('all positive', () => { assert.equal(run('puts(all([1, 2, 3], fn(x) { x > 0 }))'), '1'); });
  it('all not all positive', () => {
    assert.equal(run('let pos = fn(x) { x > 0 }; puts(all([1, 0 - 1, 3], pos))'), '0');
  });
});

describe('Standard Library: Comprehensive', () => {
  it('map and sum', () => { assert.equal(run('puts(sum(map([1,2,3], make_multiplier(10))))'), '60'); });
  it('filter and count', () => { assert.equal(run('puts(len(filter(range(1, 21), is_prime)))'), '8'); });
  it('power of 2', () => { assert.equal(run('puts(power(2, 16))'), '65536'); });
  it('gcd of large', () => { assert.equal(run('puts(gcd(1071, 462))'), '21'); });
  it('product of range', () => { assert.equal(run('puts(product([1,2,3,4,5,6]))'), '720'); });
  it('arr_max of range', () => { assert.equal(run('puts(arr_max(range(1, 100)))'), '99'); });
  it('arr_min of range', () => { assert.equal(run('puts(arr_min(range(1, 100)))'), '1'); });
  it('contains with HOF', () => { assert.equal(run('puts(contains([2,4,6,8], 6))'), '1'); });
  it('count_if with closure', () => {
    assert.equal(run('puts(count_if(range(1, 101), make_checker(50)))'), '50');
  });
  it('apply_n power', () => { assert.equal(run('let double = fn(x) { x * 2 }; puts(apply_n(double, 10, 1))'), '1024'); });
  it('compose with builtins', () => { assert.equal(run('let neg = fn(x) { 0 - x }; let inc = fn(x) { x + 1 }; puts(compose(neg, inc, 5))'), '-6'); });
  it('twice with adder', () => { assert.equal(run('puts(twice(make_adder(5), 0))'), '10'); });
  it('abs of computed', () => { assert.equal(run('puts(abs(3 - 10))'), '7'); });
  it('min max of same', () => { assert.equal(run('puts(min(5, 5)); puts(max(5, 5))'), '55'); });
  it('list operations', () => {
    assert.equal(run('let l = cons(1, cons(2, cons(3, []))); puts(list_len(l)); puts(is_nil(l)); puts(is_nil([]))'), '301');
  });
});
