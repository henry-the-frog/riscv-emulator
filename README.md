# RISC-V Emulator

A complete RISC-V RV32IM emulator and computer architecture simulator built from scratch in JavaScript. Zero dependencies. 193 tests.

## What's Inside

| Component | Description |
|-----------|-------------|
| **CPU Core** | Full RV32I base (47 instructions) + M extension (multiply/divide) |
| **Assembler** | Two-pass with labels, 16 pseudo-instructions, directives |
| **Disassembler** | Machine code → readable assembly with pseudo-instruction detection |
| **Execution Tracer** | Step-by-step trace with register change tracking |
| **ELF Loader** | Parse and load ELF32 RISC-V binaries |
| **Pipeline Simulator** | 5-stage (IF/ID/EX/MEM/WB) with hazard detection and forwarding |
| **Branch Predictors** | 7 strategies: static, 1-bit, 2-bit, GShare, Tournament |
| **Cache Simulator** | Direct-mapped through fully-associative, LRU/FIFO, multi-level hierarchy |
| **Virtual Memory (MMU)** | Sv32 two-level page tables, TLB with LRU, permission checks |
| **Trap/Interrupt System** | CSR file, exception handling, timer/software/external interrupts |

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │          RISC-V Emulator             │
                    ├─────────────────────────────────────┤
                    │                                     │
  ┌───────────┐     │  ┌──────────┐    ┌──────────────┐  │
  │ Assembler │────▶│  │ CPU Core │◀──▶│   Memory     │  │
  │(text→mc)  │     │  │ RV32IM   │    │ (byte-addr)  │  │
  └───────────┘     │  └────┬─────┘    └──────┬───────┘  │
                    │       │                  │          │
  ┌───────────┐     │  ┌────┴─────┐    ┌──────┴───────┐  │
  │ELF Loader │────▶│  │   MMU    │    │    Cache     │  │
  │(bin→mem)  │     │  │  Sv32    │    │ L1/L2/L3    │  │
  └───────────┘     │  │  + TLB   │    │ LRU/FIFO    │  │
                    │  └──────────┘    └──────────────┘  │
  ┌───────────┐     │                                     │
  │Disassemb. │◀────│  ┌──────────┐    ┌──────────────┐  │
  │(mc→text)  │     │  │ Pipeline │    │   Branch     │  │
  └───────────┘     │  │ 5-stage  │    │  Predictor   │  │
                    │  │ IF→WB    │    │ 7 strategies │  │
  ┌───────────┐     │  └──────────┘    └──────────────┘  │
  │  Tracer   │◀────│                                     │
  │(step log) │     │  ┌──────────┐                      │
  └───────────┘     │  │  Traps   │                      │
                    │  │ CSR/IRQ  │                      │
                    │  └──────────┘                      │
                    └─────────────────────────────────────┘
```

## Quick Start

```javascript
const { CPU } = require('./src/cpu');
const { Assembler } = require('./src/assembler');

const asm = new Assembler();
const { words } = asm.assemble(`
  # Fibonacci(10)
  addi t0, zero, 0
  addi t1, zero, 1
  addi t2, zero, 10
  addi t3, zero, 0
loop:
  beq t3, t2, done
  add t4, t0, t1
  mv t0, t1
  mv t1, t4
  addi t3, t3, 1
  j loop
done:
  mv a0, t0
  ebreak
`);

const cpu = new CPU();
cpu.loadProgram(words);
cpu.regs.set(2, 0x80000);
cpu.run();
console.log(`fib(10) = ${cpu.regs.get(10)}`); // 55
```

## Instruction Set

### RV32I Base (47 instructions)
ADD, SUB, SLL, SLT, SLTU, XOR, SRL, SRA, OR, AND, ADDI, SLTI, SLTIU, XORI, ORI, ANDI, SLLI, SRLI, SRAI, LB, LH, LW, LBU, LHU, SB, SH, SW, BEQ, BNE, BLT, BGE, BLTU, BGEU, JAL, JALR, LUI, AUIPC, ECALL, EBREAK, FENCE

### M Extension (8 instructions)
MUL, MULH, MULHSU, MULHU, DIV, DIVU, REM, REMU

### Pseudo-Instructions (16)
NOP, LI, LA, MV, NOT, NEG, SEQZ, SNEZ, J, JR, RET, CALL, BEQZ, BNEZ, BGT, BLE

## Pipeline Simulator

```javascript
const { PipelineCPU } = require('./src/pipeline');

const pipe = new PipelineCPU();
pipe.loadProgram(words);
const stats = pipe.run();
// { totalCycles: 12, CPI: "1.50", stallCycles: 1, forwardings: 3 }
```

## Branch Predictors

```javascript
const { PredictorBenchmark } = require('./src/branch-predictor');

const bench = new PredictorBenchmark();
const trace = PredictorBenchmark.loopTrace(0x100, 1000);
const results = bench.run(trace);
console.log(PredictorBenchmark.formatResults(results));
// AlwaysNotTaken   |     0.1% |        999 | 1/1001
// TwoBit           |    99.8% |          2 | 999/1001
// GShare           |    99.0% |         10 | 991/1001
// Tournament       |    99.5% |          5 | 996/1001
```

## Cache Simulator

```javascript
const { Cache, CacheHierarchy } = require('./src/cache');

// L1 + L2 hierarchy
const hierarchy = new CacheHierarchy([
  { size: 32768, blockSize: 64, ways: 8, policy: 'LRU' },   // 32KB L1
  { size: 262144, blockSize: 64, ways: 4, policy: 'LRU' },  // 256KB L2
]);

// Simulate access pattern
for (let i = 0; i < 10000; i++) hierarchy.read(i * 4);
console.log(hierarchy.getStats());
```

## Virtual Memory

```javascript
const { MMU, setupIdentityPageTable } = require('./src/mmu');
const { Memory } = require('./src/memory');

const mem = new Memory(4 * 1024 * 1024);
const mmu = new MMU(mem);
setupIdentityPageTable(mem, 0x200000, 256);
mmu.enable(0x200000);

const phys = mmu.translate(0x1000, 'R');
console.log(mmu.getStats()); // { translations, pageWalks, tlb: { hitRate } }
```

## Trap/Interrupt System

```javascript
const { CSRFile, TrapController, CAUSE_TIMER_INT, MSTATUS_MIE, MIE_MTIE } = require('./src/traps');

const csrs = new CSRFile();
const trap = new TrapController(csrs);
csrs.write(0x305, 0x2000);      // mtvec = handler address
csrs.write(0x300, MSTATUS_MIE); // Enable interrupts
csrs.write(0x304, MIE_MTIE);    // Enable timer interrupt

trap.raiseTimerInterrupt();
const cause = trap.checkPendingInterrupt(); // CAUSE_TIMER_INT
const handlerPC = trap.handleTrap(0x1000, cause);
```

## Tests

```bash
node --test src/*.test.js
```

193 tests covering:
- Memory (byte/half/word, signed/unsigned, little-endian, strings)
- Registers (x0 hardwired, overflow, ABI names)
- All RV32I + M extension instructions
- Assembler (labels, pseudo-instructions, directives)
- Algorithms (fibonacci, factorial, bubble sort, GCD, prime check)
- Recursive functions with stack frames
- Disassembler round-trip
- ELF32 parsing and loading
- Pipeline hazards, forwarding, stalling
- Branch predictor accuracy across patterns
- Cache hit rates, LRU/FIFO, conflict/capacity misses
- Sv32 page table walks, TLB caching, permission faults
- CSR read/write, trap handling, interrupt priority

## What I Learned

1. **Instruction encoding is elegant** — RV32I uses 6 formats that all decode from the same bit positions
2. **Sign extension is everywhere** — Almost every immediate needs it; getting it wrong produces subtle bugs
3. **The `li` pseudo is surprisingly tricky** — LUI+ADDI with sign-extension adjustment for the upper bits
4. **Pipeline hazards are the real engineering** — Forwarding paths, stall logic, and branch prediction make CPUs hard
5. **Multiply needs BigInt** — JS floats can't represent full 64-bit products without precision loss
6. **Cache geometry determines performance** — Row vs column matrix access shows 2-5x hit rate difference
7. **Two-level page tables are a space/time trade-off** — Sv32 covers 4GB address space with only 4KB per level

## License

MIT
