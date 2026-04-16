// closure-analysis.test.js — Tests for free variable analysis
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFreeVars } from './closure-analysis.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
  return prog;
}

function getFreeVars(input) {
  const prog = parse(input);
  const result = analyzeFreeVars(prog);
  // Convert to a simple map: funcLiteral identity → free vars
  const simplified = {};
  for (const [funcLit, vars] of result) {
    // Use a label based on the function's parameters
    const params = (funcLit.parameters || []).map(p => p.value).join(',');
    simplified[`fn(${params})`] = vars.sort();
  }
  return simplified;
}

describe('Free variable analysis', () => {
  it('no free vars in simple function', () => {
    const result = getFreeVars('let f = fn(x) { x + 1 }');
    assert.deepEqual(result, {});
  });

  it('captures outer variable', () => {
    const result = getFreeVars('let x = 10; let f = fn(y) { x + y }');
    assert.deepEqual(result, { 'fn(y)': ['x'] });
  });

  it('captures parameter of enclosing function', () => {
    const result = getFreeVars('let make_adder = fn(x) { let inner = fn(y) { x + y } }');
    assert.deepEqual(result, { 'fn(y)': ['x'] });
  });

  it('captures multiple variables', () => {
    const result = getFreeVars('let a = 1; let b = 2; let f = fn(x) { a + b + x }');
    assert.deepEqual(result, { 'fn(x)': ['a', 'b'] });
  });

  it('does not capture builtins', () => {
    const result = getFreeVars('let f = fn(x) { puts(x) }');
    assert.deepEqual(result, {});
  });

  it('does not capture local variables', () => {
    const result = getFreeVars('let f = fn(x) { let y = 5; x + y }');
    assert.deepEqual(result, {});
  });

  it('handles nested closures', () => {
    const result = getFreeVars(`
      let outer = fn(x) {
        let middle = fn(y) {
          let inner = fn(z) { x + y + z }
        }
      }
    `);
    // inner captures x (from outer) and y (from middle)
    assert.ok(result['fn(z)']);
    assert.ok(result['fn(z)'].includes('x'));
    assert.ok(result['fn(z)'].includes('y'));
  });

  it('counter pattern', () => {
    const result = getFreeVars(`
      let make_counter = fn() {
        let count = 0
        let inc = fn() { count }
      }
    `);
    assert.deepEqual(result, { 'fn()': ['count'] });
  });

  it('function as argument does not create closure', () => {
    const result = getFreeVars(`
      let apply = fn(f, x) { f(x) }
      let double = fn(x) { x * 2 }
    `);
    assert.deepEqual(result, {});
  });

  it('self-referencing recursive function is not a free var', () => {
    const result = getFreeVars(`
      let fib = fn(n) {
        if (n <= 1) { return n }
        return fib(n - 1) + fib(n - 2)
      }
    `);
    // fib references itself — this is handled by the function being global
    // and not counted as a free variable
    assert.deepEqual(result, {});
  });
});
