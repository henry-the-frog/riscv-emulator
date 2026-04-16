// disassembler.test.js — Tests for RISC-V disassembler
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { disassembleWord, disassemble } from './disassembler.js';
import { Assembler } from './assembler.js';

// Helper: assemble then disassemble and check round-trip
function roundTrip(asm) {
  const assembler = new Assembler();
  const result = assembler.assemble(asm);
  if (result.errors.length > 0) throw new Error(`Asm: ${result.errors.map(e=>e.message).join(', ')}`);
  const disasm = result.words.map((w, i) => disassembleWord(w, i * 4));
  return disasm;
}

describe('Disassembler — R-type instructions', () => {
  it('add', () => {
    const [asm] = roundTrip('add a0, a1, a2');
    assert.ok(asm.includes('add a0, a1, a2'));
  });

  it('sub', () => {
    const [asm] = roundTrip('sub t0, t1, t2');
    assert.ok(asm.includes('sub t0, t1, t2'));
  });

  it('and', () => {
    const [asm] = roundTrip('and s0, s1, s2');
    assert.ok(asm.includes('and s0, s1, s2'));
  });

  it('or', () => {
    const [asm] = roundTrip('or a0, a1, a2');
    assert.ok(asm.includes('or a0, a1, a2'));
  });

  it('xor', () => {
    const [asm] = roundTrip('xor a0, a1, a2');
    assert.ok(asm.includes('xor a0, a1, a2'));
  });

  it('slt', () => {
    const [asm] = roundTrip('slt a0, a1, a2');
    assert.ok(asm.includes('slt a0, a1, a2'));
  });

  it('sll', () => {
    const [asm] = roundTrip('sll a0, a1, a2');
    assert.ok(asm.includes('sll a0, a1, a2'));
  });

  it('srl', () => {
    const [asm] = roundTrip('srl a0, a1, a2');
    assert.ok(asm.includes('srl a0, a1, a2'));
  });

  it('sra', () => {
    const [asm] = roundTrip('sra a0, a1, a2');
    assert.ok(asm.includes('sra a0, a1, a2'));
  });
});

describe('Disassembler — RV32M', () => {
  it('mul', () => {
    const [asm] = roundTrip('mul a0, a1, a2');
    assert.ok(asm.includes('mul a0, a1, a2'));
  });

  it('div', () => {
    const [asm] = roundTrip('div a0, a1, a2');
    assert.ok(asm.includes('div a0, a1, a2'));
  });

  it('rem', () => {
    const [asm] = roundTrip('rem a0, a1, a2');
    assert.ok(asm.includes('rem a0, a1, a2'));
  });
});

describe('Disassembler — I-type instructions', () => {
  it('addi', () => {
    const [asm] = roundTrip('addi a0, a1, 42');
    assert.ok(asm.includes('addi a0, a1, 42'));
  });

  it('li (pseudo)', () => {
    const [asm] = roundTrip('li a0, 100');
    assert.ok(asm.includes('li a0, 100'));
  });

  it('mv (pseudo)', () => {
    const [asm] = roundTrip('mv a0, a1');
    assert.ok(asm.includes('mv a0, a1'));
  });

  it('negative immediate', () => {
    const [asm] = roundTrip('addi a0, a0, -1');
    assert.ok(asm.includes('addi a0, a0, -1'));
  });

  it('slli', () => {
    const [asm] = roundTrip('slli a0, a1, 2');
    assert.ok(asm.includes('slli a0, a1, 2'));
  });

  it('ori', () => {
    const [asm] = roundTrip('ori a0, a1, 1');
    assert.ok(asm.includes('ori a0, a1, 1'));
  });

  it('andi', () => {
    const [asm] = roundTrip('andi a0, a1, 255');
    assert.ok(asm.includes('andi a0, a1, 255'));
  });
});

describe('Disassembler — Load/Store', () => {
  it('lw', () => {
    const [asm] = roundTrip('lw a0, 0(sp)');
    assert.ok(asm.includes('lw a0, 0(sp)'));
  });

  it('sw', () => {
    const [asm] = roundTrip('sw a0, 4(sp)');
    assert.ok(asm.includes('sw a0, 4(sp)'));
  });

  it('lw with offset', () => {
    const [asm] = roundTrip('lw s0, 248(sp)');
    assert.ok(asm.includes('lw s0, 248(sp)'));
  });

  it('sw with negative offset', () => {
    const [asm] = roundTrip('sw ra, -4(s0)');
    assert.ok(asm.includes('sw ra, -4(s0)'));
  });
});

describe('Disassembler — Branch', () => {
  it('beq', () => {
    const asm = roundTrip('beq a0, a1, 8');
    assert.ok(asm[0].includes('beq a0, a1'));
  });

  it('bne', () => {
    const asm = roundTrip('bne a0, zero, 4');
    assert.ok(asm[0].includes('bne a0'));
  });

  it('blt', () => {
    const asm = roundTrip('blt a0, a1, 12');
    assert.ok(asm[0].includes('blt a0, a1'));
  });

  it('bge', () => {
    const asm = roundTrip('bge a0, a1, 8');
    assert.ok(asm[0].includes('bge a0, a1'));
  });
});

describe('Disassembler — Jump', () => {
  it('jal', () => {
    const asm = roundTrip('jal ra, 100');
    assert.ok(asm[0].includes('jal'));
  });

  it('ret (pseudo for jalr zero, ra, 0)', () => {
    const asm = roundTrip('ret');
    assert.ok(asm[0].includes('ret'));
  });

  it('ecall', () => {
    const asm = roundTrip('ecall');
    assert.ok(asm[0].includes('ecall'));
  });
});

describe('Disassembler — U-type', () => {
  it('lui', () => {
    const asm = roundTrip('lui a0, 0x12345');
    assert.ok(asm[0].includes('lui a0'));
  });
});

describe('Disassembler — full program', () => {
  it('disassembles compiled monkey program', () => {
    const assembler = new Assembler();
    const result = assembler.assemble(`
_start:
      li a0, 42
      li a7, 1
      ecall
      li a7, 10
      ecall
    `);
    const listing = disassemble(result.words);
    assert.ok(listing.includes('li a0, 42'));
    assert.ok(listing.includes('ecall'));
  });

  it('disassembles add program', () => {
    const assembler = new Assembler();
    const result = assembler.assemble(`
      addi a0, zero, 3
      addi a1, zero, 4
      add a2, a0, a1
      mv a0, a2
      li a7, 1
      ecall
      li a7, 10
      ecall
    `);
    const listing = disassemble(result.words);
    assert.ok(listing.includes('li a0, 3'));
    assert.ok(listing.includes('li a1, 4'));
    assert.ok(listing.includes('add a2, a0, a1'));
    assert.ok(listing.includes('mv a0, a2'));
    assert.ok(listing.includes('ecall'));
  });
});
