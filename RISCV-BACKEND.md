# Monkey-lang → RISC-V Compilation Backend

A complete compiler toolchain that compiles Monkey programming language to RISC-V machine code, running on an in-browser RISC-V CPU emulator.

## Pipeline

```
Monkey Source → Parse (AST) → Type Inference → Closure Analysis → Code Generation → Peephole Optimization → Assembly → Machine Code → RISC-V CPU Emulator
```

## Quick Start

```bash
# Run a program
node src/monkey-riscv.js -e 'puts(3 + 4)'

# Show generated assembly
node src/monkey-riscv.js --dump -e 'puts("hello world")'

# Show machine code disassembly
node src/monkey-riscv.js --disasm -e 'let x = 42; puts(x)'

# Run with optimizations (register allocation + peephole)
node src/monkey-riscv.js --opt -e 'let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }; puts(fib(15))'

# Run benchmarks (RISC-V vs VM)
node src/bench-riscv-vs-vm.js
```

## Supported Language Features

### Data Types
- **Integers**: Full 32-bit integer arithmetic (+, -, *, /, %)
- **Booleans**: `true`/`false` (represented as 1/0)
- **Strings**: Heap-allocated, char-by-char storage, concatenation with `+`, equality comparison via `_str_eq` subroutine
- **Arrays**: Heap-allocated, indexing, `len()`, `push()`, `first()`, `last()`
- **Hashes**: Heap-allocated key-value pairs, integer and string keys (4+ char keys supported)

### Control Flow
- **if/else**: Conditional branching
- **while**: Loop with condition
- **do-while**: Execute then check condition
- **for-in**: Array iteration
- **switch/case**: Pattern matching with default
- **Logical operators**: `&&` (short-circuit AND), `||` (short-circuit OR)
- **Ternary**: `cond ? a : b`

### Functions
- **Named functions**: `let f = fn(x) { x * 2 }`
- **Arrow functions**: `let f = x => x * 2`
- **Recursive functions**: Full recursion support (self-reference in scope)
- **Mutual recursion**: Forward declaration pass registers all function names
- **Cross-function calls**: Functions can call other top-level functions
- **Multiple parameters**: Up to 8 (a0-a7 registers)
- **Closures**: Functions that capture outer variables
- **Returning closures**: `let make_adder = fn(x) { fn(y) { x + y } }` — functions that return functions
- **Recursive closures**: Nested functions that call themselves
- **3+ level closures**: Transitive free variable propagation
- **Higher-order functions**: Functions as arguments — `apply(double, 5)`
- **Anonymous functions**: Inline function literals as arguments
- **Pipe operator**: `5 |> double |> puts`
- **Closure dispatch**: Trampoline-based dispatch for indirect closure calls
- **Null literal**: `null` compiles to 0

### Builtins
- `puts(x)`: Print integer or string (type-directed)
- `len(x)`: Array/string length
- `first(x)`: First array element
- `last(x)`: Last array element
- `push(arr, val)`: Create new array with element appended

### String Operations
- Concatenation: `"hello" + " " + "world"`
- Equality: `s1 == s2`, `s1 != s2` (via `_str_eq` subroutine — handles any length)
- Length: `len(s)`
- Indexing: `s[i]` returns character code

## Architecture

### Code Generation (`monkey-codegen.js`)
- AST → RISC-V assembly text
- Stack-based variable allocation with frame pointer (s0)
- Heap allocation via bump allocator (gp register)
- Closure objects: `[fn_id, num_captured, captured_var_0, ...]`
- Closure dispatch trampoline with arg-shifting for plain function references
- Function reference wrappers: functions used as values create closure objects
- Deferred function compilation (functions emitted after main code)

### Type Inference (`type-infer.js`)
- Call-site parameter type inference
- Return type inference
- Helps codegen choose string vs integer operations

### Closure Analysis (`closure-analysis.js`)
- Free variable detection across function boundaries
- Nested function expression handling (not just let-bound)
- Excludes global function references (call targets, not captures)
- Supports returning closures from functions

### Peephole Optimizer (`riscv-peephole.js`)
- 5 optimization patterns
- ~15% cycle reduction on recursive benchmarks
- Dead store elimination, redundant load removal, strength reduction

### Register Allocator
- Callee-saved registers (s1-s11)
- Spill to stack when registers exhausted

### Assembler (`assembler.js`)
- Full RV32I + RV32M instruction encoding
- Label resolution with forward references
- Pseudo-instruction expansion

### Disassembler (`disassembler.js`)
- RV32I + RV32M decode
- Symbol resolution

## Performance Benchmarks

RISC-V native compilation vs Monkey bytecode VM:

| Benchmark | RISC-V | VM | Speedup |
|-----------|--------|-----|---------|
| sum 1..1000 | 2.1ms | 10.8ms | **5.2x** |
| nested loops (20×20) | 1.4ms | 4.2ms | **3.1x** |
| Collatz(27) | 0.8ms | 1.9ms | **2.3x** |
| factorial(12) | 0.3ms | 0.2ms | 0.9x |
| fib(20) | 72.6ms | 40.0ms | 0.6x |
| fib(25) | 553ms | 174ms | 0.3x |

**Key insight**: RISC-V excels at iterative/loop-heavy code (5.2x). Deep recursion is slower due to emulator overhead.

## Showcase Programs

```monkey
// Higher-order: reduce/fold
let reduce = fn(arr, init, f) {
  let acc = init; let i = 0
  while (i < len(arr)) { set acc = f(acc, arr[i]); set i = i + 1 }
  return acc
}
let sum = fn(a, b) { a + b }
puts(reduce([1, 2, 3, 4, 5], 0, sum))  // 15

// Returning closures
let make_adder = fn(x) { fn(y) { x + y } }
let add5 = make_adder(5)
puts(add5(3))  // 8

// Function composition
let compose = fn(f, g, x) { f(g(x)) }
let double = fn(x) { x * 2 }
let add1 = fn(x) { x + 1 }
puts(compose(double, add1, 4))  // 10
```

## Test Coverage

- **723 backend tests** (codegen, closures, HOF, strings, hashes, arrays, showcase, stdlib, pipeline, peephole, regalloc, type inference, closure analysis, stress tests)
- **~2800 LOC** of compiler backend code
- **0 failures**, 100% pass rate ✅

## Known Limitations

- No garbage collector (bump allocation only — programs can't free memory)
- Anonymous functions in pipe operator not supported (use named functions)
- Call chaining `f(1)(2)(3)` syntax not supported (use `let` bindings)
- Closures capture values, not references (no mutable state in closures)
- Max 8 function parameters
- No float/decimal support (RV32I only, no F extension)
- No tail call optimization (deep recursion uses O(n) stack)
- 3+ level closure capture works via transitive propagation
