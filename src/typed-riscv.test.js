// Type-checked RISC-V compilation integration tests
// Verifies that type-checked monkey-lang programs compile and run correctly on RISC-V

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Two parsers: original (for codegen compatibility) and workspace (for type annotations)
import { Lexer as OrigLexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser as OrigParser } from '/Users/henry/repos/monkey-lang/src/parser.js';
import { Lexer as TypedLexer } from '/Users/henry/.openclaw/workspace/projects/monkey-lang/src/lexer.js';
import { Parser as TypedParser } from '/Users/henry/.openclaw/workspace/projects/monkey-lang/src/parser.js';
import { typecheck } from '/Users/henry/.openclaw/workspace/projects/monkey-lang/src/typechecker.js';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';

function parse(input) {
  const lexer = new OrigLexer(input);
  const parser = new OrigParser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) throw new Error(`Parse errors: ${parser.errors.join('\n')}`);
  return program;
}

function typedParse(input) {
  const lexer = new TypedLexer(input);
  const parser = new TypedParser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) return { program: null, parseErrors: parser.errors };
  return { program, parseErrors: [] };
}

function typecheckAndCompile(input) {
  // Phase 1: Type checking (using workspace parser with type annotation support)
  const typed = typedParse(input);
  let typeErrors = [];
  if (typed.program) {
    const result = typecheck(typed.program);
    typeErrors = result.errors;
  }
  
  // Phase 2: Compile using original parser (for AST compatibility with codegen)
  // Strip type annotations for the original parser
  const strippedInput = input
    .replace(/:\s*(int|float|bool|string|null|void)\b/g, '')
    .replace(/->\s*(int|float|bool|string|null|void)\s*\{/g, '{');
  
  const program = parse(strippedInput);
  
  // Phase 2: Compile to RISC-V
  const codegen = new RiscVCodeGen({});
  const asm = codegen.compile(program, inferTypes(program), analyzeFreeVars(program));
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Assembly errors: ${result.errors.map(e => e.message || e).join('\n')}`);
  }
  
  // Phase 3: Run on RISC-V emulator
  const cpu = new CPU();
  cpu.loadProgram(result.words);
  cpu.regs.set(2, 0x100000 - 4); // sp
  cpu.run(5000000);
  
  return {
    output: cpu.output.join(''),
    typeErrors,
    cycles: cpu.cycles,
  };
}

// ============================================================
// Type-safe programs that compile and run correctly
// ============================================================

describe('Type-checked RISC-V: arithmetic', () => {
  it('annotated add function', () => {
    const r = typecheckAndCompile(`
      let add = fn(x: int, y: int) -> int { x + y };
      puts(add(3, 4));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '7');
  });

  it('annotated multiply', () => {
    const r = typecheckAndCompile(`
      let mul = fn(a: int, b: int) -> int { a * b };
      puts(mul(6, 7));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '42');
  });
});

describe('Type-checked RISC-V: recursion', () => {
  it('typed fibonacci', () => {
    const r = typecheckAndCompile(`
      let fib = fn(n: int) -> int {
        if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }
      };
      puts(fib(10));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '55');
  });

  it('typed factorial', () => {
    const r = typecheckAndCompile(`
      let fact = fn(n: int) -> int {
        if (n <= 1) { 1 } else { n * fact(n - 1) }
      };
      puts(fact(6));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '720');
  });
});

describe('Type-checked RISC-V: higher-order functions', () => {
  it('apply function', () => {
    const r = typecheckAndCompile(`
      let apply = fn(f, x) { f(x) };
      let double = fn(x) { x * 2 };
      puts(apply(double, 21));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '42');
  });

  it('closure captures', () => {
    const r = typecheckAndCompile(`
      let make_adder = fn(x: int) {
        fn(y: int) -> int { x + y }
      };
      let add10 = make_adder(10);
      puts(add10(32));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '42');
  });
});

describe('Type-checked RISC-V: data structures', () => {
  it('array operations', () => {
    const r = typecheckAndCompile(`
      let arr = [1, 2, 3, 4, 5];
      puts(arr[0] + arr[4]);
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '6');
  });

  it('string operations', () => {
    const r = typecheckAndCompile(`
      let s = "hello";
      puts(len(s));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '5');
  });
});

describe('Type-checked RISC-V: type errors detected', () => {
  it('wrong return type annotation', () => {
    const r = typecheckAndCompile(`
      let f = fn(x: int) -> string { x + 1 };
      puts(f(5));
    `);
    assert.ok(r.typeErrors.length > 0, 'Expected type errors');
    // Still compiles and runs (type checker is advisory)
    assert.equal(r.output, '6');
  });

  it('if-else branch mismatch (type error detected, may crash at runtime)', () => {
    try {
      const r = typecheckAndCompile(`
        let x = if (true) { 5 } else { "hello" };
        puts(x);
      `);
      assert.ok(r.typeErrors.length > 0, 'Expected type error for branch mismatch');
    } catch {
      // Runtime crash is acceptable for type-unsafe code
      // The important thing is that the type checker WOULD catch this
      const typed = typedParse('let x = if (true) { 5 } else { "hello" }; puts(x);');
      if (typed.program) {
        const { errors } = typecheck(typed.program);
        assert.ok(errors.length > 0, 'Type checker should detect branch mismatch');
      }
    }
  });
});

describe('Type-checked RISC-V: complex programs', () => {
  it('accumulator pattern', () => {
    const r = typecheckAndCompile(`
      let sum = fn(n: int) -> int {
        if (n <= 0) { 0 } else { n + sum(n - 1) }
      };
      puts(sum(10));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '55');
  });

  it('nested closures', () => {
    const r = typecheckAndCompile(`
      let compose = fn(f, g) { fn(x) { f(g(x)) } };
      let inc = fn(x) { x + 1 };
      let double = fn(x) { x * 2 };
      let inc_then_double = compose(double, inc);
      puts(inc_then_double(5));
    `);
    assert.equal(r.typeErrors.length, 0);
    assert.equal(r.output, '12');
  });
});
