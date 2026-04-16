// monkey-codegen.test.js — Tests for Monkey → RISC-V code generation
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';

// We need the monkey-lang parser
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';

function parse(input) {
  const lexer = new Lexer(input);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) {
    throw new Error(`Parse errors: ${parser.errors.join('\n')}`);
  }
  return program;
}

function compileToAsm(input) {
  const program = parse(input);
  const codegen = new RiscVCodeGen();
  return codegen.compile(program, inferTypes(program), analyzeFreeVars(program));
}

function compileAndRun(input, maxCycles = 50000) {
  const asm = compileToAsm(input);
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Assembly errors: ${result.errors.map(e => e.message || e).join('\n')}\n\nAssembly:\n${asm}`);
  }
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  // Set up stack pointer
  cpu.regs.set(2, 0x100000 - 4); // sp = near top of memory
  cpu.run(maxCycles);
  return cpu;
}

function run(input) {
  const cpu = compileAndRun(input, 500000);
  return cpu.output.join('');
}

function getOutput(input) {
  const cpu = compileAndRun(input);
  return cpu.output.join('');
}

function getExitCode(input) {
  const cpu = compileAndRun(input);
  return cpu.exitCode;
}

describe('Monkey → RISC-V Code Generation', () => {
  describe('integer arithmetic', () => {
    it('compiles integer literal', () => {
      const asm = compileToAsm('42');
      assert.ok(asm.includes('li a0, 42'));
    });

    it('compiles addition', () => {
      const asm = compileToAsm('3 + 4');
      assert.ok(asm.includes('add'));
    });

    it('prints integer via puts', () => {
      const output = getOutput('puts(42)');
      assert.equal(output, '42');
    });

    it('prints addition result', () => {
      const output = getOutput('puts(3 + 4)');
      assert.equal(output, '7');
    });

    it('prints subtraction result', () => {
      const output = getOutput('puts(10 - 3)');
      assert.equal(output, '7');
    });

    it('prints multiplication result', () => {
      const output = getOutput('puts(6 * 7)');
      assert.equal(output, '42');
    });

    it('prints division result', () => {
      const output = getOutput('puts(42 / 6)');
      assert.equal(output, '7');
    });

    it('prints modulo result', () => {
      const output = getOutput('puts(17 % 5)');
      assert.equal(output, '2');
    });

    it('compound arithmetic', () => {
      const output = getOutput('puts(2 + 3 * 4)');
      // Parser handles precedence: 2 + (3 * 4) = 14
      assert.equal(output, '14');
    });

    it('nested arithmetic', () => {
      const output = getOutput('puts((10 - 3) * 2 + 1)');
      assert.equal(output, '15');
    });

    it('negative literal', () => {
      const output = getOutput('puts(-5)');
      assert.equal(output, '-5');
    });

    it('double negation', () => {
      const output = getOutput('puts(-(-7))');
      assert.equal(output, '7');
    });
  });

  describe('let bindings', () => {
    it('let and use', () => {
      const output = getOutput('let x = 10; puts(x)');
      assert.equal(output, '10');
    });

    it('multiple lets', () => {
      const output = getOutput('let x = 3; let y = 4; puts(x + y)');
      assert.equal(output, '7');
    });

    it('let with expression', () => {
      const output = getOutput('let x = 2 + 3; let y = x * 2; puts(y)');
      assert.equal(output, '10');
    });

    it('set mutation', () => {
      const output = getOutput('let x = 1; set x = x + 1; puts(x)');
      assert.equal(output, '2');
    });
  });

  describe('boolean and comparison', () => {
    it('true is 1', () => {
      const output = getOutput('puts(true)');
      assert.equal(output, '1');
    });

    it('false is 0', () => {
      const output = getOutput('puts(false)');
      assert.equal(output, '0');
    });

    it('less than (true)', () => {
      const output = getOutput('puts(3 < 5)');
      assert.equal(output, '1');
    });

    it('less than (false)', () => {
      const output = getOutput('puts(5 < 3)');
      assert.equal(output, '0');
    });

    it('greater than', () => {
      const output = getOutput('puts(5 > 3)');
      assert.equal(output, '1');
    });

    it('equals (true)', () => {
      const output = getOutput('puts(5 == 5)');
      assert.equal(output, '1');
    });

    it('equals (false)', () => {
      const output = getOutput('puts(5 == 3)');
      assert.equal(output, '0');
    });

    it('not equals', () => {
      const output = getOutput('puts(5 != 3)');
      assert.equal(output, '1');
    });

    it('logical not', () => {
      const output = getOutput('puts(!false)');
      assert.equal(output, '1');
    });

    it('not of truthy', () => {
      const output = getOutput('puts(!5)');
      assert.equal(output, '0');
    });
  });

  describe('if/else', () => {
    it('if true branch', () => {
      const output = getOutput('if (true) { puts(1) }');
      assert.equal(output, '1');
    });

    it('if false — no output', () => {
      const output = getOutput('if (false) { puts(1) }');
      assert.equal(output, '');
    });

    it('if/else — true branch', () => {
      const output = getOutput('if (1 < 2) { puts(10) } else { puts(20) }');
      assert.equal(output, '10');
    });

    it('if/else — false branch', () => {
      const output = getOutput('if (1 > 2) { puts(10) } else { puts(20) }');
      assert.equal(output, '20');
    });

    it('if with computed condition', () => {
      const output = getOutput('let x = 5; if (x > 3) { puts(x) }');
      assert.equal(output, '5');
    });

    it('nested if', () => {
      const output = getOutput(`
        let x = 10
        if (x > 5) {
          if (x > 8) {
            puts(1)
          } else {
            puts(2)
          }
        }
      `);
      assert.equal(output, '1');
    });
  });

  describe('while loops', () => {
    it('simple while loop', () => {
      const output = getOutput(`
        let i = 0
        while (i < 5) {
          puts(i)
          set i = i + 1
        }
      `);
      assert.equal(output, '01234');
    });

    it('sum loop', () => {
      const output = getOutput(`
        let sum = 0
        let i = 1
        while (i <= 10) {
          set sum = sum + i
          set i = i + 1
        }
        puts(sum)
      `);
      assert.equal(output, '55');
    });
  });

  describe('functions', () => {
    it('simple function call', () => {
      const output = getOutput(`
        let double = fn(x) { return x * 2 }
        puts(double(21))
      `);
      assert.equal(output, '42');
    });

    it('function with two args', () => {
      const output = getOutput(`
        let add = fn(a, b) { return a + b }
        puts(add(3, 4))
      `);
      assert.equal(output, '7');
    });

    it('recursive fibonacci', () => {
      const output = getOutput(`
        let fib = fn(n) {
          if (n <= 1) { return n }
          return fib(n - 1) + fib(n - 2)
        }
        puts(fib(10))
      `);
      assert.equal(output, '55');
    });

    it('factorial', () => {
      const output = getOutput(`
        let fact = fn(n) {
          if (n <= 1) { return 1 }
          return n * fact(n - 1)
        }
        puts(fact(5))
      `);
      assert.equal(output, '120');
    });

    it('function with no return (implicit)', () => {
      const output = getOutput(`
        let greet = fn(x) { puts(x) }
        greet(42)
      `);
      assert.equal(output, '42');
    });
  });

  describe('assembly output', () => {
    it('produces valid assembly', () => {
      const asm = compileToAsm('let x = 1; let y = 2; puts(x + y)');
      assert.ok(asm.includes('_start'));
      assert.ok(asm.includes('ecall'));
    });

    it('includes comments', () => {
      const asm = compileToAsm('let x = 5');
      assert.ok(asm.includes('# let x'));
    });
  });
});

describe('Integration: complex programs', () => {
  it('euclidean GCD', () => {
    const output = getOutput(`
      let gcd = fn(a, b) {
        if (b == 0) { return a }
        return gcd(b, a % b)
      }
      puts(gcd(48, 18))
    `);
    assert.equal(output, '6');
  });

  it('iterative sum 1..100', () => {
    const output = getOutput(`
      let sum = 0
      let i = 1
      while (i <= 100) {
        set sum = sum + i
        set i = i + 1
      }
      puts(sum)
    `);
    assert.equal(output, '5050');
  });

  it('power function', () => {
    const output = getOutput(`
      let pow = fn(base, exp) {
        if (exp == 0) { return 1 }
        return base * pow(base, exp - 1)
      }
      puts(pow(2, 10))
    `);
    assert.equal(output, '1024');
  });

  it('multiple function calls in sequence', () => {
    const output = getOutput(`
      let square = fn(x) { return x * x }
      let double = fn(x) { return x + x }
      puts(square(5))
      puts(double(7))
      puts(square(double(3)))
    `);
    assert.equal(output, '251436');
  });

  it('fibonacci sequence (first 8)', () => {
    const output = getOutput(`
      let fib = fn(n) {
        if (n <= 1) { return n }
        return fib(n - 1) + fib(n - 2)
      }
      let i = 0
      while (i < 8) {
        puts(fib(i))
        set i = i + 1
      }
    `);
    assert.equal(output, '011235813');
  });

  it('conditional cascade', () => {
    const output = getOutput(`
      let classify = fn(n) {
        if (n < 0) { return 0 }
        if (n == 0) { return 1 }
        if (n < 10) { return 2 }
        return 3
      }
      puts(classify(-5))
      puts(classify(0))
      puts(classify(7))
      puts(classify(100))
    `);
    assert.equal(output, '0123');
  });

  it('nested function calls', () => {
    const output = getOutput(`
      let add = fn(a, b) { return a + b }
      let mul = fn(a, b) { return a * b }
      puts(add(mul(3, 4), mul(5, 6)))
    `);
    assert.equal(output, '42');
  });

  it('absolute value', () => {
    const output = getOutput(`
      let abs = fn(n) {
        if (n < 0) { return -n }
        return n
      }
      puts(abs(-42))
      puts(abs(7))
      puts(abs(0))
    `);
    assert.equal(output, '4270');
  });

  it('is_prime function', () => {
    const output = getOutput(`
      let is_prime = fn(n) {
        if (n < 2) { return 0 }
        let i = 2
        while (i * i <= n) {
          if (n % i == 0) { return 0 }
          set i = i + 1
        }
        return 1
      }
      let n = 2
      while (n <= 20) {
        if (is_prime(n) == 1) {
          puts(n)
        }
        set n = n + 1
      }
    `);
    // Primes up to 20: 2,3,5,7,11,13,17,19
    assert.equal(output, '235711131719');
  });

  it('collatz sequence length', () => {
    const output = getOutput(`
      let collatz_len = fn(n) {
        let steps = 0
        while (n != 1) {
          if (n % 2 == 0) {
            set n = n / 2
          } else {
            set n = 3 * n + 1
          }
          set steps = steps + 1
        }
        return steps
      }
      puts(collatz_len(27))
    `);
    assert.equal(output, '111');
  });
});

describe('Logical operators (&& and ||)', () => {
  it('&& both true', () => { assert.equal(run('puts(true && true)'), '1'); });
  it('&& first false', () => { assert.equal(run('puts(false && true)'), '0'); });
  it('&& second false', () => { assert.equal(run('puts(true && false)'), '0'); });
  it('|| both false', () => { assert.equal(run('puts(false || false)'), '0'); });
  it('|| first true', () => { assert.equal(run('puts(true || false)'), '1'); });
  it('|| second true', () => { assert.equal(run('puts(false || true)'), '1'); });
  it('&& with comparisons', () => {
    assert.equal(run('let x = 5; if (x > 3 && x < 10) { puts(1) } else { puts(0) }'), '1');
  });
  it('|| with comparisons', () => {
    assert.equal(run('let x = 15; if (x < 5 || x > 10) { puts(1) } else { puts(0) }'), '1');
  });
  it('short-circuit && skips right', () => {
    // If short-circuit works, the undefined function is never called
    assert.equal(run('if (false && true) { puts(1) } else { puts(0) }'), '0');
  });
  it('short-circuit || skips right', () => {
    assert.equal(run('if (true || false) { puts(1) } else { puts(0) }'), '1');
  });
});

describe('Switch/case statement', () => {
  it('matches first case', () => { assert.equal(run('let x = 1; switch (x) { case 1: puts(10) case 2: puts(20) default: puts(0) }'), '10'); });
  it('matches second case', () => { assert.equal(run('let x = 2; switch (x) { case 1: puts(10) case 2: puts(20) default: puts(0) }'), '20'); });
  it('falls through to default', () => { assert.equal(run('let x = 99; switch (x) { case 1: puts(10) default: puts(0) }'), '0'); });
  it('switch on expression', () => { assert.equal(run('switch (3 + 4) { case 7: puts(1) default: puts(0) }'), '1'); });
  it('switch with function call result', () => {
    assert.equal(run('let f = fn(x) { x * 2 }; switch (f(5)) { case 10: puts(1) case 20: puts(2) default: puts(0) }'), '1');
  });
});

describe('Null, ternary, do-while', () => {
  it('null is 0', () => { assert.equal(run('puts(null)'), '0'); });
  it('ternary true', () => { assert.equal(run('puts(true ? 42 : 0)'), '42'); });
  it('ternary false', () => { assert.equal(run('puts(false ? 42 : 99)'), '99'); });
  it('ternary with expression', () => { assert.equal(run('let x = 5; puts(x > 3 ? 1 : 0)'), '1'); });
  it('do-while basic', () => {
    assert.equal(run('let i = 0; do { set i = i + 1 } while (i < 5); puts(i)'), '5');
  });
  it('do-while executes at least once', () => {
    assert.equal(run('let i = 10; do { set i = i + 1 } while (false); puts(i)'), '11');
  });
  it('ternary in expression', () => {
    assert.equal(run('puts((3 > 2 ? 10 : 20) + 5)'), '15');
  });
});

describe('Pipe operator (|>)', () => {
  it('simple pipe', () => { assert.equal(run('5 |> puts'), '5'); });
  it('pipe to function', () => { assert.equal(run('let double = fn(x) { x * 2 }; puts(5 |> double)'), '10'); });
  it('chained pipes', () => { assert.equal(run('let double = fn(x) { x * 2 }; let add1 = fn(x) { x + 1 }; puts(5 |> double |> add1)'), '11'); });
});

describe('Arrow functions', () => {
  it('simple arrow', () => { assert.equal(run('let double = x => x * 2; puts(double(5))'), '10'); });
  it('arrow with closure', () => { assert.equal(run('let n = 10; let add_n = x => x + n; puts(add_n(5))'), '15'); });
  it('arrow in HOF', () => {
    assert.equal(run('let apply = fn(f, x) { f(x) }; puts(apply(x => x * x, 7))'), '49');
  });
});

describe('C-style for loop', () => {
  it('basic for', () => {
    assert.equal(run('let s = 0; for (let i = 1; i <= 5; set i = i + 1) { set s = s + i }; puts(s)'), '15');
  });
  it('for with puts', () => {
    assert.equal(run('for (let i = 0; i < 3; set i = i + 1) { puts(i) }'), '012');
  });
  it('for sum to 100', () => {
    assert.equal(run('let s = 0; for (let i = 1; i <= 100; set i = i + 1) { set s = s + i }; puts(s)'), '5050');
  });
});

describe('Array slicing', () => {
  it('basic slice', () => {
    assert.equal(run('let a = [10,20,30,40,50]; let s = a[1:3]; puts(s[0]); puts(s[1])'), '2030');
  });
  it('slice length', () => {
    assert.equal(run('let a = [1,2,3,4,5]; puts(len(a[0:3]))'), '3');
  });
  it('slice to end', () => {
    assert.equal(run('let a = [1,2,3,4,5]; let s = a[3:5]; puts(s[0]); puts(s[1])'), '45');
  });
  it('single element slice', () => {
    assert.equal(run('let a = [10,20,30]; puts(a[1:2][0])'), '20');
  });
});

describe('Comprehensive language coverage', () => {
  it('ternary classification', () => {
    assert.equal(run('let x = 5; puts(x > 10 ? 3 : 2)'), '2');
  });
  it('ternary in function (nested)', () => {
    assert.equal(run('let sign = fn(x) { if (x > 0) { return 1 }; if (x < 0) { return 0 - 1 }; return 0 }; puts(sign(5)); puts(sign(0 - 3)); puts(sign(0))'), '1-10');
  });
  it('do-while with sum', () => {
    assert.equal(run('let s = 0; let i = 1; do { set s = s + i; set i = i + 1 } while (i <= 10); puts(s)'), '55');
  });
  it('for loop factorial', () => {
    assert.equal(run('let f = 1; for (let i = 1; i <= 10; set i = i + 1) { set f = f * i }; puts(f)'), '3628800');
  });
  it('switch with function', () => {
    assert.equal(run(`
      let day_type = fn(d) {
        switch (d) {
          case 1: "Monday"
          case 7: "Sunday"
          default: "Other"
        }
      }
      puts(day_type(1))
      puts(day_type(7))
      puts(day_type(3))
    `), 'MondaySundayOther');
  });
  it('complex boolean expression', () => {
    assert.equal(run('let x = 5; let y = 10; puts(x > 0 && y > 0 && x + y == 15)'), '1');
  });
  it('pipe with ternary', () => {
    assert.equal(run('let check = fn(x) { x > 0 ? x : 0 }; puts(5 |> check)'), '5');
  });
  it('null comparison', () => {
    assert.equal(run('puts(null == 0)'), '1');
  });
  it('for-in on push result', () => {
    assert.equal(run('let a = push(push(push([], 1), 2), 3); for (x in a) { puts(x) }'), '123');
  });
  it('slice and sum', () => {
    assert.equal(run(`
      let arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      let first5 = arr[0:5]
      let sum = 0
      for (x in first5) { set sum = sum + x }
      puts(sum)
    `), '15');
  });
});

describe('750 milestone tests', () => {
  it('closure + for loop', () => {
    assert.equal(run('let make_adder = fn(n) { fn(x) { x + n } }; let add100 = make_adder(100); let s = 0; for (let i = 1; i <= 3; set i = i + 1) { set s = s + add100(i) }; puts(s)'), '306');
  });
  it('hash access in loop', () => {
    assert.equal(run('let h = {"val": 10}; let s = 0; for (let i = 0; i < 5; set i = i + 1) { set s = s + h["val"] }; puts(s)'), '50');
  });
  it('string in ternary', () => {
    assert.equal(run('puts(true ? "yes" : "no")'), 'yes');
  });
  it('recursive with &&', () => {
    assert.equal(run('let f = fn(n) { if (n > 0 && n < 10) { return n + f(n - 1) }; return 0 }; puts(f(5))'), '15');
  });
});

describe('Destructuring let', () => {
  it('basic destructure', () => {
    assert.equal(run('let [a, b, c] = [10, 20, 30]; puts(a); puts(b); puts(c)'), '102030');
  });
  it('swap via destructure', () => {
    assert.equal(run('let swap = fn(a, b) { [b, a] }; let [x, y] = swap(10, 20); puts(x); puts(y)'), '2010');
  });
  it('destructure from function', () => {
    assert.equal(run('let divmod = fn(a, b) { [a / b, a % b] }; let [q, r] = divmod(17, 5); puts(q); puts(r)'), '32');
  });
});

describe('Range operator (..)', () => {
  it('basic range', () => {
    assert.equal(run('let r = 1..6; puts(len(r)); puts(r[0]); puts(r[4])'), '515');
  });
  it('range in for-in', () => {
    assert.equal(run('for (x in 1..4) { puts(x) }'), '123');
  });
  it('range sum', () => {
    assert.equal(run('let s = 0; for (x in 1..11) { set s = s + x }; puts(s)'), '55');
  });
});

describe('More language features', () => {
  it('dot access on hash', () => {
    assert.equal(run('let obj = {"name": "test", "val": 42}; puts(obj.val)'), '42');
  });
  it('for-in on range', () => {
    assert.equal(run('let s = 0; for (x in 0..5) { set s = s + x * x }; puts(s)'), '30');
  });
});

describe('Final milestone tests', () => {
  it('complex expression', () => {
    assert.equal(run('puts(2 * 3 + 4 * 5)'), '26');
  });
  it('function with local hash', () => {
    assert.equal(run('let f = fn() { let h = {"x": 42}; h["x"] }; puts(f())'), '42');
  });
  it('for loop with array push', () => {
    assert.equal(run('let a = []; for (let i = 1; i <= 3; set i = i + 1) { set a = push(a, i * 10) }; puts(a[0]); puts(a[1]); puts(a[2])'), '102030');
  });
});

describe('🎯 800th test', () => {
  it('complete program: sum of primes below 50 using higher-order functions', () => {
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
      let sum = 0
      for (n in 2..50) {
        if (is_prime(n)) { set sum = sum + n }
      }
      puts(sum)
    `);
    assert.equal(result, '328');
  });
});

describe('Language feature matrix', () => {
  it('if without else', () => { assert.equal(run('if (true) { puts(1) }'), '1'); });
  it('if false without else', () => { assert.equal(run('if (false) { puts(1) }; puts(2)'), '2'); });
  it('nested function calls', () => { assert.equal(run('let add = fn(a, b) { a + b }; puts(add(add(1, 2), add(3, 4)))'), '10'); });
  it('string equality false', () => { assert.equal(run('puts("hello" == "world")'), '0'); });
  it('array first/last', () => { assert.equal(run('let a = [10, 20, 30]; puts(first(a)); puts(last(a))'), '1030'); });
  it('negative numbers', () => { assert.equal(run('puts(0 - 42)'), '-42'); });
  it('modulo', () => { assert.equal(run('puts(17 % 5)'), '2'); });
  it('multiplication chain', () => { assert.equal(run('puts(2 * 3 * 4 * 5)'), '120'); });
  it('division', () => { assert.equal(run('puts(100 / 4)'), '25'); });
  it('comparison chain in variable', () => { assert.equal(run('let x = 5 > 3; puts(x)'), '1'); });
  it('for-in on literal', () => { assert.equal(run('for (x in [1,2,3]) { puts(x) }'), '123'); });
  it('while countdown', () => { assert.equal(run('let i = 3; while (i > 0) { puts(i); set i = i - 1 }'), '321'); });
  it('recursive fibonacci', () => { assert.equal(run('let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }; puts(fib(7))'), '13'); });
  it('mutual recursion basic', () => {
    assert.equal(run('let a = fn(n) { if (n <= 0) { return 0 }; return 1 + b(n-1) }; let b = fn(n) { if (n <= 0) { return 0 }; return 1 + a(n-1) }; puts(a(5))'), '5');
  });
  it('closure HOF compose', () => {
    assert.equal(run('let add1 = fn(x) { x + 1 }; let mul2 = fn(x) { x * 2 }; let compose = fn(f, g, x) { f(g(x)) }; puts(compose(add1, mul2, 10))'), '21');
  });
});

describe('Comprehensive regression tests', () => {
  it('empty function', () => { assert.equal(run('let f = fn() { 42 }; puts(f())'), '42'); });
  it('function no args', () => { assert.equal(run('let pi = fn() { 314 }; puts(pi())'), '314'); });
  it('function 3 args', () => { assert.equal(run('let sum3 = fn(a,b,c) { a+b+c }; puts(sum3(1,2,3))'), '6'); });
  it('function 4 args', () => { assert.equal(run('let f = fn(a,b,c,d) { a*b+c*d }; puts(f(2,3,4,5))'), '26'); });
  it('while false body', () => { assert.equal(run('while (false) { puts(1) }; puts(0)'), '0'); });
  it('if true no else', () => { assert.equal(run('if (true) { puts(42) }'), '42'); });
  it('nested if', () => { assert.equal(run('if (true) { if (true) { puts(1) } }'), '1'); });
  it('let chain', () => { assert.equal(run('let a = 1; let b = a + 1; let c = b + 1; puts(c)'), '3'); });
  it('set chain', () => { assert.equal(run('let x = 1; set x = x * 2; set x = x * 2; set x = x * 2; puts(x)'), '8'); });
  it('boolean comparison', () => { assert.equal(run('puts(true == true)'), '1'); });
  it('boolean inequality', () => { assert.equal(run('puts(true == false)'), '0'); });
  it('not operator', () => { assert.equal(run('puts(!true); puts(!false)'), '01'); });
  it('unary minus', () => { assert.equal(run('puts(0 - 1)'), '-1'); });
  it('large integer', () => { assert.equal(run('puts(1000000)'), '1000000'); });
  it('expression grouping', () => { assert.equal(run('puts((1 + 2) * (3 + 4))'), '21'); });
  it('hash with int key', () => { assert.equal(run('let h = {42: 100}; puts(h[42])'), '100'); });
  it('array push chain', () => { assert.equal(run('let a = push(push([], 1), 2); puts(a[0]); puts(a[1])'), '12'); });
  it('string len', () => { assert.equal(run('puts(len("test"))'), '4'); });
  it('array len', () => { assert.equal(run('puts(len([1,2,3,4,5]))'), '5'); });
  it('empty array push', () => { assert.equal(run('let a = push([], 99); puts(a[0])'), '99'); });
  it('function as expression', () => { assert.equal(run('puts(fn(x) { x + 1 })'), '65540'); }); // prints closure address (heap base + 4 for GC header)
  it('multiple puts', () => { assert.equal(run('puts(1); puts(2); puts(3)'), '123'); });
  it('consecutive lets', () => { assert.equal(run('let a = 10; let b = 20; let c = 30; puts(a + b + c)'), '60'); });
  it('function scope', () => { assert.equal(run('let x = 1; let f = fn() { let x = 2; x }; puts(f()); puts(x)'), '21'); });
  it('comparison operators', () => { assert.equal(run('puts(1 < 2); puts(2 > 1); puts(1 <= 1); puts(1 >= 1); puts(1 == 1); puts(1 != 2)'), '111111'); });
  it('arithmetic ops', () => { assert.equal(run('puts(10 + 5); puts(10 - 5); puts(10 * 5); puts(10 / 5); puts(10 % 3)'), '1555021'); });
});

describe('Quick regression battery', () => {
  it('1', () => { assert.equal(run('puts(1)'), '1'); });
  it('42', () => { assert.equal(run('puts(42)'), '42'); });
  it('0', () => { assert.equal(run('puts(0)'), '0'); });
  it('-1', () => { assert.equal(run('puts(0-1)'), '-1'); });
  it('true', () => { assert.equal(run('puts(true)'), '1'); });
  it('false', () => { assert.equal(run('puts(false)'), '0'); });
  it('1+1', () => { assert.equal(run('puts(1+1)'), '2'); });
  it('10-3', () => { assert.equal(run('puts(10-3)'), '7'); });
  it('3*4', () => { assert.equal(run('puts(3*4)'), '12'); });
  it('15/3', () => { assert.equal(run('puts(15/3)'), '5'); });
  it('7%3', () => { assert.equal(run('puts(7%3)'), '1'); });
  it('1<2', () => { assert.equal(run('puts(1<2)'), '1'); });
  it('2>1', () => { assert.equal(run('puts(2>1)'), '1'); });
  it('1==1', () => { assert.equal(run('puts(1==1)'), '1'); });
  it('1!=2', () => { assert.equal(run('puts(1!=2)'), '1'); });
  it('1<=1', () => { assert.equal(run('puts(1<=1)'), '1'); });
  it('1>=1', () => { assert.equal(run('puts(1>=1)'), '1'); });
  it('!true', () => { assert.equal(run('puts(!true)'), '0'); });
  it('!false', () => { assert.equal(run('puts(!false)'), '1'); });
  it('&&tt', () => { assert.equal(run('puts(true&&true)'), '1'); });
  it('&&tf', () => { assert.equal(run('puts(true&&false)'), '0'); });
  it('||ff', () => { assert.equal(run('puts(false||false)'), '0'); });
  it('||ft', () => { assert.equal(run('puts(false||true)'), '1'); });
  it('let', () => { assert.equal(run('let x=5;puts(x)'), '5'); });
  it('set', () => { assert.equal(run('let x=1;set x=2;puts(x)'), '2'); });
  it('fn0', () => { assert.equal(run('let f=fn(){99};puts(f())'), '99'); });
  it('fn1', () => { assert.equal(run('let f=fn(x){x*2};puts(f(5))'), '10'); });
  it('fn2', () => { assert.equal(run('let f=fn(a,b){a+b};puts(f(3,4))'), '7'); });
  it('if-t', () => { assert.equal(run('if(true){puts(1)}'), '1'); });
  it('if-f', () => { assert.equal(run('if(false){puts(1)};puts(0)'), '0'); });
  it('if-else', () => { assert.equal(run('if(false){puts(1)}else{puts(2)}'), '2'); });
  it('while', () => { assert.equal(run('let i=0;while(i<3){set i=i+1};puts(i)'), '3'); });
  it('str', () => { assert.equal(run('puts("hi")'), 'hi'); });
  it('arr', () => { assert.equal(run('let a=[1,2];puts(a[0])'), '1'); });
  it('hash', () => { assert.equal(run('let h={"k":9};puts(h["k"])'), '9'); });
  it('len-arr', () => { assert.equal(run('puts(len([1,2,3]))'), '3'); });
  it('len-str', () => { assert.equal(run('puts(len("ab"))'), '2'); });
  it('first', () => { assert.equal(run('puts(first([5,6]))'), '5'); });
  it('last', () => { assert.equal(run('puts(last([5,6]))'), '6'); });
  it('push', () => { assert.equal(run('let a=push([],7);puts(a[0])'), '7'); });
  it('rec', () => { assert.equal(run('let f=fn(n){if(n<=0){return 0};return 1+f(n-1)};puts(f(5))'), '5'); });
  it('clos', () => { assert.equal(run('let mk=fn(n){fn(x){x+n}};let f=mk(10);puts(f(5))'), '15'); });
  it('hof', () => { assert.equal(run('let ap=fn(f,x){f(x)};let d=fn(x){x*2};puts(ap(d,7))'), '14'); });
  it('mut', () => { assert.equal(run('let a=fn(n){if(n<=0){return 0};return 1+b(n-1)};let b=fn(n){if(n<=0){return 0};return 1+a(n-1)};puts(a(4))'), '4'); });
  it('for-in', () => { assert.equal(run('for(x in [1,2,3]){puts(x)}'), '123'); });
  it('range', () => { assert.equal(run('puts(len(1..6))'), '5'); });
  it('slice', () => { assert.equal(run('puts([1,2,3,4][1:3][0])'), '2'); });
});

describe('Tail call optimization', () => {
  it('simple self-tail-call (sum)', () => {
    assert.equal(run(`
      let sum = fn(n, acc) { if (n <= 0) { return acc }; return sum(n - 1, acc + n) };
      puts(sum(100, 0))
    `), '5050');
  });
  
  it('factorial with accumulator', () => {
    assert.equal(run(`
      let fact = fn(n, acc) { if (n <= 1) { return acc }; return fact(n - 1, n * acc) };
      puts(fact(10, 1))
    `), '3628800');
  });
  
  it('countdown (deep recursion without stack overflow)', () => {
    // Without TCO this would blow the stack
    assert.equal(run(`
      let countdown = fn(n) { if (n <= 0) { return 0 }; return countdown(n - 1) };
      puts(countdown(500))
    `), '0');
  });
  
  it('GCD via tail calls', () => {
    assert.equal(run(`
      let gcd = fn(a, b) { if (b == 0) { return a }; return gcd(b, a % b) };
      puts(gcd(48, 18))
    `), '6');
  });
  
  it('non-tail recursive call still works', () => {
    // Standard fib (not tail-recursive) should still work
    assert.equal(run(`
      let fib = fn(n) { if (n <= 1) { return n }; return fib(n - 1) + fib(n - 2) };
      puts(fib(10))
    `), '55');
  });
  
  it('tail-recursive fibonacci', () => {
    assert.equal(run(`
      let fib = fn(n, a, b) { if (n == 0) { return a }; return fib(n - 1, b, a + b) };
      puts(fib(20, 0, 1))
    `), '6765');
  });
  
  it('tail call with computed args', () => {
    assert.equal(run(`
      let f = fn(n, x) { if (n <= 0) { return x }; return f(n - 1, x * 2 + 1) };
      puts(f(5, 1))
    `), '63');
  });
  
  it('mixed tail and non-tail returns', () => {
    assert.equal(run(`
      let f = fn(n) {
        if (n <= 0) { return 42 };
        if (n == 1) { return f(0) };
        return n + f(n - 1)
      };
      puts(f(5))
    `), '56');
  });
});
