# RISC-V Emulator

A complete RISC-V RV32IM emulator built from scratch in JavaScript. Zero dependencies. 121 tests.

## What's Inside

- **CPU Core** — Full RV32I base integer instruction set (47 instructions) + M extension (multiply/divide)
- **Assembler** — Two-pass assembler with labels, pseudo-instructions, directives
- **Disassembler** — Machine code → readable assembly, detects pseudo-instructions
- **Execution Tracer** — Step-by-step trace with register change tracking
- **ELF Loader** — Parse and load ELF32 RISC-V binaries
- **Pipeline Simulator** — 5-stage pipeline (IF/ID/EX/MEM/WB) with hazard detection, forwarding, stall analysis

## Architecture

```
┌─────────┐    ┌───────────┐    ┌─────────┐
│ Assembler│───▶│  CPU Core  │───▶│ Tracer  │
│ (text→mc)│    │ (fetch/    │    │ (step-  │
└─────────┘    │  decode/   │    │  by-step)│
               │  execute)  │    └─────────┘
┌─────────┐    │            │    ┌──────────┐
│ELF Loader│──▶│ Memory     │    │Disassemb.│
│(bin→mem) │    │ Registers  │───▶│(mc→text) │
└─────────┘    └───────────┘    └──────────┘
                     │
               ┌─────┴─────┐
               │  Pipeline  │
               │ Simulator  │
               │ (5-stage)  │
               └───────────┘
```

## Usage

```javascript
const { CPU } = require('./src/cpu');
const { Assembler } = require('./src/assembler');

// Assemble and run
const asm = new Assembler();
const { words } = asm.assemble(`
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
  mv a0, t0        # a0 = fib(10) = 55
  ebreak
`);

const cpu = new CPU();
cpu.loadProgram(words);
cpu.regs.set(2, 0x80000); // stack pointer
const result = cpu.run();
console.log(`fib(10) = ${cpu.regs.get(10)}`); // 55
console.log(`Cycles: ${result.cycles}`);
```

## Instruction Set

### RV32I Base (47 instructions)

| Type | Instructions |
|------|-------------|
| R-type | ADD, SUB, SLL, SLT, SLTU, XOR, SRL, SRA, OR, AND |
| I-type | ADDI, SLTI, SLTIU, XORI, ORI, ANDI, SLLI, SRLI, SRAI |
| Load | LB, LH, LW, LBU, LHU |
| Store | SB, SH, SW |
| Branch | BEQ, BNE, BLT, BGE, BLTU, BGEU |
| Jump | JAL, JALR |
| Upper | LUI, AUIPC |
| System | ECALL, EBREAK, FENCE |

### M Extension (8 instructions)

MUL, MULH, MULHSU, MULHU, DIV, DIVU, REM, REMU

### Pseudo-Instructions

NOP, LI, LA, MV, NOT, NEG, SEQZ, SNEZ, J, JR, RET, CALL, BEQZ, BNEZ, BGT, BLE

## Pipeline Simulator

```javascript
const { PipelineCPU } = require('./src/pipeline');
const { Assembler } = require('./src/assembler');

const asm = new Assembler();
const { words } = asm.assemble(`
  addi t0, zero, 5
  addi t1, t0, 10    # RAW hazard — forwarded
  sw t1, 0(sp)
  lw t2, 0(sp)
  addi t3, t2, 1     # Load-use hazard — stall
  ebreak
`);

const pipe = new PipelineCPU();
pipe.loadProgram(words);
pipe.cpu.regs.set(2, 0x80000);

const stats = pipe.run();
console.log(stats);
// { totalCycles: 12, instructionsCompleted: 6, CPI: "2.00",
//   stallCycles: 1, flushCycles: 0, forwardings: 2 }

console.log(pipe.formatDiagram());
```

## ELF Loading

```javascript
const { ELFLoader } = require('./src/elf');
const { CPU } = require('./src/cpu');
const fs = require('fs');

// Load a RISC-V ELF binary
const binary = fs.readFileSync('program.elf');
const loader = new ELFLoader(binary);
const cpu = new CPU(4 * 1024 * 1024); // 4MB memory
const info = loader.loadInto(cpu);
cpu.regs.set(2, 0x300000); // stack pointer
cpu.run();
```

## Tests

```bash
node --test src/*.test.js
```

121 tests covering:
- Memory operations (byte/half/word, signed/unsigned, little-endian)
- Register file (x0 hardwired, overflow, ABI names)
- All RV32I instructions
- M extension (multiply/divide with edge cases)
- Assembler (label resolution, pseudo-instructions, directives)
- Algorithm tests (fibonacci, factorial, bubble sort, GCD, prime check)
- Recursive function calls with stack
- Disassembler round-trip
- Execution tracing
- ELF parsing and loading
- Pipeline hazard detection, forwarding, stalling

## What I Learned

Building a CPU emulator from scratch teaches you things no textbook can:

1. **Instruction encoding is elegant** — The RV32I format uses 6 instruction formats (R/I/S/B/U/J) that all decode from the same bit positions. The opcode is always bits [6:0], rd is always [11:7], etc.

2. **Sign extension is everywhere** — Almost every immediate needs sign extension. Getting it wrong produces subtle bugs that only appear with negative values.

3. **The `li` pseudo-instruction is surprisingly tricky** — Loading a 32-bit constant requires LUI+ADDI, but if the low 12 bits have the sign bit set, the ADDI sign-extends and you need to adjust the upper bits.

4. **Pipeline hazards are the real engineering** — The actual instruction set is straightforward. What makes CPUs hard is managing the pipeline: forwarding paths, stall logic, branch prediction, and keeping everything cycle-accurate.

5. **Multiply needs BigInt** — JavaScript's 64-bit floating point can't represent the full product of two 32-bit integers without precision loss. MULH/MULHU need BigInt for the upper 32 bits.

## License

MIT
