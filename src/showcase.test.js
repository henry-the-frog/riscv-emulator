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

function runFull(input, { useRegisters = false, optimize = false } = {}) {
  const p = new Parser(new Lexer(input));
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(p.errors.join('\n'));
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
  cpu.run(2000000);
  return { output: cpu.output.join(''), cycles: cpu.cycles, words: result.words.length };
}

function run(input) {
  return runFull(input).output;
}

describe('Showcase: Feature-Complete Demo', () => {
  it('FizzBuzz 1..20', () => {
    const { output } = runFull(`
      let fizzbuzz = fn(n) {
        if (n % 15 == 0) { puts("FizzBuzz") }
        if (n % 15 != 0) {
          if (n % 3 == 0) { puts("Fizz") }
          if (n % 3 != 0) {
            if (n % 5 == 0) { puts("Buzz") }
            if (n % 5 != 0) { puts(n) }
          }
        }
      }
      let i = 1
      while (i <= 20) {
        fizzbuzz(i)
        set i = i + 1
      }
    `);
    assert.equal(output, '12Fizz4BuzzFizz78FizzBuzz11Fizz1314FizzBuzz1617Fizz19Buzz');
  });

  it('Sieve of Eratosthenes', () => {
    const { output } = runFull(`
      let is_prime = fn(n) {
        if (n < 2) { return 0 }
        let i = 2
        while (i * i <= n) {
          if (n % i == 0) { return 0 }
          set i = i + 1
        }
        return 1
      }
      let primes = []
      let n = 2
      while (n <= 50) {
        if (is_prime(n) == 1) {
          set primes = push(primes, n)
        }
        set n = n + 1
      }
      puts("Primes: ")
      for (p in primes) {
        puts(p)
        puts(" ")
      }
    `);
    assert.ok(output.includes('Primes: '));
    assert.ok(output.includes('2 '));
    assert.ok(output.includes('47 '));
  });

  it('String builder pattern', () => {
    const { output } = runFull(`
      let repeat = fn(s, n) {
        let result = ""
        let i = 0
        while (i < n) {
          set result = result + s
          set i = i + 1
        }
        return result
      }
      puts(repeat("ha", 3))
    `);
    assert.equal(output, 'hahaha');
  });

  it('Tower of Hanoi counter', () => {
    const { output } = runFull(`
      let hanoi_count = fn(n) {
        if (n == 0) { return 0 }
        return 1 + hanoi_count(n - 1) * 2
      }
      puts("Moves for 1: "); puts(hanoi_count(1))
      puts(" Moves for 5: "); puts(hanoi_count(5))
      puts(" Moves for 10: "); puts(hanoi_count(10))
    `);
    assert.ok(output.includes('Moves for 1: 1'));
    assert.ok(output.includes('Moves for 5: 31'));
    assert.ok(output.includes('Moves for 10: 1023'));
  });

  it('Binary search', () => {
    const { output } = runFull(`
      let binary_search = fn(arr, target, lo, hi) {
        if (lo > hi) { return -1 }
        let mid = (lo + hi) / 2
        if (arr[mid] == target) { return mid }
        if (arr[mid] < target) {
          return binary_search(arr, target, mid + 1, hi)
        }
        return binary_search(arr, target, lo, mid - 1)
      }
      let data = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]
      puts(binary_search(data, 23, 0, 9))
    `);
    assert.equal(output, '5');
  });

  it('Matrix-like computation', () => {
    const { output } = runFull(`
      let dot = fn(a, b, n) {
        let sum = 0
        let i = 0
        while (i < n) {
          set sum = sum + a[i] * b[i]
          set i = i + 1
        }
        return sum
      }
      let v1 = [1, 0, 0]
      let v2 = [0, 1, 0]
      let v3 = [1, 1, 1]
      puts("v1·v2="); puts(dot(v1, v2, 3))
      puts(" v1·v3="); puts(dot(v1, v3, 3))
      puts(" v3·v3="); puts(dot(v3, v3, 3))
    `);
    assert.ok(output.includes('v1·v2=0'));
    assert.ok(output.includes('v1·v3=1'));
    assert.ok(output.includes('v3·v3=3'));
  });

  it('Complete pipeline: all features with optimization', () => {
    const code = `
      let greet = fn(name) {
        puts("Hello, " + name + "!")
      }
      let fib = fn(n) {
        if (n <= 1) { return n }
        return fib(n - 1) + fib(n - 2)
      }
      let names = ["Alice", "Bob", "Charlie"]
      for (name in names) {
        greet(name)
      }
      puts(" fib(8)=")
      puts(fib(8))
      let squares = []
      let i = 0
      while (i < 5) {
        set squares = push(squares, i * i)
        set i = i + 1
      }
      puts(" squares=")
      for (s in squares) {
        puts(s)
        puts(" ")
      }
    `;

    const base = runFull(code);
    assert.ok(base.output.includes('Hello, Alice!'));
    assert.ok(base.output.includes('Hello, Bob!'));
    assert.ok(base.output.includes('Hello, Charlie!'));
    assert.ok(base.output.includes('fib(8)=21'));
    assert.ok(base.output.includes('squares='));
    assert.ok(base.output.includes('0 1 4 9 16'));

    const opt = runFull(code, { useRegisters: true, optimize: true });
    assert.ok(opt.output.includes('Hello, Alice!'));
    assert.ok(opt.output.includes('fib(8)=21'));

    console.log(`  Showcase: ${base.words} instructions, ${base.cycles} cycles (base)`);
    console.log(`  Showcase: ${opt.words} instructions, ${opt.cycles} cycles (optimized)`);
    console.log(`  Savings: ${base.cycles - opt.cycles} cycles (${((base.cycles - opt.cycles)/base.cycles*100).toFixed(1)}%)`);
  });
});

describe('Showcase: Higher-Order Functions', () => {
  it('reduce/fold pattern', () => {
    const result = run(`
      let reduce = fn(arr, init, f) {
        let acc = init
        let i = 0
        while (i < len(arr)) {
          set acc = f(acc, arr[i])
          set i = i + 1
        }
        return acc
      }
      let sum = fn(a, b) { a + b }
      puts(reduce([1, 2, 3, 4, 5], 0, sum))
    `);
    assert.equal(result, '15');
  });

  it('apply_n (repeated application)', () => {
    const result = run(`
      let apply_n = fn(f, n, x) {
        let result = x
        let i = 0
        while (i < n) {
          set result = f(result)
          set i = i + 1
        }
        return result
      }
      let double = fn(x) { x * 2 }
      puts(apply_n(double, 5, 1))
    `);
    assert.equal(result, '32');
  });

  it('function composition chain', () => {
    const result = run(`
      let compose = fn(f, g, x) { f(g(x)) }
      let add1 = fn(x) { x + 1 }
      let mul3 = fn(x) { x * 3 }
      puts(compose(mul3, add1, 4))
    `);
  });

  it('closure factory with higher-order apply', () => {
    const result = run(`
      let make_adder = fn(n) { fn(x) { x + n } }
      let apply = fn(f, x) { f(x) }
      puts(apply(make_adder(100), 42))
    `);
    assert.equal(result, '142');
  });

  it('reduce with multiplication (factorial via fold)', () => {
    const result = run(`
      let reduce = fn(arr, init, f) {
        let acc = init
        let i = 0
        while (i < len(arr)) {
          set acc = f(acc, arr[i])
          set i = i + 1
        }
        return acc
      }
      let mul = fn(a, b) { a * b }
      puts(reduce([1, 2, 3, 4, 5], 1, mul))
    `);
  });

  it('recursive sum with accumulator (tail-recursive style)', () => {
    const result = run(`
      let sum_helper = fn(n, i, acc) {
        if (i > n) { return acc }
        return sum_helper(n, i + 1, acc + i)
      }
      let sum_to = fn(n) { sum_helper(n, 1, 0) }
      puts(sum_to(100))
    `);
    assert.equal(result, '5050');
  });
});

describe('Showcase: Functional Programming Patterns', () => {
  it('map with double', () => {
    const result = run(`
      let map = fn(arr, f) {
        let result = []
        let i = 0
        while (i < len(arr)) {
          set result = push(result, f(arr[i]))
          set i = i + 1
        }
        return result
      }
      let double = fn(x) { x * 2 }
      let arr = map([1, 2, 3], double)
      puts(arr[0])
      puts(arr[1])
      puts(arr[2])
    `);
    assert.equal(result, '246');
  });

  it('filter with predicate', () => {
    const { output } = runFull(`
      let filter = fn(arr, pred) {
        let result = []
        let i = 0
        while (i < len(arr)) {
          if (pred(arr[i])) {
            set result = push(result, arr[i])
          }
          set i = i + 1
        }
        return result
      }
      let is_even = fn(x) { x % 2 == 0 }
      let arr = filter([1, 2, 3, 4, 5, 6], is_even)
      puts(len(arr))
    `);
    assert.equal(output, '3');
  });

  it('map + filter pipeline', () => {
    const { output } = runFull(`
      let map = fn(arr, f) {
        let result = []
        let i = 0
        while (i < len(arr)) {
          set result = push(result, f(arr[i]))
          set i = i + 1
        }
        return result
      }
      let filter = fn(arr, pred) {
        let result = []
        let i = 0
        while (i < len(arr)) {
          if (pred(arr[i])) { set result = push(result, arr[i]) }
          set i = i + 1
        }
        return result
      }
      let square = fn(x) { x * x }
      let gt10 = fn(x) { x > 10 }
      let result = filter(map([1, 2, 3, 4, 5], square), gt10)
      puts(len(result))
      puts(result[0])
      puts(result[1])
    `);
  });

  it('reduce with max', () => {
    const result = run(`
      let reduce = fn(arr, init, f) {
        let acc = init
        let i = 0
        while (i < len(arr)) {
          set acc = f(acc, arr[i])
          set i = i + 1
        }
        return acc
      }
      let max = fn(a, b) { if (a > b) { return a }; return b }
      puts(reduce([3, 7, 2, 9, 1], 0, max))
    `);
    assert.equal(result, '9');
  });

  it('closure-based counter', () => {
    const result = run(`
      let make_counter = fn(start) {
        fn(step) { start + step }
      }
      let from10 = make_counter(10)
      puts(from10(0))
      puts(from10(5))
      puts(from10(90))
    `);
  });

  it('compose two closures', () => {
    const result = run(`
      let make_adder = fn(n) { fn(x) { x + n } }
      let make_mul = fn(n) { fn(x) { x * n } }
      let compose = fn(f, g, x) { f(g(x)) }
      let add5 = make_adder(5)
      let mul3 = make_mul(3)
      puts(compose(add5, mul3, 4))
    `);
  });
});

describe('Showcase: Advanced Algorithms', () => {
  it('Euclidean GCD', () => {
    const result = run(`
      let gcd = fn(a, b) {
        if (b == 0) { return a }
        return gcd(b, a % b)
      }
      puts(gcd(48, 18))
    `);
    assert.equal(result, '6');
  });

  it('GCD multiple values', () => {
    const { output } = runFull(`
      let gcd = fn(a, b) { if (b == 0) { return a }; return gcd(b, a % b) }
      puts(gcd(100, 75))
      puts(gcd(17, 13))
      puts(gcd(1071, 462))
    `);
  });

  it('cons/car/cdr linked list', () => {
    const { output } = runFull(`
      let cons = fn(a, b) { [a, b] }
      let car = fn(pair) { pair[0] }
      let cdr = fn(pair) { pair[1] }
      let list = cons(1, cons(2, cons(3, cons(4, []))))
      puts(car(list))
      puts(car(cdr(list)))
      puts(car(cdr(cdr(list))))
      puts(car(cdr(cdr(cdr(list)))))
    `);
    assert.equal(output, '1234');
  });

  it('power function (recursive)', () => {
    const result = run(`
      let power = fn(base, exp) {
        if (exp == 0) { return 1 }
        return base * power(base, exp - 1)
      }
      puts(power(2, 10))
    `);
    assert.equal(result, '1024');
  });

  it('abs function', () => {
    const result = run(`
      let abs = fn(x) { if (x < 0) { return 0 - x }; return x }
      puts(abs(42))
      puts(abs(0 - 17))
    `);
    assert.equal(result, '4217');
  });

  it('fibonacci iterative', () => {
    const result = run(`
      let fib_iter = fn(n) {
        let a = 0
        let b = 1
        let i = 0
        while (i < n) {
          let tmp = a + b
          set a = b
          set b = tmp
          set i = i + 1
        }
        return a
      }
      puts(fib_iter(10))
      puts(fib_iter(20))
    `);
  });

  it('is_prime function', () => {
    const result = run(`
      let is_prime = fn(n) {
        if (n < 2) { return 0 }
        let i = 2
        while (i * i <= n) {
          if (n % i == 0) { return 0 }
          set i = i + 1
        }
        return 1
      }
      puts(is_prime(2))
      puts(is_prime(17))
      puts(is_prime(18))
      puts(is_prime(97))
    `);
  });

  it('count primes up to 50', () => {
    const result = run(`
      let is_prime = fn(n) {
        if (n < 2) { return 0 }
        let i = 2
        while (i * i <= n) {
          if (n % i == 0) { return 0 }
          set i = i + 1
        }
        return 1
      }
      let count = 0
      let n = 2
      while (n <= 50) {
        if (is_prime(n)) { set count = count + 1 }
        set n = n + 1
      }
      puts(count)
    `);
  });
});

describe('Showcase: Meta — Interpreter on RISC-V', () => {
  it('expression tree evaluator (add)', () => {
    const result = run(`
      let eval_expr = fn(expr) {
        if (len(expr) == 1) { return expr[0] }
        let op = expr[0]
        let left = eval_expr(expr[1])
        let right = eval_expr(expr[2])
        if (op == 1) { return left + right }
        if (op == 2) { return left - right }
        if (op == 3) { return left * right }
        return 0
      }
      puts(eval_expr([1, [10], [20]]))
    `);
    assert.equal(result, '30');
  });

  it('expression tree evaluator (complex)', () => {
    const result = run(`
      let eval_expr = fn(expr) {
        if (len(expr) == 1) { return expr[0] }
        let op = expr[0]
        let left = eval_expr(expr[1])
        let right = eval_expr(expr[2])
        if (op == 1) { return left + right }
        if (op == 2) { return left - right }
        if (op == 3) { return left * right }
        return 0
      }
      puts(eval_expr([3, [1, [2], [3]], [1, [4], [5]]]))
    `);
  });
});

describe('Showcase: Algorithms', () => {
  it('binary search finds element', () => {
    const result = run(`
      let binary_search = fn(arr, target) {
        let low = 0
        let high = len(arr) - 1
        while (low <= high) {
          let mid = (low + high) / 2
          if (arr[mid] == target) { return mid }
          if (arr[mid] < target) { set low = mid + 1 } else { set high = mid - 1 }
        }
        return -1
      }
      puts(binary_search([1, 3, 5, 7, 9, 11, 13, 15], 7))
    `);
    assert.equal(result, '3');
  });

  it('binary search not found', () => {
    const result = run(`
      let binary_search = fn(arr, target) {
        let low = 0
        let high = len(arr) - 1
        while (low <= high) {
          let mid = (low + high) / 2
          if (arr[mid] == target) { return mid }
          if (arr[mid] < target) { set low = mid + 1 } else { set high = mid - 1 }
        }
        return -1
      }
      puts(binary_search([1, 3, 5, 7, 9], 4))
    `);
    assert.equal(result, '-1');
  });
});

describe('End-to-End Integration Test', () => {
  it('exercises ALL backend features in one program', () => {
    const { output } = runFull(`
      let make_adder = fn(n) { fn(x) { x + n } }
      let add10 = make_adder(10)
      puts(add10(5))
      
      let apply = fn(f, x) { f(x) }
      let double = fn(x) { x * 2 }
      puts(apply(double, 21))
      
      let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }
      puts(fib(10))
      
      let is_even = fn(n) { if (n == 0) { return 1 }; return is_odd(n - 1) }
      let is_odd = fn(n) { if (n == 0) { return 0 }; return is_even(n - 1) }
      puts(is_even(10))
      
      let greet = fn(name) { "Hello " + name }
      puts(greet("RISC-V"))
      puts(len("Hello"))
      
      let arr = [10, 20, 30, 40, 50]
      puts(len(arr))
      puts(first(arr))
      puts(last(arr))
      
      let config = {"port": 8080, "max": 100}
      puts(config["port"])
      puts(config["max"])
      
      if (5 > 3 && 10 < 20) { puts(1) } else { puts(0) }
      if (false || true) { puts(1) } else { puts(0) }
      
      let sum = 0
      let i = 1
      while (i <= 100) { set sum = sum + i; set i = i + 1 }
      puts(sum)
      
      let sum_to = fn(n) {
        let helper = fn(i, acc) {
          if (i > n) { return acc }
          return helper(i + 1, acc + i)
        }
        return helper(1, 0)
      }
      puts(sum_to(50))
      
      let f3 = fn(a) { fn(b) { fn(c) { a * b + c } } }
      let g = f3(3)
      let h = g(4)
      puts(h(5))
      
      let square = fn(x) { x * x }
      let sum_squares = fn(n) {
        let total = 0
        let j = 1
        while (j <= n) { set total = total + square(j); set j = j + 1 }
        return total
      }
      puts(sum_squares(10))
    `);
    assert.equal(output, '1542551Hello RISC-V5510508080100115050127517385');
  });
});

describe('Showcase: Classic Programs', () => {
  it('FizzBuzz(15)', () => {
    const result = run(`
      let fizzbuzz = fn(n) {
        let i = 1
        while (i <= n) {
          if (i % 15 == 0) {
            puts("FizzBuzz")
          } else {
            if (i % 3 == 0) {
              puts("Fizz")
            } else {
              if (i % 5 == 0) {
                puts("Buzz")
              } else {
                puts(i)
              }
            }
          }
          set i = i + 1
        }
      }
      fizzbuzz(15)
    `);
    assert.equal(result, '12Fizz4BuzzFizz78FizzBuzz11Fizz1314FizzBuzz');
  });
});

describe('Showcase: Numeric Utilities', () => {
  it('digits of number', () => {
    const result = run(`
      let reverse = fn(arr) {
        let result = []
        let i = len(arr) - 1
        while (i >= 0) { set result = push(result, arr[i]); set i = i - 1 }
        return result
      }
      let digits_of = fn(n) {
        let result = []
        while (n > 0) { set result = push(result, n % 10); set n = n / 10 }
        return reverse(result)
      }
      let d = digits_of(12345)
      let print = fn(x) { puts(x) }
      let foreach = fn(arr, f) {
        let i = 0
        while (i < len(arr)) { f(arr[i]); set i = i + 1 }
      }
      foreach(d, print)
    `);
    assert.equal(result, '12345');
  });

  it('array slicing in algorithm', () => {
    const result = run(`
      let take = fn(arr, n) { arr[0:n] }
      let drop = fn(arr, n) { arr[n:len(arr)] }
      let arr = [10, 20, 30, 40, 50]
      let front = take(arr, 3)
      let back = drop(arr, 3)
      puts(len(front))
      puts(front[0])
      puts(len(back))
      puts(back[0])
    `);
    assert.equal(result, '310240');
  });
});

describe('Showcase: Tower of Hanoi', () => {
  it('3 disks', () => {
    const result = run(`
      let hanoi = fn(n, from, to, aux) {
        if (n == 1) { puts(from); puts(to); return 0 }
        hanoi(n - 1, from, aux, to)
        puts(from); puts(to)
        hanoi(n - 1, aux, to, from)
        return 0
      }
      hanoi(3, 1, 3, 2)
    `);
    assert.equal(result, '13123213212313');
  });
});

describe('Showcase: Range and Destructuring', () => {
  it('range in for-in with sum', () => {
    const result = run(`
      let s = 0
      for (x in 1..101) { set s = s + x }
      puts(s)
    `);
    assert.equal(result, '5050');
  });
  
  it('destructure swap', () => {
    const result = run(`
      let swap = fn(a, b) { [b, a] }
      let [x, y] = swap(42, 99)
      puts(x)
      puts(y)
    `);
    assert.equal(result, '9942');
  });
});

describe('Showcase: String Operations', () => {
  it('string concat chain', () => {
    const result = run(`
      let bracket = fn(s) { "[" + s + "]" }
      let wrap = fn(tag, s) { "<" + tag + ">" + s + "</" + tag + ">" }
      puts(bracket("hello"))
      puts(wrap("b", "text"))
    `);
    assert.equal(result, '[hello]<b>text</b>');
  });
  
  it('string equality in hash', () => {
    const result = run(`
      let config = {"mode": "production", "port": 8080}
      puts(config["mode"] == "production")
      puts(config["port"])
    `);
    assert.equal(result, '18080');
  });
});

describe('Showcase: Numeric Algorithms', () => {
  it('greatest of three', () => {
    const result = run(`
      let max3 = fn(a, b, c) {
        if (a > b && a > c) { return a }
        if (b > c) { return b }
        return c
      }
      puts(max3(5, 9, 3))
      puts(max3(7, 2, 8))
      puts(max3(10, 10, 5))
    `);
    assert.equal(result, '9810');
  });
});

describe('Showcase: Fun Programs', () => {
  it('count vowels (via char codes)', () => {
    const result = run(`
      let is_vowel = fn(c) {
        if (c == 97) { return 1 }
        if (c == 101) { return 1 }
        if (c == 105) { return 1 }
        if (c == 111) { return 1 }
        if (c == 117) { return 1 }
        return 0
      }
      let count_vowels = fn(s) {
        let count = 0
        let i = 0
        while (i < len(s)) {
          if (is_vowel(s[i])) { set count = count + 1 }
          set i = i + 1
        }
        return count
      }
      puts(count_vowels("hello world"))
    `);
    assert.equal(result, '3');
  });
  
  it('nth fibonacci (iterative)', () => {
    const result = run(`
      let fib = fn(n) {
        let a = 0
        let b = 1
        for (let i = 0; i < n; set i = i + 1) {
          let tmp = a + b
          set a = b
          set b = tmp
        }
        return a
      }
      puts(fib(0))
      puts(fib(1))
      puts(fib(10))
      puts(fib(20))
    `);
    assert.equal(result, '01556765');
  });
  
  it('palindrome check (via array)', () => {
    const result = run(`
      let is_palindrome = fn(arr) {
        let i = 0
        let j = len(arr) - 1
        while (i < j) {
          if (arr[i] != arr[j]) { return 0 }
          set i = i + 1
          set j = j - 1
        }
        return 1
      }
      puts(is_palindrome([1, 2, 3, 2, 1]))
      puts(is_palindrome([1, 2, 3, 4, 5]))
      puts(is_palindrome([1, 1]))
      puts(is_palindrome([1]))
    `);
    assert.equal(result, '1011');
  });
});

describe('Showcase: Advanced algorithms', () => {
  it('insertion sort (via push)', () => {
    const result = run(`
      let insert_sorted = fn(arr, val) {
        let result = []
        let inserted = false
        let i = 0
        while (i < len(arr)) {
          if (!inserted && val <= arr[i]) {
            set result = push(result, val)
            set inserted = true
          }
          set result = push(result, arr[i])
          set i = i + 1
        }
        if (!inserted) { set result = push(result, val) }
        return result
      }
      let sort = fn(arr) {
        let result = []
        for (x in arr) {
          set result = insert_sorted(result, x)
        }
        return result
      }
      let sorted = sort([5, 3, 8, 1, 9, 2, 7, 4, 6])
      for (x in sorted) { puts(x) }
    `);
    assert.equal(result, '123456789');
  });

  it('matrix trace (diagonal sum)', () => {
    const result = run(`
      let m = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
      let trace = 0
      for (let i = 0; i < 3; set i = i + 1) {
        set trace = trace + m[i][i]
      }
      puts(trace)
    `);
    assert.equal(result, '15');
  });
});

describe('Showcase: More algorithms', () => {
  it('minimum spanning set (array unique)', () => {
    const result = run(`
      let contains = fn(arr, val) {
        let i = 0
        while (i < len(arr)) {
          if (arr[i] == val) { return 1 }
          set i = i + 1
        }
        return 0
      }
      let unique = fn(arr) {
        let result = []
        for (x in arr) {
          if (!contains(result, x)) {
            set result = push(result, x)
          }
        }
        return result
      }
      let u = unique([1, 3, 2, 1, 3, 5, 4, 2, 5])
      puts(len(u))
      for (x in u) { puts(x) }
    `);
    assert.equal(result, '513254');
  });

  it('two-sum (brute force)', () => {
    const result = run(`
      let two_sum = fn(arr, target) {
        let i = 0
        while (i < len(arr)) {
          let j = i + 1
          while (j < len(arr)) {
            if (arr[i] + arr[j] == target) {
              puts(i)
              puts(j)
              return 0
            }
            set j = j + 1
          }
          set i = i + 1
        }
        return -1
      }
      two_sum([2, 7, 11, 15], 9)
    `);
    assert.equal(result, '01');  // indices 0 and 1 (2 + 7 = 9)
  });

  it('max subarray sum (Kadane)', () => {
    const result = run(`
      let max_subarray = fn(arr) {
        let max_so_far = arr[0]
        let max_ending = arr[0]
        let i = 1
        while (i < len(arr)) {
          let val = arr[i]
          if (max_ending + val > val) {
            set max_ending = max_ending + val
          } else {
            set max_ending = val
          }
          if (max_ending > max_so_far) {
            set max_so_far = max_ending
          }
          set i = i + 1
        }
        return max_so_far
      }
      puts(max_subarray([0 - 2, 1, 0 - 3, 4, 0 - 1, 2, 1, 0 - 5, 4]))
    `);
    assert.equal(result, '6');  // [4, -1, 2, 1] = 6
  });
});

describe('Showcase: Interview Problems', () => {
  it('reverse array', () => {
    const result = run(`
      let reverse = fn(arr) {
        let result = []
        let i = len(arr) - 1
        while (i >= 0) { set result = push(result, arr[i]); set i = i - 1 }
        return result
      }
      let r = reverse([1,2,3,4,5])
      for (x in r) { puts(x) }
    `);
    assert.equal(result, '54321');
  });

  it('count occurrences', () => {
    const result = run(`
      let count = fn(arr, target) {
        let c = 0
        for (x in arr) { if (x == target) { set c = c + 1 } }
        return c
      }
      puts(count([1,2,3,2,1,2,3,2], 2))
    `);
    assert.equal(result, '4');
  });

  it('array flatten (1 level)', () => {
    const result = run(`
      let flatten = fn(arr) {
        let result = []
        for (sub in arr) {
          for (x in sub) {
            set result = push(result, x)
          }
        }
        return result
      }
      let f = flatten([[1,2],[3,4],[5,6]])
      puts(len(f))
      for (x in f) { puts(x) }
    `);
    assert.equal(result, '6123456');
  });
  
  it('sum of digits', () => {
    const result = run(`
      let digit_sum = fn(n) {
        let sum = 0
        while (n > 0) {
          set sum = sum + n % 10
          set n = n / 10
        }
        return sum
      }
      puts(digit_sum(12345))
      puts(digit_sum(99999))
    `);
    assert.equal(result, '1545');
  });
  
  it('power set size', () => {
    const result = run(`
      let pow = fn(base, exp) {
        if (exp == 0) { return 1 }
        return base * pow(base, exp - 1)
      }
      puts(pow(2, 5))
    `);
    assert.equal(result, '32');
  });
});

describe('Showcase: Data Processing', () => {
  it('running average', () => {
    const result = run(`
      let running_avg = fn(arr) {
        let sum = 0
        let results = []
        let i = 0
        while (i < len(arr)) {
          set sum = sum + arr[i]
          set results = push(results, sum / (i + 1))
          set i = i + 1
        }
        return results
      }
      let avgs = running_avg([10, 20, 30])
      puts(avgs[0])
      puts(avgs[1])
      puts(avgs[2])
    `);
    assert.equal(result, '101520');
  });
  
  it('dot product', () => {
    const result = run(`
      let dot = fn(a, b) {
        let sum = 0
        let i = 0
        while (i < len(a)) {
          set sum = sum + a[i] * b[i]
          set i = i + 1
        }
        return sum
      }
      puts(dot([1, 2, 3], [4, 5, 6]))
    `);
    assert.equal(result, '32');
  });
  
  it('array zip', () => {
    const result = run(`
      let zip = fn(a, b) {
        let result = []
        let i = 0
        while (i < len(a) && i < len(b)) {
          set result = push(result, [a[i], b[i]])
          set i = i + 1
        }
        return result
      }
      let z = zip([1,2,3], [10,20,30])
      puts(z[0][0])
      puts(z[0][1])
      puts(z[2][0])
      puts(z[2][1])
    `);
    assert.equal(result, '110330');
  });
});

describe('Showcase: Complete program suite', () => {
  it('selection sort', () => {
    const result = run(`
      let find_min_idx = fn(arr, start) {
        let min_idx = start
        let i = start + 1
        while (i < len(arr)) {
          if (arr[i] < arr[min_idx]) { set min_idx = i }
          set i = i + 1
        }
        return min_idx
      }
      let selection_sort = fn(arr) {
        let result = arr
        let i = 0
        while (i < len(result)) {
          let min_i = find_min_idx(result, i)
          if (min_i != i) {
            let tmp = result[i]
            let sorted = []
            let j = 0
            while (j < len(result)) {
              if (j == i) { set sorted = push(sorted, result[min_i]) }
              else { if (j == min_i) { set sorted = push(sorted, tmp) }
              else { set sorted = push(sorted, result[j]) } }
              set j = j + 1
            }
            set result = sorted
          }
          set i = i + 1
        }
        return result
      }
      let s = selection_sort([5, 2, 8, 1, 9])
      for (x in s) { puts(x) }
    `);
    assert.equal(result, '12589');
  });

  it('nth triangular number', () => {
    assert.equal(run('let tri = fn(n) { n * (n + 1) / 2 }; puts(tri(10)); puts(tri(100))'), '555050');
  });

  it('power modulo', () => {
    const result = run(`
      let pow_mod = fn(base, exp, mod) {
        let result = 1
        let i = 0
        while (i < exp) {
          set result = result * base % mod
          set i = i + 1
        }
        return result
      }
      puts(pow_mod(2, 10, 1000))
    `);
    assert.equal(result, '24');
  });
  
  it('sum of array with reduce pattern', () => {
    assert.equal(run(`
      let reduce = fn(arr, init, f) {
        let acc = init; let i = 0
        while (i < len(arr)) { set acc = f(acc, arr[i]); set i = i + 1 }
        return acc
      }
      let add = fn(a, b) { a + b }
      let mul = fn(a, b) { a * b }
      puts(reduce([1,2,3,4,5], 0, add))
      puts(reduce([1,2,3,4,5], 1, mul))
    `), '15120');
  });
});
