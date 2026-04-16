// closures.test.js — Closure compilation tests for RISC-V codegen
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
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(500000);
  return cpu.output.join('');
}

describe('Closures — basic capture', () => {
  it('captures outer variable', () => {
    assert.equal(run('let x = 10; let add_x = fn(y) { x + y }; puts(add_x(5))'), '15');
  });

  it('captures multiple outer variables', () => {
    assert.equal(run('let a = 3; let b = 4; let f = fn(x) { a + b + x }; puts(f(10))'), '17');
  });

  it('captures with different operations', () => {
    assert.equal(run('let factor = 7; let mul = fn(x) { factor * x }; puts(mul(6))'), '42');
  });

  it('closure does not interfere with regular functions', () => {
    assert.equal(run(`
      let regular = fn(x) { x * 2 }
      let y = 10
      let closure = fn(x) { y + x }
      puts(regular(5))
      puts(closure(3))
    `), '1013');
  });

  it('closure called multiple times', () => {
    assert.equal(run(`
      let offset = 100
      let add = fn(x) { offset + x }
      puts(add(1))
      puts(add(2))
      puts(add(3))
    `), '101102103');
  });

  it('captures string variable', () => {
    assert.equal(run(`
      let greeting = "Hello, "
      let greet = fn(name) { puts(greeting + name) }
      greet("World")
    `), 'Hello, World');
  });

  it('captures array variable', () => {
    assert.equal(run(`
      let data = [10, 20, 30]
      let get = fn(i) { data[i] }
      puts(get(0))
      puts(get(1))
      puts(get(2))
    `), '102030');
  });
});

describe('Closures — non-closure functions still work', () => {
  it('regular function', () => {
    assert.equal(run('let f = fn(x) { x * 2 }; puts(f(21))'), '42');
  });

  it('recursive function', () => {
    assert.equal(run('let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }; puts(fib(10))'), '55');
  });

  it('multiple regular functions', () => {
    assert.equal(run(`
      let add = fn(a, b) { return a + b }
      let mul = fn(a, b) { return a * b }
      puts(add(3, 4))
      puts(mul(5, 6))
    `), '730');
  });
});

describe('Closures — edge cases', () => {
  it('closure with no parameters', () => {
    assert.equal(run('let x = 42; let get_x = fn() { x }; puts(get_x())'), '42');
  });

  it('closure captures boolean value', () => {
    assert.equal(run('let flag = true; let check = fn() { flag }; puts(check())'), '1');
  });

  it('closure with if/else using captured var', () => {
    assert.equal(run(`
      let threshold = 10
      let classify = fn(x) {
        if (x > threshold) { return 1 }
        return 0
      }
      puts(classify(15))
      puts(classify(5))
    `), '10');
  });

  it('closure in loop', () => {
    assert.equal(run(`
      let multiplier = 3
      let mul = fn(x) { multiplier * x }
      let i = 1
      while (i <= 5) {
        puts(mul(i))
        set i = i + 1
      }
    `), '3691215');
  });
});

describe('Returning closures (make_adder pattern)', () => {
  it('make_adder basic', () => {
    assert.equal(run('let make_adder = fn(x) { fn(y) { x + y } }; let add5 = make_adder(5); puts(add5(3))'), '8');
  });

  it('make_adder multiple instances', () => {
    const result = run(`
      let make_adder = fn(x) { fn(y) { x + y } }
      let add5 = make_adder(5)
      let add10 = make_adder(10)
      puts(add5(3) + add10(7))
    `);
    assert.equal(result, '25');  // (5+3) + (10+7) = 8 + 17 = 25
  });

  it('make_multiplier', () => {
    assert.equal(run('let make_mul = fn(x) { fn(y) { x * y } }; let double = make_mul(2); puts(double(21))'), '42');
  });

  it('closure captures computed value', () => {
    const result = run(`
      let make_offset = fn(base) { 
        let offset = base * 2
        fn(x) { x + offset } 
      }
      let f = make_offset(5)
      puts(f(3))
    `);
    assert.equal(result, '13');  // offset = 10, 3 + 10 = 13
  });

  it('closure over boolean', () => {
    assert.equal(run('let make_check = fn(threshold) { fn(x) { x > threshold } }; let gt5 = make_check(5); puts(gt5(10))'), '1');
  });

  it('closure over zero', () => {
    assert.equal(run('let make_adder = fn(x) { fn(y) { x + y } }; let add0 = make_adder(0); puts(add0(42))'), '42');
  });
});

describe('Higher-order functions', () => {
  it('apply function to value', () => {
    assert.equal(run('let double = fn(x) { x * 2 }; let apply = fn(f, x) { f(x) }; puts(apply(double, 5))'), '10');
  });

  it('apply twice', () => {
    const result = run(`
      let twice = fn(f, x) { f(f(x)) }
      let add3 = fn(x) { x + 3 }
      puts(twice(add3, 10))
    `);
    assert.equal(result, '16');
  });

  it('pass closure as argument', () => {
    const result = run(`
      let make_adder = fn(x) { fn(y) { x + y } }
      let apply = fn(f, x) { f(x) }
      let add10 = make_adder(10)
      puts(apply(add10, 5))
    `);
    assert.equal(result, '15');
  });

  it('apply with two-arg function', () => {
    const result = run(`
      let apply2 = fn(f, a, b) { f(a, b) }
      let add = fn(x, y) { x + y }
      puts(apply2(add, 3, 4))
    `);
    assert.equal(result, '7');
  });

  it('function composition', () => {
    const result = run(`
      let double = fn(x) { x * 2 }
      let add1 = fn(x) { x + 1 }
      let compose = fn(f, g, x) { f(g(x)) }
      puts(compose(double, add1, 5))
    `);
    assert.equal(result, '12');  // double(add1(5)) = double(6) = 12
  });

  it('predicate function', () => {
    const result = run(`
      let is_positive = fn(x) { x > 0 }
      let check = fn(pred, x) { pred(x) }
      puts(check(is_positive, 42))
    `);
    assert.equal(result, '1');
  });

  it('negate function', () => {
    const result = run(`
      let negate = fn(x) { 0 - x }
      let apply = fn(f, x) { f(x) }
      puts(apply(negate, 42))
    `);
    assert.equal(result, '-42');
  });

  it('identity function', () => {
    assert.equal(run('let id = fn(x) { x }; let apply = fn(f, x) { f(x) }; puts(apply(id, 99))'), '99');
  });
});

describe('Anonymous inline functions', () => {
  it('apply anonymous function', () => {
    assert.equal(run('let apply = fn(f, x) { f(x) }; puts(apply(fn(x) { x * 2 }, 5))'), '10');
  });

  it('twice with anonymous', () => {
    assert.equal(run('let twice = fn(f, x) { f(f(x)) }; puts(twice(fn(x) { x + 3 }, 0))'), '6');
  });

  it('reduce with anonymous combiner', () => {
    assert.equal(run(`
      let reduce = fn(arr, init, f) {
        let acc = init
        let i = 0
        while (i < len(arr)) { set acc = f(acc, arr[i]); set i = i + 1 }
        return acc
      }
      puts(reduce([1,2,3,4,5], 0, fn(a, b) { a + b }))
    `), '15');
  });

  it('anonymous closure captures outer var', () => {
    assert.equal(run(`
      let x = 10
      let apply = fn(f) { f() }
      puts(apply(fn() { x }))
    `), '10');
  });

  it('IIFE pattern (immediately invoked)', () => {
    // Can't do IIFE directly in monkey, but can simulate via apply
    assert.equal(run('let run = fn(f) { f() }; puts(run(fn() { 42 }))'), '42');
  });
});

describe('Mutual recursion', () => {
  it('is_even / is_odd', () => {
    const result = run(`
      let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) }
      let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) }
      puts(is_even(10))
      puts(is_odd(7))
      puts(is_even(5))
    `);
    assert.equal(result, '110');  // true, true, false
  });

  it('mutual counting', () => {
    const result = run(`
      let count_down_a = fn(n) { if (n <= 0) { return 0 }; return 1 + count_down_b(n - 1) }
      let count_down_b = fn(n) { if (n <= 0) { return 0 }; return 1 + count_down_a(n - 1) }
      puts(count_down_a(10))
    `);
    assert.equal(result, '10');
  });

  it('three mutually recursive functions', () => {
    const result = run(`
      let fa = fn(n) { if (n <= 0) { return 1 }; return fb(n - 1) }
      let fb = fn(n) { if (n <= 0) { return 2 }; return fc(n - 1) }
      let fc = fn(n) { if (n <= 0) { return 3 }; return fa(n - 1) }
      puts(fa(0))
      puts(fa(1))
      puts(fa(2))
      puts(fa(3))
    `);
    assert.equal(result, '1231');  // fa(0)=1, fa(1)=fb(0)=2, fa(2)=fb(1)=fc(0)=3, fa(3)=fb(2)=fc(1)=fa(0)=1
  });
});

describe('Recursive closures', () => {
  it('recursive helper with captured var', () => {
    const result = run(`
      let sum_to = fn(n) {
        let helper = fn(i, acc) {
          if (i > n) { return acc }
          return helper(i + 1, acc + i)
        }
        return helper(1, 0)
      }
      puts(sum_to(10))
    `);
    assert.equal(result, '55');
  });

  it('recursive closure counts down', () => {
    const result = run(`
      let make_counter = fn(target) {
        let count = fn(n) {
          if (n >= target) { return n }
          return count(n + 1)
        }
        return count(0)
      }
      puts(make_counter(42))
    `);
    assert.equal(result, '42');
  });

  it('recursive closure with no captured vars', () => {
    const result = run(`
      let wrap = fn(n) {
        let helper = fn(i) {
          if (i <= 0) { return 0 }
          return 1 + helper(i - 1)
        }
        return helper(n)
      }
      puts(wrap(5))
    `);
    assert.equal(result, '5');
  });
});

describe('Deep closure chains', () => {
  it('4-level nested closure', () => {
    const result = run(`
      let f4 = fn(a) { fn(b) { fn(c) { fn(d) { a + b + c + d } } } }
      let g = f4(1)
      let h = g(2)
      let i = h(3)
      puts(i(4))
    `);
    assert.equal(result, '10');
  });

  it('3-level with multiplication', () => {
    const result = run(`
      let curry_mul = fn(a) { fn(b) { fn(c) { a * b * c } } }
      let f = curry_mul(2)
      let g = f(3)
      puts(g(4))
    `);
    assert.equal(result, '24');
  });

  it('partial application via wrapper', () => {
    const result = run(`
      let add = fn(a, b) { a + b }
      let add5 = fn(x) { add(5, x) }
      puts(add5(3))
    `);
    assert.equal(result, '8');
  });

  it('closure factory returning deep closure', () => {
    const result = run(`
      let make_poly = fn(a) {
        fn(b) {
          fn(x) { a * x * x + b * x }
        }
      }
      let f = make_poly(2)
      let g = f(3)
      puts(g(5))
    `);
    assert.equal(result, '65');  // 2*25 + 3*5 = 50 + 15 = 65
  });
});

describe('Advanced closure patterns', () => {
  it('closure as module pattern', () => {
    const result = run(`
      let counter_mod = fn() {
        let count = 0
        fn(delta) { count + delta }
      }
      let c = counter_mod()
      puts(c(0))
      puts(c(5))
      puts(c(10))
    `);
    assert.equal(result, '0510');
  });

  it('closure factory chain', () => {
    const result = run(`
      let make_op = fn(op) {
        if (op == 1) { return fn(a, b) { a + b } }
        if (op == 2) { return fn(a, b) { a * b } }
        return fn(a, b) { a - b }
      }
      let add = make_op(1)
      let mul = make_op(2)
      let sub = make_op(0)
      puts(add(3, 4))
      puts(mul(3, 4))
      puts(sub(10, 3))
    `);
    assert.equal(result, '7127');
  });
});

describe('Closure edge cases', () => {
  it('closure captures 0', () => {
    assert.equal(run('let make = fn(n) { fn() { n } }; let f = make(0); puts(f())'), '0');
  });
  it('closure captures negative', () => {
    assert.equal(run('let make = fn(n) { fn() { n } }; let f = make(0 - 42); puts(f())'), '-42');
  });
  it('HOF with closure result', () => {
    assert.equal(run('let make_adder = fn(n) { fn(x) { x + n } }; let apply = fn(f, x) { f(x) }; puts(apply(make_adder(100), 23))'), '123');
  });
});

describe('Closure stress — many patterns', () => {
  it('adder with multiple calls', () => {
    assert.equal(run('let add = fn(n) { fn(x) { x + n } }; let f = add(100); puts(f(1)); puts(f(2)); puts(f(3))'), '101102103');
  });
  it('compose two closures', () => {
    assert.equal(run('let make_adder = fn(n) { fn(x) { x + n } }; let make_mul = fn(n) { fn(x) { x * n } }; let compose = fn(f, g, x) { f(g(x)) }; puts(compose(make_adder(1), make_mul(10), 5))'), '51');
  });
  it('closure with boolean logic', () => {
    assert.equal(run('let make_range_check = fn(lo, hi) { fn(x) { x >= lo && x <= hi } }; let in_range = make_range_check(10, 20); puts(in_range(15)); puts(in_range(25))'), '10');
  });
  it('nested closure with for loop', () => {
    assert.equal(run('let make_counter = fn(start) { fn(step) { start + step } }; let c = make_counter(100); let s = 0; for (let i = 0; i < 5; set i = i + 1) { set s = s + c(i) }; puts(s)'), '510');
  });
});

describe('Closure integration patterns', () => {
  it('make_predicate', () => {
    assert.equal(run('let gt = fn(n) { fn(x) { x > n } }; let gt5 = gt(5); puts(gt5(3)); puts(gt5(7))'), '01');
  });
  it('closure arithmetic', () => {
    assert.equal(run('let make_fn = fn(op, n) { if (op == 1) { return fn(x) { x + n } }; return fn(x) { x * n } }; let f = make_fn(1, 5); let g = make_fn(2, 3); puts(f(10)); puts(g(10))'), '1530');
  });
  it('returned closure called in expression', () => {
    assert.equal(run('let make = fn(n) { fn(x) { x + n } }; let a = make(10); let b = make(5); puts(a(20) + b(3))'), '38');
  });
});
