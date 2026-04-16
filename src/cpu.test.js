import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from './memory.js';
import { Registers, REG_NAMES, REG_NUMBERS } from './registers.js';
import { CPU } from './cpu.js';

// ============================================================
// Memory Tests
// ============================================================

test('Memory: byte load/store', () => {
  const mem = new Memory(256);
  mem.storeByte(0, 0x42);
  assert.equal(mem.loadByte(0), 0x42);
  mem.storeByte(10, 0xFF);
  assert.equal(mem.loadByte(10), 0xFF);
  assert.equal(mem.loadByteSigned(10), -1);
});

test('Memory: halfword load/store (little-endian)', () => {
  const mem = new Memory(256);
  mem.storeHalf(0, 0x1234);
  assert.equal(mem.loadByte(0), 0x34); // low byte first
  assert.equal(mem.loadByte(1), 0x12);
  assert.equal(mem.loadHalf(0), 0x1234);
  mem.storeHalf(4, 0xFFFF);
  assert.equal(mem.loadHalfSigned(4), -1);
});

test('Memory: word load/store (little-endian)', () => {
  const mem = new Memory(256);
  mem.storeWord(0, 0xDEADBEEF);
  assert.equal(mem.loadByte(0), 0xEF);
  assert.equal(mem.loadByte(1), 0xBE);
  assert.equal(mem.loadByte(2), 0xAD);
  assert.equal(mem.loadByte(3), 0xDE);
  assert.equal(mem.loadWord(0), 0xDEADBEEF >>> 0);
  assert.equal(mem.loadWordSigned(0), (0xDEADBEEF | 0));
});

test('Memory: out of bounds throws', () => {
  const mem = new Memory(16);
  assert.throws(() => mem.loadWord(15), /out of bounds/);
  assert.throws(() => mem.storeByte(16, 0), /out of bounds/);
});

test('Memory: string load/store', () => {
  const mem = new Memory(256);
  mem.storeString(100, 'Hello RISC-V');
  assert.equal(mem.loadString(100), 'Hello RISC-V');
});

test('Memory: bulk load/store', () => {
  const mem = new Memory(256);
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  mem.storeBytes(10, data);
  assert.deepEqual(Array.from(mem.loadBytes(10, 5)), [1, 2, 3, 4, 5]);
});

// ============================================================
// Register Tests
// ============================================================

test('Registers: x0 always zero', () => {
  const regs = new Registers();
  regs.set(0, 12345);
  assert.equal(regs.get(0), 0);
});

test('Registers: read/write x1-x31', () => {
  const regs = new Registers();
  for (let i = 1; i < 32; i++) {
    regs.set(i, i * 100);
    assert.equal(regs.get(i), i * 100);
  }
});

test('Registers: 32-bit signed overflow', () => {
  const regs = new Registers();
  regs.set(1, 0xFFFFFFFF);
  assert.equal(regs.get(1), -1);
  regs.set(2, 0x80000000);
  assert.equal(regs.get(2), -2147483648);
});

test('Registers: unsigned interpretation', () => {
  const regs = new Registers();
  regs.set(1, -1);
  assert.equal(regs.getU(1), 0xFFFFFFFF);
});

test('Register names', () => {
  assert.equal(REG_NAMES[0], 'zero');
  assert.equal(REG_NAMES[1], 'ra');
  assert.equal(REG_NAMES[2], 'sp');
  assert.equal(REG_NUMBERS['a0'], 10);
  assert.equal(REG_NUMBERS['fp'], 8);
  assert.equal(REG_NUMBERS['x31'], 31);
});

test('Registers: dump', () => {
  const regs = new Registers();
  regs.set(1, 0x1000);
  const dump = regs.dump();
  assert.ok(dump.includes('x01'));
  assert.ok(dump.includes('pc='));
});

// ============================================================
// CPU Decode Tests
// ============================================================

test('CPU: decode R-type (ADD x3, x1, x2)', () => {
  // ADD x3, x1, x2 = 0x002081B3
  const inst = 0x002081B3;
  const d = CPU.decode(inst);
  assert.equal(d.opcode, 0b0110011);
  assert.equal(d.rd, 3);
  assert.equal(d.funct3, 0);
  assert.equal(d.rs1, 1);
  assert.equal(d.rs2, 2);
  assert.equal(d.funct7, 0);
});

test('CPU: decode I-type (ADDI x1, x0, 42)', () => {
  // ADDI x1, x0, 42 = 0x02A00093
  const inst = 0x02A00093;
  const d = CPU.decode(inst);
  assert.equal(d.opcode, 0b0010011);
  assert.equal(d.rd, 1);
  assert.equal(d.funct3, 0);
  assert.equal(d.rs1, 0);
  assert.equal(d.immI, 42);
});

test('CPU: signExtend', () => {
  assert.equal(CPU.signExtend(0x7FF, 12), 2047);
  assert.equal(CPU.signExtend(0x800, 12), -2048);
  assert.equal(CPU.signExtend(0xFFF, 12), -1);
});

// ============================================================
// CPU Execution Tests — ALU
// ============================================================

// Helper: encode RV32I instructions
function encADDI(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b000 << 12) | (rd << 7) | 0b0010011;
}

function encADD(rd, rs1, rs2) {
  return (rs2 << 20) | (rs1 << 15) | (0b000 << 12) | (rd << 7) | 0b0110011;
}

function encSUB(rd, rs1, rs2) {
  return (0b0100000 << 25) | (rs2 << 20) | (rs1 << 15) | (0b000 << 12) | (rd << 7) | 0b0110011;
}

function encLUI(rd, imm) {
  return (imm & 0xFFFFF000) | (rd << 7) | 0b0110111;
}

function encECALL() { return 0x00000073; }
function encEBREAK() { return 0x00100073; }

function encSW(rs2, rs1, imm) {
  const hi = (imm >> 5) & 0x7F;
  const lo = imm & 0x1F;
  return (hi << 25) | (rs2 << 20) | (rs1 << 15) | (0b010 << 12) | (lo << 7) | 0b0100011;
}

function encLW(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b010 << 12) | (rd << 7) | 0b0000011;
}

function encBEQ(rs1, rs2, imm) {
  const b12 = (imm >> 12) & 1;
  const b11 = (imm >> 11) & 1;
  const b10_5 = (imm >> 5) & 0x3F;
  const b4_1 = (imm >> 1) & 0xF;
  return (b12 << 31) | (b10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (0b000 << 12) | (b4_1 << 8) | (b11 << 7) | 0b1100011;
}

function encBNE(rs1, rs2, imm) {
  const b12 = (imm >> 12) & 1;
  const b11 = (imm >> 11) & 1;
  const b10_5 = (imm >> 5) & 0x3F;
  const b4_1 = (imm >> 1) & 0xF;
  return (b12 << 31) | (b10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (0b001 << 12) | (b4_1 << 8) | (b11 << 7) | 0b1100011;
}

function encJAL(rd, imm) {
  const b20 = (imm >> 20) & 1;
  const b19_12 = (imm >> 12) & 0xFF;
  const b11 = (imm >> 11) & 1;
  const b10_1 = (imm >> 1) & 0x3FF;
  return (b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | (rd << 7) | 0b1101111;
}

function encJALR(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b000 << 12) | (rd << 7) | 0b1100111;
}

function encAUPC(rd, imm) {
  return (imm & 0xFFFFF000) | (rd << 7) | 0b0010111;
}

function encANDI(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b111 << 12) | (rd << 7) | 0b0010011;
}

function encORI(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b110 << 12) | (rd << 7) | 0b0010011;
}

function encXORI(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b100 << 12) | (rd << 7) | 0b0010011;
}

function encSLTI(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0b010 << 12) | (rd << 7) | 0b0010011;
}

function encSLLI(rd, rs1, shamt) {
  return (shamt << 20) | (rs1 << 15) | (0b001 << 12) | (rd << 7) | 0b0010011;
}

function encSRLI(rd, rs1, shamt) {
  return (shamt << 20) | (rs1 << 15) | (0b101 << 12) | (rd << 7) | 0b0010011;
}

function encSRAI(rd, rs1, shamt) {
  return (0b0100000 << 25) | (shamt << 20) | (rs1 << 15) | (0b101 << 12) | (rd << 7) | 0b0010011;
}

test('CPU: ADDI (x1 = x0 + 42)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 42),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(1), 42);
});

test('CPU: ADD (x3 = x1 + x2)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 10),
    encADDI(2, 0, 20),
    encADD(3, 1, 2),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 30);
});

test('CPU: SUB (x3 = x1 - x2)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 100),
    encADDI(2, 0, 37),
    encSUB(3, 1, 2),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 63);
});

test('CPU: LUI + ADDI (load 32-bit constant)', () => {
  const cpu = new CPU(4096);
  // Load 0x12345678 into x1
  // LUI x1, 0x12345000
  // ADDI x1, x1, 0x678
  cpu.loadProgram([
    encLUI(1, 0x12345000),
    encADDI(1, 1, 0x678),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.getU(1), 0x12345678);
});

test('CPU: ANDI, ORI, XORI', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 0xFF),
    encANDI(2, 1, 0x0F),
    encORI(3, 1, 0x100),
    encXORI(4, 1, 0xFF),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(2), 0x0F);
  assert.equal(cpu.regs.get(3), 0x1FF);
  assert.equal(cpu.regs.get(4), 0);
});

test('CPU: SLTI (set less than immediate)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 5),
    encSLTI(2, 1, 10),  // 5 < 10 → 1
    encSLTI(3, 1, 3),   // 5 < 3 → 0
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(2), 1);
  assert.equal(cpu.regs.get(3), 0);
});

test('CPU: shifts (SLLI, SRLI, SRAI)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 8),
    encSLLI(2, 1, 2),     // 8 << 2 = 32
    encSRLI(3, 1, 1),     // 8 >>> 1 = 4
    encADDI(4, 0, -16),
    encSRAI(5, 4, 2),     // -16 >> 2 = -4
    encSRLI(6, 4, 2),     // -16 >>> 2 (logical)
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(2), 32);
  assert.equal(cpu.regs.get(3), 4);
  assert.equal(cpu.regs.get(5), -4);
  assert.equal(cpu.regs.getU(6), 0x3FFFFFFC); // logical shift of negative
});

test('CPU: negative immediate (ADDI)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, -100),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(1), -100);
});

// ============================================================
// Branch / Jump Tests
// ============================================================

test('CPU: BEQ (branch taken)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 5),
    encADDI(2, 0, 5),
    encBEQ(1, 2, 8),    // branch +8 (skip next)
    encADDI(3, 0, 99),  // skipped
    encADDI(4, 0, 42),  // target
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 0);  // skipped
  assert.equal(cpu.regs.get(4), 42);
});

test('CPU: BNE (branch not taken)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 5),
    encADDI(2, 0, 5),
    encBNE(1, 2, 8),    // not taken (equal)
    encADDI(3, 0, 99),  // executed
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 99);
});

test('CPU: JAL (jump and link)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encJAL(1, 8),        // jump +8, ra=pc+4
    encADDI(2, 0, 99),  // skipped
    encADDI(3, 0, 42),  // target
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(1), 4);  // return address
  assert.equal(cpu.regs.get(2), 0);  // skipped
  assert.equal(cpu.regs.get(3), 42);
});

test('CPU: JALR (indirect jump)', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 12),  // target = 12
    encJALR(2, 1, 0),   // jump to x1, ra=pc+4
    encADDI(3, 0, 99),  // skipped
    encADDI(4, 0, 42),  // target at addr 12
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(2), 8);  // return address
  assert.equal(cpu.regs.get(3), 0);
  assert.equal(cpu.regs.get(4), 42);
});

test('CPU: AUIPC', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encAUPC(1, 0x1000),   // x1 = pc + 0x1000 = 0 + 0x1000
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.getU(1), 0x1000);
});

// ============================================================
// Load / Store Tests
// ============================================================

test('CPU: SW + LW (word store/load)', () => {
  const cpu = new CPU(8192);
  cpu.loadProgram([
    encADDI(1, 0, 0x7FF),  // value
    encLUI(2, 0x1000),      // base addr = 0x1000
    encSW(1, 2, 0),         // store at 0x1000
    encLW(3, 2, 0),         // load from 0x1000
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 0x7FF);
});

test('CPU: SW + LW with offset', () => {
  const cpu = new CPU(8192);
  cpu.loadProgram([
    encADDI(1, 0, 123),
    encLUI(2, 0x1000),
    encSW(1, 2, 16),       // store at 0x1010
    encLW(3, 2, 16),       // load from 0x1010
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(3), 123);
});

// ============================================================
// ECALL / EBREAK Tests
// ============================================================

test('CPU: ECALL print_int', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(10, 0, 42),     // a0 = 42
    encADDI(17, 0, 1),      // a7 = 1 (print_int)
    encECALL(),
    encEBREAK()
  ]);
  const result = cpu.run();
  assert.equal(result.output, '42');
});

test('CPU: ECALL exit', () => {
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(17, 0, 10),  // a7 = 10 (exit)
    encECALL(),
    encADDI(1, 0, 99),   // should not execute
  ]);
  const result = cpu.run();
  assert.ok(result.halted);
  assert.equal(cpu.regs.get(1), 0);
});

// ============================================================
// Integration: Loop
// ============================================================

test('CPU: simple loop (sum 1 to 10)', () => {
  // x1 = counter (starts at 1)
  // x2 = sum
  // x3 = limit (10)
  const cpu = new CPU(4096);
  cpu.loadProgram([
    encADDI(1, 0, 1),       // x1 = 1
    encADDI(2, 0, 0),       // x2 = 0
    encADDI(3, 0, 11),      // x3 = 11 (loop while x1 < 11)
    // loop: (offset 12)
    encADD(2, 2, 1),        // x2 += x1
    encADDI(1, 1, 1),       // x1++
    encBNE(1, 3, -8),       // if x1 != 11, jump to loop (offset -8)
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(2), 55); // 1+2+...+10
});

test('CPU: function call and return', () => {
  // Main: call double(7), result in a0
  // double: a0 = a0 * 2, return
  const cpu = new CPU(4096);
  cpu.loadProgram([
    // main:
    encADDI(10, 0, 7),     // a0 = 7
    encJAL(1, 8),           // call double (at offset +8 = addr 12)
    encEBREAK(),            // halt (addr 8)
    // double: (addr 12)
    encADD(10, 10, 10),     // a0 = a0 + a0
    encJALR(0, 1, 0),       // return (jump to ra)
  ]);
  cpu.run();
  assert.equal(cpu.regs.get(10), 14);
});

test('CPU: tracing mode', () => {
  const cpu = new CPU(4096);
  cpu.tracing = true;
  cpu.loadProgram([
    encADDI(1, 0, 5),
    encADDI(2, 0, 10),
    encEBREAK()
  ]);
  cpu.run();
  assert.equal(cpu.traceLog.length, 3); // 2 ADDIs + EBREAK
  assert.equal(cpu.traceLog[0].pc, 0);
});

test('CPU: max cycles limit', () => {
  const cpu = new CPU(4096);
  // Infinite loop
  cpu.loadProgram([
    encJAL(0, 0), // jump to self
  ]);
  const result = cpu.run(100);
  assert.equal(result.halted, false);
  assert.equal(result.cycles, 100);
});
