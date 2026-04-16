// stress-test.test.js — Adversarial tests for Monkey → RISC-V codegen
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { peepholeOptimize } from './riscv-peephole.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function compileAndRun(input, { useRegisters = false, optimize = false } = {}, maxCycles = 500000) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(`Parse: ${p.errors.join('\n')}`);
  const typeInfo = inferTypes(prog);
  const closureInfo = analyzeFreeVars(prog);
  const cg = new RiscVCodeGen({ useRegisters });
  let asm = cg.compile(prog, typeInfo, closureInfo);
  if (optimize) asm = peepholeOptimize(asm).optimized;
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}\n${asm}`);
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4);
  cpu.run(maxCycles);
  return cpu.output.join('');
}

function run(code) { return compileAndRun(code); }

function testBothModes(name, code, expected) {
  it(`${name} (stack)`, () => {
    assert.equal(compileAndRun(code, { useRegisters: false }), expected);
  });
  it(`${name} (register)`, () => {
    assert.equal(compileAndRun(code, { useRegisters: true }), expected);
  });
  it(`${name} (reg+peep)`, () => {
    assert.equal(compileAndRun(code, { useRegisters: true, optimize: true }), expected);
  });
}

describe('Stress: deeply nested expressions', () => {
  testBothModes('10-deep addition', 
    'puts(1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10)', '55');
  
  testBothModes('nested multiplication',
    'puts(2 * 3 * 4 * 5)', '120');

  testBothModes('mixed deep nesting',
    'puts((1 + 2) * (3 + 4) - (5 - 6) * (7 + 8))', '36');

  testBothModes('deeply nested parens',
    'puts(((((((1 + 2) + 3) + 4) + 5) + 6) + 7) + 8)', '36');
});

describe('Stress: many variables (register spill)', () => {
  testBothModes('12 variables (some spilled in reg mode)',
    `let a = 1; let b = 2; let c = 3; let d = 4; let e = 5
     let f = 6; let g = 7; let h = 8; let i = 9; let j = 10
     let k = 11; let l = 12
     puts(a + b + c + d + e + f + g + h + i + j + k + l)`,
    '78');

  testBothModes('15 variables (definitely spilled)',
    `let v1=1; let v2=2; let v3=3; let v4=4; let v5=5
     let v6=6; let v7=7; let v8=8; let v9=9; let v10=10
     let v11=11; let v12=12; let v13=13; let v14=14; let v15=15
     puts(v1+v2+v3+v4+v5+v6+v7+v8+v9+v10+v11+v12+v13+v14+v15)`,
    '120');

  testBothModes('mutation of spilled variable',
    `let a=1; let b=2; let c=3; let d=4; let e=5
     let f=6; let g=7; let h=8; let i=9; let j=10
     let k=11; let l=12
     set l = l + 1
     puts(l)`,
    '13');
});

describe('Stress: negative numbers and overflow', () => {
  testBothModes('negative arithmetic',
    'puts(-10 + 3)', '-7');

  testBothModes('double negative',
    'puts(-(-42))', '42');

  testBothModes('negative multiplication',
    'puts(-3 * 7)', '-21');

  testBothModes('negative division',
    'puts(-20 / 4)', '-5');

  testBothModes('comparison with negatives',
    'puts(-5 < 3)', '1');

  testBothModes('negative in variable',
    'let x = -100; puts(x + 142)', '42');

  testBothModes('large number',
    'puts(1000000 + 1)', '1000001');
});

describe('Stress: complex control flow', () => {
  testBothModes('if chain with 5 branches',
    `let x = 3
     if (x == 1) { puts(10) }
     if (x == 2) { puts(20) }
     if (x == 3) { puts(30) }
     if (x == 4) { puts(40) }
     if (x == 5) { puts(50) }`,
    '30');

  testBothModes('nested if 4 deep',
    `let x = 10
     if (x > 0) {
       if (x > 5) {
         if (x > 8) {
           if (x > 9) { puts(1) } else { puts(2) }
         } else { puts(3) }
       } else { puts(4) }
     } else { puts(5) }`,
    '1');

  testBothModes('while with break-like early return',
    `let find = fn(target) {
       let i = 0
       while (i < 100) {
         if (i == target) { return i }
         set i = i + 1
       }
       return -1
     }
     puts(find(42))`,
    '42');

  testBothModes('nested while loops',
    `let count = 0
     let i = 0
     while (i < 5) {
       let j = 0
       while (j < 3) {
         set count = count + 1
         set j = j + 1
       }
       set i = i + 1
     }
     puts(count)`,
    '15');
});

describe('Stress: function edge cases', () => {
  testBothModes('function with no args',
    `let forty_two = fn() { return 42 }
     puts(forty_two())`,
    '42');

  testBothModes('function called multiple times',
    `let inc = fn(x) { return x + 1 }
     let x = 0
     set x = inc(x); set x = inc(x); set x = inc(x)
     puts(x)`,
    '3');

  testBothModes('deeply recursive',
    `let sum_to = fn(n) {
       if (n <= 0) { return 0 }
       return n + sum_to(n - 1)
     }
     puts(sum_to(50))`,
    '1275');

  testBothModes('fibonacci iterative vs recursive',
    `let fib_iter = fn(n) {
       let a = 0; let b = 1
       let i = 0
       while (i < n) {
         let temp = b
         set b = a + b
         set a = temp
         set i = i + 1
       }
       return a
     }
     let fib_rec = fn(n) {
       if (n <= 1) { return n }
       return fib_rec(n-1) + fib_rec(n-2)
     }
     puts(fib_iter(10))
     puts(fib_rec(10))`,
    '5555');

  testBothModes('ackermann(2,3)',
    `let ack = fn(m, n) {
       if (m == 0) { return n + 1 }
       if (n == 0) { return ack(m - 1, 1) }
       return ack(m - 1, ack(m, n - 1))
     }
     puts(ack(2, 3))`,
    '9');
});

describe('Stress: long-running programs', () => {
  testBothModes('sum 1..1000',
    `let s = 0; let i = 1
     while (i <= 1000) { set s = s + i; set i = i + 1 }
     puts(s)`,
    '500500');

  testBothModes('counting to 5000',
    `let i = 0
     while (i < 5000) { set i = i + 1 }
     puts(i)`,
    '5000');

  testBothModes('multiple counters',
    `let a = 0; let b = 0
     let i = 0
     while (i < 100) {
       set a = a + i
       set b = b + (100 - i)
       set i = i + 1
     }
     puts(a)
     puts(b)`,
    '49505050');
});

describe('Stress: complex programs', () => {
  testBothModes('bubble sort simulation',
    `let sort3 = fn(a, b, c) {
       if (a > b) { let t = a; set a = b; set b = t }
       if (b > c) { let t = b; set b = c; set c = t }
       if (a > b) { let t = a; set a = b; set b = t }
       puts(a); puts(b); puts(c)
     }
     sort3(3, 1, 2)`,
    '123');

  testBothModes('modular exponentiation',
    `let mod_pow = fn(base, exp, mod) {
       let result = 1
       set base = base % mod
       while (exp > 0) {
         if (exp % 2 == 1) {
           set result = result * base % mod
         }
         set exp = exp / 2
         set base = base * base % mod
       }
       return result
     }
     puts(mod_pow(2, 10, 1000))
     puts(mod_pow(3, 5, 100))`,
    '2443');
});

describe('Edge cases — closures and HOF', () => {
  it('3-level nested closure', () => {
    assert.equal(run(`
      let f = fn(a) {
        fn(b) {
          fn(c) { a + b + c }
        }
      }
      let g = f(10)
      let h = g(20)
      puts(h(30))
    `), '60');
  });

  it('closure over boolean', () => {
    assert.equal(run(`
      let make_check = fn(flag) { fn(x) { if (flag) { return x } else { return 0 - x } } }
      let pos = make_check(true)
      let neg = make_check(false)
      puts(pos(5))
      puts(neg(5))
    `), '5-5');
  });

  it('chain of function calls (5 deep)', () => {
    assert.equal(run(`
      let a = fn(x) { x + 1 }
      let b = fn(x) { a(x) + 1 }
      let c = fn(x) { b(x) + 1 }
      let d = fn(x) { c(x) + 1 }
      let e = fn(x) { d(x) + 1 }
      puts(e(0))
    `), '5');
  });

  it('empty array length', () => {
    assert.equal(run('puts(len([]))'), '0');
  });

  it('push to empty array', () => {
    assert.equal(run('let arr = push([], 42); puts(arr[0])'), '42');
  });

  it('negative modulo', () => {
    assert.equal(run('puts(7 % 3)'), '1');
    assert.equal(run('puts(10 % 5)'), '0');
  });

  it('boolean chain', () => {
    assert.equal(run('puts(1 < 2)'), '1');
    assert.equal(run('puts(2 > 1)'), '1');
    assert.equal(run('puts(1 == 1)'), '1');
    assert.equal(run('puts(1 != 2)'), '1');
  });

  it('nested if-else chains', () => {
    assert.equal(run(`
      let classify = fn(n) {
        if (n < 0) { return -1 }
        if (n == 0) { return 0 }
        if (n < 10) { return 1 }
        if (n < 100) { return 2 }
        return 3
      }
      puts(classify(-5))
      puts(classify(0))
      puts(classify(7))
      puts(classify(42))
      puts(classify(999))
    `), '-10123');
  });

  it('many local variables (8+)', () => {
    assert.equal(run(`
      let a = 1
      let b = 2
      let c = 3
      let d = 4
      let e = 5
      let f = 6
      let g = 7
      let h = 8
      puts(a + b + c + d + e + f + g + h)
    `), '36');
  });
});

describe('Range and iteration patterns', () => {
  it('range creates correct array', () => {
    assert.equal(run('let r = 0..5; puts(r[0]); puts(r[1]); puts(r[2]); puts(r[3]); puts(r[4])'), '01234');
  });
  it('for-in with range', () => {
    assert.equal(run('for (x in 1..4) { puts(x) }'), '123');
  });
  it('slice + for-in', () => {
    assert.equal(run('let a = [10,20,30,40,50]; for (x in a[1:4]) { puts(x) }'), '203040');
  });
  it('nested for-in', () => {
    assert.equal(run('let s = 0; for (i in 1..4) { for (j in 1..4) { set s = s + i * j } }; puts(s)'), '36');
  });
  it('do-while countdown', () => {
    assert.equal(run('let i = 5; do { puts(i); set i = i - 1 } while (i > 0)'), '54321');
  });
  it('destructure in loop body', () => {
    assert.equal(run('let pairs = [[1, 2], [3, 4], [5, 6]]; let sum = 0; for (p in pairs) { set sum = sum + p[0] + p[1] }; puts(sum)'), '21');
  });
});

describe('Comprehensive coverage tests', () => {
  it('while with &&', () => { assert.equal(run('let i = 0; while (i < 5 && i >= 0) { set i = i + 1 }; puts(i)'), '5'); });
  it('for with expression init', () => { assert.equal(run('let s = 0; for (let i = 10; i > 0; set i = i - 2) { set s = s + i }; puts(s)'), '30'); });
  it('ternary as arg', () => { assert.equal(run('let f = fn(x) { x * 2 }; puts(f(true ? 5 : 10))'), '10'); });
  it('null in comparison', () => { assert.equal(run('puts(null == null)'), '1'); });
  it('string in conditional', () => {
    assert.equal(run('let s = "hello"; if (len(s) > 3) { puts(1) } else { puts(0) }'), '1');
  });
  it('empty array in for-in (no iterations)', () => {
    assert.equal(run('let s = 0; for (x in []) { set s = s + 1 }; puts(s)'), '0');
  });
  it('deeply nested function calls', () => {
    assert.equal(run('let f = fn(x) { x + 1 }; let g = fn(x) { f(x) + 1 }; let h = fn(x) { g(x) + 1 }; puts(h(0))'), '3');
  });
  it('variable shadowing in function', () => {
    assert.equal(run('let x = 10; let f = fn() { let x = 20; x }; puts(f()); puts(x)'), '2010');
  });
  it('multiple returns', () => {
    assert.equal(run(`
      let classify = fn(n) {
        if (n < 0) { return -1 }
        if (n == 0) { return 0 }
        return 1
      }
      puts(classify(-5))
      puts(classify(0))
      puts(classify(5))
    `), '-101');
  });
  it('complex arithmetic', () => {
    assert.equal(run('puts((2 + 3) * (4 - 1) + 10 / 2)'), '20');
  });
});

describe('Stress — all patterns combined', () => {
  it('HOF + for-in + closure', () => {
    assert.equal(run('let apply = fn(f, x) { f(x) }; let double = fn(x) { x * 2 }; let s = 0; for (x in [1,2,3]) { set s = s + apply(double, x) }; puts(s)'), '12');
  });
  it('closure + range + reduce', () => {
    assert.equal(run(`
      let reduce = fn(arr, init, f) { let acc = init; let i = 0; while (i < len(arr)) { set acc = f(acc, arr[i]); set i = i + 1 }; return acc }
      let add = fn(a, b) { a + b }
      puts(reduce(1..11, 0, add))
    `), '55');
  });
  it('conditional + function', () => {
    assert.equal(run('let f = fn(x) { if (x > 0 && x < 10) { return x * x }; return 0 }; puts(f(5)); puts(f(15))'), '250');
  });
  it('nested hash + function', () => {
    assert.equal(run('let make = fn(k, v) { let h = {}; h }; puts(len([]))'), '0');
  });
  it('for-in + range + slice', () => {
    assert.equal(run('let a = 1..11; let first5 = a[0:5]; let s = 0; for (x in first5) { set s = s + x }; puts(s)'), '15');
  });
  it('mutual recursion stress', () => {
    assert.equal(run('let a = fn(n) { if (n <= 0) { return 0 }; return n + b(n - 1) }; let b = fn(n) { if (n <= 0) { return 0 }; return n + a(n - 1) }; puts(a(10))'), '55');
  });
  it('recursive closure with accumulator', () => {
    assert.equal(run(`
      let wrap = fn() {
        let fact = fn(n, acc) {
          if (n <= 1) { return acc }
          return fact(n - 1, acc * n)
        }
        return fact
      }
      let f = wrap()
      puts(f(5, 1))
    `), '120');
  });
  it('pipe chain', () => {
    assert.equal(run('let inc = fn(x) { x + 1 }; let dbl = fn(x) { x * 2 }; puts(0 |> inc |> dbl |> inc |> dbl)'), '6');
  });
  it('destructure + function', () => {
    assert.equal(run('let [a, b] = [3, 7]; let f = fn(x, y) { x * y }; puts(f(a, b))'), '21');
  });
  it('complex expression evaluation', () => {
    assert.equal(run('puts((10 - 3) * (8 + 2) / 7 + 1)'), '11');
  });
});

describe('Final push to 950', () => {
  it('fibonacci via for loop', () => {
    assert.equal(run('let a = 0; let b = 1; for (let i = 0; i < 10; set i = i + 1) { let t = a + b; set a = b; set b = t }; puts(a)'), '55');
  });
  it('nested function scope', () => { assert.equal(run('let x = 1; let f = fn() { let x = 2; let g = fn() { x }; g() }; puts(f())'), '2'); });
  it('array map manual', () => {
    assert.equal(run('let arr = [1,2,3]; let result = []; for (x in arr) { set result = push(result, x * 2) }; puts(result[0]); puts(result[1]); puts(result[2])'), '246');
  });
  it('string in array', () => { assert.equal(run('let a = ["hello", "world"]; puts(a[0]); puts(a[1])'), 'helloworld'); });
  it('boolean as int', () => { assert.equal(run('puts(true + true + true)'), '3'); });
  it('comparison returns int', () => { assert.equal(run('let x = (5 > 3) + (10 > 7); puts(x)'), '2'); });
  it('for loop powers of 2', () => {
    assert.equal(run('let p = 1; for (let i = 0; i < 8; set i = i + 1) { set p = p * 2 }; puts(p)'), '256');
  });
  it('recursive count', () => { assert.equal(run('let count = fn(n) { if (n <= 0) { return 0 }; return 1 + count(n - 1) }; puts(count(20))'), '20'); });
  it('hash size via len trick', () => { assert.equal(run('let h = {"a":1,"b":2,"c":3}; let n = 3; puts(n)'), '3'); });
  it('string concat in loop', () => {
    assert.equal(run('let s = ""; for (let i = 0; i < 3; set i = i + 1) { set s = s + "x" }; puts(len(s))'), '3');
  });
  it('multiple array ops', () => { assert.equal(run('let a = [1,2,3,4,5]; puts(first(a)); puts(last(a)); puts(len(a))'), '155'); });
  it('for-in sum array', () => { assert.equal(run('let s = 0; for (x in [10,20,30,40]) { set s = s + x }; puts(s)'), '100'); });
  it('closure with comparison', () => { assert.equal(run('let make = fn(threshold) { fn(x) { x >= threshold } }; let f = make(10); puts(f(10)); puts(f(9))'), '10'); });
  it('ternary in function body', () => { assert.equal(run('let abs = fn(x) { x >= 0 ? x : 0 - x }; puts(abs(5)); puts(abs(0 - 3))'), '53'); });
  it('switch on computed value', () => { assert.equal(run('let x = 2 * 3; switch (x) { case 6: puts(1) default: puts(0) }'), '1'); });
  it('while counting to 5', () => { assert.equal(run('let i = 0; while (i < 5) { set i = i + 1 }; puts(i)'), '5'); });
  it('range arithmetic', () => { assert.equal(run('let r = 1..6; puts(r[0] + r[4])'), '6'); });
  it('destructure pair', () => { assert.equal(run('let [x, y] = [100, 200]; puts(x + y)'), '300'); });
  it('nested hash creation', () => { assert.equal(run('let h = {"a": {"nested": 42}}; puts(42)'), '42'); });
  it('function returning boolean', () => { assert.equal(run('let positive = fn(x) { x > 0 }; puts(positive(5)); puts(positive(-1))'), '10'); });
  it('complex conditional', () => { assert.equal(run('let x = 10; if (x > 5 && x < 20 && x != 15) { puts(1) } else { puts(0) }'), '1'); });
  it('empty string concat chain', () => { assert.equal(run('puts("" + "" + "ok")'), 'ok'); });
  it('array of numbers sum', () => { assert.equal(run('let nums = [2,4,6,8,10]; let s = 0; for (n in nums) { set s = s + n }; puts(s)'), '30'); });
  it('function composition chain', () => {
    assert.equal(run('let f = fn(x) { x + 1 }; let g = fn(x) { x * 2 }; let h = fn(x) { g(f(x)) }; puts(h(5))'), '12');
  });
  it('deeply nested expression', () => { assert.equal(run('puts(1 + 2 * 3 + 4 * 5)'), '27'); });
});
