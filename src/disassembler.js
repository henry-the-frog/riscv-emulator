// disassembler.js — RISC-V RV32I/RV32M Disassembler
//
// Decodes 32-bit machine words back to human-readable assembly text.
// Supports all RV32I instructions and RV32M multiply/divide extension.

const REG_NAMES = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'
];

function reg(n) { return REG_NAMES[n & 0x1F]; }
function sext(val, bits) {
  val = val & ((1 << bits) - 1); // Mask to N bits first
  const mask = 1 << (bits - 1);
  return (val ^ mask) - mask;
}

/**
 * Disassemble a single 32-bit RISC-V instruction.
 * @param {number} word - The 32-bit instruction word
 * @param {number} pc - Program counter (for branch/jump target display)
 * @returns {string} Assembly text
 */
export function disassembleWord(word, pc = 0) {
  const opcode = word & 0x7F;
  const rd = (word >> 7) & 0x1F;
  const funct3 = (word >> 12) & 0x7;
  const rs1 = (word >> 15) & 0x1F;
  const rs2 = (word >> 20) & 0x1F;
  const funct7 = (word >> 25) & 0x7F;

  switch (opcode) {
    // R-type: register-register operations
    case 0b0110011: {
      if (funct7 === 0x01) {
        // RV32M extension
        const ops = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
        return `${ops[funct3]} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
      }
      const ops = {
        0: funct7 === 0x20 ? 'sub' : 'add',
        1: 'sll',
        2: 'slt',
        3: 'sltu',
        4: 'xor',
        5: funct7 === 0x20 ? 'sra' : 'srl',
        6: 'or',
        7: 'and',
      };
      return `${ops[funct3]} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`;
    }

    // I-type: immediate operations
    case 0b0010011: {
      const imm = sext(word >> 20, 12);
      const ops = { 0: 'addi', 1: 'slli', 2: 'slti', 3: 'sltiu', 4: 'xori', 5: funct7 === 0x20 ? 'srai' : 'srli', 6: 'ori', 7: 'andi' };
      const shamt = (word >> 20) & 0x1F;
      if (funct3 === 1 || funct3 === 5) {
        return `${ops[funct3]} ${reg(rd)}, ${reg(rs1)}, ${shamt}`;
      }
      // Pseudo-instruction detection
      if (funct3 === 0 && rs1 === 0) return `li ${reg(rd)}, ${imm}`;
      if (funct3 === 0 && imm === 0) return `mv ${reg(rd)}, ${reg(rs1)}`;
      return `${ops[funct3]} ${reg(rd)}, ${reg(rs1)}, ${imm}`;
    }

    // Load instructions
    case 0b0000011: {
      const imm = sext(word >> 20, 12);
      const ops = { 0: 'lb', 1: 'lh', 2: 'lw', 4: 'lbu', 5: 'lhu' };
      return `${ops[funct3] || '???'} ${reg(rd)}, ${imm}(${reg(rs1)})`;
    }

    // S-type: store instructions
    case 0b0100011: {
      const imm = sext(((word >> 25) << 5) | ((word >> 7) & 0x1F), 12);
      const ops = { 0: 'sb', 1: 'sh', 2: 'sw' };
      return `${ops[funct3] || '???'} ${reg(rs2)}, ${imm}(${reg(rs1)})`;
    }

    // B-type: branch instructions
    case 0b1100011: {
      const imm = sext(
        (((word >> 31) & 1) << 12) |
        (((word >> 7) & 1) << 11) |
        (((word >> 25) & 0x3F) << 5) |
        (((word >> 8) & 0xF) << 1),
        13
      );
      const ops = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };
      const target = pc + imm;
      return `${ops[funct3] || '???'} ${reg(rs1)}, ${reg(rs2)}, 0x${target.toString(16)}`;
    }

    // U-type: LUI
    case 0b0110111: {
      const imm = (word >>> 12) & 0xFFFFF;
      return `lui ${reg(rd)}, ${imm}`;
    }

    // U-type: AUIPC
    case 0b0010111: {
      const imm = (word >>> 12) & 0xFFFFF;
      return `auipc ${reg(rd)}, ${imm}`;
    }

    // J-type: JAL
    case 0b1101111: {
      const imm = sext(
        (((word >> 31) & 1) << 20) |
        (((word >> 12) & 0xFF) << 12) |
        (((word >> 20) & 1) << 11) |
        (((word >> 21) & 0x3FF) << 1),
        21
      );
      const target = pc + imm;
      if (rd === 0) return `j 0x${target.toString(16)}`;
      return `jal ${reg(rd)}, 0x${target.toString(16)}`;
    }

    // JALR
    case 0b1100111: {
      const imm = sext(word >> 20, 12);
      if (rd === 0 && rs1 === 1 && imm === 0) return 'ret';
      if (rd === 0) return `jr ${reg(rs1)}`;
      return `jalr ${reg(rd)}, ${imm}(${reg(rs1)})`;
    }

    // SYSTEM
    case 0b1110011: {
      if (word === 0x00000073) return 'ecall';
      if (word === 0x00100073) return 'ebreak';
      return `system 0x${word.toString(16)}`;
    }

    // FENCE
    case 0b0001111: {
      return 'fence';
    }

    default:
      return `unknown 0x${word.toString(16)} (opcode=0b${opcode.toString(2).padStart(7, '0')})`;
  }
}

/**
 * Disassemble an array of 32-bit words.
 * @param {number[]} words - Machine code words
 * @param {number} startPC - Starting program counter
 * @returns {string} Formatted assembly listing
 */
export function disassemble(words, startPC = 0) {
  const lines = [];
  for (let i = 0; i < words.length; i++) {
    const pc = startPC + i * 4;
    const hex = (words[i] >>> 0).toString(16).padStart(8, '0');
    const asm = disassembleWord(words[i], pc);
    lines.push(`  ${pc.toString(16).padStart(4, '0')}: ${hex}  ${asm}`);
  }
  return lines.join('\n');
}
