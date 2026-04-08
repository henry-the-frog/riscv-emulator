'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Assembler } = require('./assembler');
const { CPU } = require('./cpu');
const { Disassembler } = require('./disassembler');

function asmRun(source, maxCycles = 10000) {
  const asm = new Assembler();
  const { words, errors } = asm.assemble(source);
  if (errors.length > 0) throw new Error(`Assembly errors: ${errors.map(e => `L${e.line}: ${e.message}`).join(', ')}`);
  const cpu = new CPU(65536);
  cpu.loadProgram(words);
  cpu.regs.set(2, 65536 - 4);
  cpu.run(maxCycles);
  return cpu;
}

// ============================================================
// M Extension: Multiply
// ============================================================

test('M ext: MUL basic', () => {
  const cpu = asmRun(`
    addi t0, zero, 7
    addi t1, zero, 6
    mul a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 42);
});

test('M ext: MUL negative', () => {
  const cpu = asmRun(`
    addi t0, zero, -5
    addi t1, zero, 3
    mul a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -15);
});

test('M ext: MUL overflow (lower 32 bits)', () => {
  const cpu = asmRun(`
    li t0, 0x10000
    li t1, 0x10000
    mul a0, t0, t1   # 0x100000000 → lower 32 bits = 0
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 0);
});

test('M ext: MULH (upper 32 bits signed)', () => {
  const cpu = asmRun(`
    li t0, 0x10000
    li t1, 0x10000
    mulh a0, t0, t1   # 0x100000000 → upper 32 bits = 1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 1);
});

test('M ext: MULHU (upper 32 bits unsigned)', () => {
  const cpu = asmRun(`
    li t0, 0x10000
    li t1, 0x10000
    mulhu a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 1);
});

// ============================================================
// M Extension: Divide
// ============================================================

test('M ext: DIV basic', () => {
  const cpu = asmRun(`
    addi t0, zero, 42
    addi t1, zero, 7
    div a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 6);
});

test('M ext: DIV negative', () => {
  const cpu = asmRun(`
    addi t0, zero, -15
    addi t1, zero, 4
    div a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -3); // truncates toward zero
});

test('M ext: DIV by zero', () => {
  const cpu = asmRun(`
    addi t0, zero, 42
    div a0, t0, zero
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -1); // spec: -1
});

test('M ext: DIV overflow (MIN_INT / -1)', () => {
  const cpu = asmRun(`
    lui t0, 0x80000000
    addi t1, zero, -1
    div a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -2147483648); // spec: returns dividend
});

test('M ext: DIVU', () => {
  const cpu = asmRun(`
    addi t0, zero, -1    # 0xFFFFFFFF unsigned
    addi t1, zero, 2
    divu a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.getU(10), 0x7FFFFFFF);
});

test('M ext: REM basic', () => {
  const cpu = asmRun(`
    addi t0, zero, 17
    addi t1, zero, 5
    rem a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 2);
});

test('M ext: REM negative', () => {
  const cpu = asmRun(`
    addi t0, zero, -17
    addi t1, zero, 5
    rem a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -2); // sign of dividend
});

test('M ext: REM by zero', () => {
  const cpu = asmRun(`
    addi t0, zero, 42
    rem a0, t0, zero
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 42); // spec: returns dividend
});

test('M ext: REMU', () => {
  const cpu = asmRun(`
    addi t0, zero, -1    # 0xFFFFFFFF
    addi t1, zero, 3
    remu a0, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 0); // 0xFFFFFFFF % 3 = 0
});

// ============================================================
// Integration: Factorial with MUL
// ============================================================

test('M ext: factorial(10) with MUL', () => {
  const cpu = asmRun(`
    addi t0, zero, 1    # result
    addi t1, zero, 1    # i
    addi t2, zero, 11   # limit
  loop:
    mul t0, t0, t1
    addi t1, t1, 1
    bne t1, t2, loop
    mv a0, t0
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 3628800); // 10!
});

test('M ext: GCD with REM (Euclidean)', () => {
  const cpu = asmRun(`
    addi a0, zero, 48
    addi a1, zero, 36
  loop:
    beqz a1, done
    rem t0, a0, a1
    mv a0, a1
    mv a1, t0
    j loop
  done:
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 12);
});

test('M ext: isPrime check', () => {
  const cpu = asmRun(`
    addi s0, zero, 17   # number to check
    addi t0, zero, 2    # divisor
  loop:
    mul t1, t0, t0      # t1 = t0 * t0
    bgt t1, s0, prime   # if divisor^2 > n, it's prime
    rem t2, s0, t0
    beqz t2, not_prime
    addi t0, t0, 1
    j loop
  prime:
    addi a0, zero, 1
    j done
  not_prime:
    addi a0, zero, 0
  done:
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 1); // 17 is prime
});

// ============================================================
// Disassembler M extension
// ============================================================

test('M ext: disassemble MUL', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('mul a0, t0, t1');
  assert.equal(Disassembler.disassemble(words[0]), 'mul a0, t0, t1');
});

test('M ext: disassemble DIV', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('div a0, t0, t1');
  assert.equal(Disassembler.disassemble(words[0]), 'div a0, t0, t1');
});

test('M ext: disassemble REM', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('rem a0, t0, t1');
  assert.equal(Disassembler.disassemble(words[0]), 'rem a0, t0, t1');
});
