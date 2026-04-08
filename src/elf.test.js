'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ELFLoader } = require('./elf');
const { Assembler } = require('./assembler');
const { CPU } = require('./cpu');

// ============================================================
// ELF Loader Tests
// ============================================================

test('ELF: build minimal ELF and verify header', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi a0, zero, 42
    ebreak
  `);
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const header = loader.parseHeader();
  
  assert.equal(header.class, 1);      // ELF32
  assert.equal(header.encoding, 1);   // Little-endian
  assert.equal(header.machine, 243);  // RISC-V
  assert.equal(header.entry, 0x10000);
  assert.equal(header.phnum, 1);
});

test('ELF: parse program headers', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi a0, zero, 42
    ebreak
  `);
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const header = loader.parseHeader();
  const segments = loader.parseProgramHeaders(header);
  
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 1);  // PT_LOAD
  assert.equal(segments[0].vaddr, 0x10000);
  assert.equal(segments[0].memsz, 8); // 2 instructions × 4 bytes
});

test('ELF: load and execute', () => {
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi a0, zero, 42
    addi a7, zero, 93
    ecall
  `);
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const cpu = new CPU(1024 * 1024); // 1MB
  
  const info = loader.loadInto(cpu);
  assert.equal(info.entry, 0x10000);
  assert.equal(cpu.regs.pc, 0x10000);
  
  // Set up stack
  cpu.regs.set(2, 0x80000); // sp
  
  const result = cpu.run();
  assert.ok(result.halted);
  assert.equal(cpu.regs.get(10), 42);
  assert.equal(cpu.exitCode, 42);
});

test('ELF: fibonacci via ELF', () => {
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
    mv a0, t0
    addi a7, zero, 93
    ecall
  `);
  
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const cpu = new CPU(1024 * 1024);
  loader.loadInto(cpu);
  cpu.regs.set(2, 0x80000);
  
  cpu.run();
  assert.equal(cpu.exitCode, 55); // fib(10) = 55
});

test('ELF: bad magic throws', () => {
  const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const loader = new ELFLoader(bad);
  assert.throws(() => loader.parseHeader(), /Not an ELF file/);
});

test('ELF: wrong class throws', () => {
  const buf = new Uint8Array(52);
  buf[0] = 0x7F; buf[1] = 0x45; buf[2] = 0x4C; buf[3] = 0x46;
  buf[4] = 2; // ELF64
  buf[5] = 1; // LE
  const view = new DataView(buf.buffer);
  view.setUint16(18, 243, true); // RISC-V
  const loader = new ELFLoader(buf);
  assert.throws(() => loader.parseHeader(), /Expected ELF32/);
});

test('ELF: wrong machine throws', () => {
  const buf = new Uint8Array(52);
  buf[0] = 0x7F; buf[1] = 0x45; buf[2] = 0x4C; buf[3] = 0x46;
  buf[4] = 1; buf[5] = 1;
  const view = new DataView(buf.buffer);
  view.setUint16(18, 62, true); // x86-64
  const loader = new ELFLoader(buf);
  assert.throws(() => loader.parseHeader(), /Expected RISC-V/);
});

test('ELF: BSS zero-fill', () => {
  // Create ELF where memsz > filesz (BSS segment)
  const asm = new Assembler();
  const { words } = asm.assemble(`
    addi a0, zero, 1
    ebreak
  `);
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  
  // Manually patch memsz to be larger than filesz
  const view = new DataView(elf.buffer);
  const phOff = 52; // after ELF header
  const currentFilesz = view.getUint32(phOff + 16, true);
  view.setUint32(phOff + 20, currentFilesz + 16, true); // memsz = filesz + 16
  
  const loader = new ELFLoader(elf);
  const cpu = new CPU(1024 * 1024);
  
  // Pre-fill memory with 0xFF
  for (let i = 0x10000 + currentFilesz; i < 0x10000 + currentFilesz + 16; i++) {
    cpu.mem.storeByte(i, 0xFF);
  }
  
  loader.loadInto(cpu);
  
  // BSS should be zeroed
  for (let i = 0; i < 16; i++) {
    assert.equal(cpu.mem.loadByte(0x10000 + currentFilesz + i), 0);
  }
});

test('ELF: parse full info', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('ebreak');
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const info = loader.parse();
  
  assert.ok(info.header);
  assert.equal(info.segments.length, 1);
  assert.ok(Array.isArray(info.sections));
});

test('ELF: load segment flags', () => {
  const asm = new Assembler();
  const { words } = asm.assemble('ebreak');
  const elf = ELFLoader.buildMinimalELF(words, 0x10000);
  const loader = new ELFLoader(elf);
  const cpu = new CPU(1024 * 1024);
  const info = loader.loadInto(cpu);
  
  assert.equal(info.segments.length, 1);
  assert.ok(info.segments[0].readable);
  assert.ok(info.segments[0].executable);
  assert.ok(!info.segments[0].writable);
});
