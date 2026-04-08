'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Disassembler, Tracer } = require('./disassembler');
const { Assembler } = require('./assembler');
const { CPU } = require('./cpu');

// ============================================================
// Disassembler Tests
// ============================================================

test('Disassembler: ADDI', () => {
  // ADDI x1, x0, 42
  const inst = 0x02A00093;
  assert.equal(Disassembler.disassemble(inst), 'li ra, 42');
});

test('Disassembler: ADD', () => {
  const inst = 0x002081B3; // ADD x3, x1, x2
  assert.equal(Disassembler.disassemble(inst), 'add gp, ra, sp');
});

test('Disassembler: NOP', () => {
  assert.equal(Disassembler.disassemble(0x00000013), 'nop');
});

test('Disassembler: ECALL/EBREAK', () => {
  assert.equal(Disassembler.disassemble(0x00000073), 'ecall');
  assert.equal(Disassembler.disassemble(0x00100073), 'ebreak');
});

test('Disassembler: RET', () => {
  // JALR x0, x1, 0
  assert.equal(Disassembler.disassemble(0x00008067), 'ret');
});

test('Disassembler: LW', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('lw a0, 16(sp)');
  assert.equal(Disassembler.disassemble(words[0]), 'lw a0, 16(sp)');
});

test('Disassembler: SW', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('sw a0, 16(sp)');
  assert.equal(Disassembler.disassemble(words[0]), 'sw a0, 16(sp)');
});

test('Disassembler: BEQ with target', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    beq t0, t1, target
    nop
  target:
    ebreak
  `);
  const dis = Disassembler.disassemble(words[0], 0);
  assert.ok(dis.includes('beq'));
  assert.ok(dis.includes('0x8')); // target at offset 8
});

test('Disassembler: round-trip simple program', () => {
  const source = `
    addi t0, zero, 10
    addi t1, zero, 20
    add t2, t0, t1
    ebreak
  `;
  const asm = new Assembler();
  const { words } = asm.assemble(source);
  const dis = Disassembler.disassembleBlock(words);
  assert.ok(dis.includes('li t0, 10'));
  assert.ok(dis.includes('li t1, 20'));
  assert.ok(dis.includes('add t2, t0, t1'));
  assert.ok(dis.includes('ebreak'));
});

test('Disassembler: LUI', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('lui a0, 0x12345000');
  const dis = Disassembler.disassemble(words[0]);
  assert.ok(dis.includes('lui'));
  assert.ok(dis.includes('12345'));
});

test('Disassembler: shifts', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    slli a0, t0, 4
    srli a1, t0, 2
    srai a2, t0, 3
  `);
  assert.ok(Disassembler.disassemble(words[0]).includes('slli'));
  assert.ok(Disassembler.disassemble(words[1]).includes('srli'));
  assert.ok(Disassembler.disassemble(words[2]).includes('srai'));
});

// ============================================================
// Tracer Tests
// ============================================================

test('Tracer: simple program trace', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi t0, zero, 5
    addi t1, zero, 10
    add t2, t0, t1
    ebreak
  `);
  const cpu = new CPU(4096);
  cpu.loadProgram(words);
  const log = Tracer.trace(cpu, 100);
  assert.equal(log.length, 4);
  assert.ok(log[0].asm.includes('li t0, 5'));
  assert.ok(log[0].changes.includes('t0=5'));
  assert.ok(log[2].asm.includes('add t2, t0, t1'));
  assert.ok(log[2].changes.includes('t2=15'));
});

test('Tracer: branch trace shows PC change', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi t0, zero, 5
    addi t1, zero, 5
    beq t0, t1, skip
    addi a0, zero, 99
  skip:
    ebreak
  `);
  const cpu = new CPU(4096);
  cpu.loadProgram(words);
  const log = Tracer.trace(cpu, 100);
  // BEQ should show PC change
  const branchEntry = log.find(e => e.asm.includes('beq'));
  assert.ok(branchEntry);
  assert.ok(branchEntry.changes.includes('pc='));
});

test('Tracer: format output', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi a0, zero, 42
    ebreak
  `);
  const cpu = new CPU(4096);
  cpu.loadProgram(words);
  const log = Tracer.trace(cpu, 100);
  const formatted = Tracer.formatTrace(log);
  assert.ok(formatted.includes('0x00000000'));
  assert.ok(formatted.includes('li a0, 42'));
  assert.ok(formatted.includes('a0=42'));
});

test('Tracer: loop trace', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi t0, zero, 0
    addi t1, zero, 3
  loop:
    addi t0, t0, 1
    bne t0, t1, loop
    ebreak
  `);
  const cpu = new CPU(4096);
  cpu.loadProgram(words);
  const log = Tracer.trace(cpu, 100);
  // Should see 2 + 3*2 + 1 = 9 steps
  assert.equal(log.length, 9);
});
