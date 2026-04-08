'use strict';

const { REG_NAMES } = require('./registers');
const { CPU } = require('./cpu');

/**
 * RISC-V RV32I Disassembler
 * Converts machine code words back to assembly text
 */

class Disassembler {
  static regName(r) {
    return REG_NAMES[r] || `x${r}`;
  }

  static disassemble(inst, pc = 0) {
    const d = CPU.decode(inst);
    const rd = Disassembler.regName(d.rd);
    const rs1 = Disassembler.regName(d.rs1);
    const rs2 = Disassembler.regName(d.rs2);

    switch (d.opcode) {
      case 0b0110111: // LUI
        return `lui ${rd}, 0x${((d.immU >>> 12) & 0xFFFFF).toString(16)}`;

      case 0b0010111: // AUIPC
        return `auipc ${rd}, 0x${((d.immU >>> 12) & 0xFFFFF).toString(16)}`;

      case 0b1101111: // JAL
        return d.rd === 0
          ? `j ${Disassembler._target(pc, d.immJ)}`
          : d.rd === 1
            ? `jal ${Disassembler._target(pc, d.immJ)}`
            : `jal ${rd}, ${Disassembler._target(pc, d.immJ)}`;

      case 0b1100111: // JALR
        if (d.rd === 0 && d.rs1 === 1 && d.immI === 0) return 'ret';
        if (d.rd === 0 && d.immI === 0) return `jr ${rs1}`;
        if (d.immI === 0) return `jalr ${rd}, ${rs1}`;
        return `jalr ${rd}, ${d.immI}(${rs1})`;

      case 0b1100011: // Branch
        return Disassembler._branch(d.funct3, rs1, rs2, pc, d.immB);

      case 0b0000011: // Load
        return Disassembler._load(d.funct3, rd, rs1, d.immI);

      case 0b0100011: // Store
        return Disassembler._store(d.funct3, rs1, rs2, d.immS);

      case 0b0010011: // ALU Immediate
        return Disassembler._aluImm(d, rd, rs1);

      case 0b0110011: // ALU Register
        return Disassembler._aluReg(d, rd, rs1, rs2);

      case 0b0001111: // FENCE
        return 'fence';

      case 0b1110011: // SYSTEM
        if (inst === 0x00000073) return 'ecall';
        if (inst === 0x00100073) return 'ebreak';
        return `system 0x${inst.toString(16)}`;

      default:
        return `.word 0x${(inst >>> 0).toString(16).padStart(8, '0')}`;
    }
  }

  static _target(pc, offset) {
    return `0x${((pc + offset) >>> 0).toString(16)}`;
  }

  static _branch(funct3, rs1, rs2, pc, immB) {
    const target = Disassembler._target(pc, immB);
    const mnemonics = { 0: 'beq', 1: 'bne', 4: 'blt', 5: 'bge', 6: 'bltu', 7: 'bgeu' };
    const mn = mnemonics[funct3] || `branch_${funct3}`;
    // Pseudo: beqz/bnez
    if (rs2 === 'zero' && (funct3 === 0 || funct3 === 1)) {
      return `${funct3 === 0 ? 'beqz' : 'bnez'} ${rs1}, ${target}`;
    }
    return `${mn} ${rs1}, ${rs2}, ${target}`;
  }

  static _load(funct3, rd, rs1, imm) {
    const mnemonics = { 0: 'lb', 1: 'lh', 2: 'lw', 4: 'lbu', 5: 'lhu' };
    return `${mnemonics[funct3] || 'load'} ${rd}, ${imm}(${rs1})`;
  }

  static _store(funct3, rs1, rs2, imm) {
    const mnemonics = { 0: 'sb', 1: 'sh', 2: 'sw' };
    return `${mnemonics[funct3] || 'store'} ${rs2}, ${imm}(${rs1})`;
  }

  static _aluImm(d, rd, rs1) {
    // Check for pseudo: addi rd, zero, imm → li rd, imm
    if (d.funct3 === 0 && d.rs1 === 0) {
      return d.immI === 0 && d.rd === 0 ? 'nop' : `li ${rd}, ${d.immI}`;
    }
    // addi rd, rs1, 0 → mv rd, rs1
    if (d.funct3 === 0 && d.immI === 0) {
      return `mv ${rd}, ${rs1}`;
    }
    const mnemonics = { 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi' };
    if (d.funct3 === 1) return `slli ${rd}, ${rs1}, ${d.rs2}`;
    if (d.funct3 === 5) {
      return d.funct7 === 0b0100000
        ? `srai ${rd}, ${rs1}, ${d.rs2}`
        : `srli ${rd}, ${rs1}, ${d.rs2}`;
    }
    return `${mnemonics[d.funct3]} ${rd}, ${rs1}, ${d.immI}`;
  }

  static _aluReg(d, rd, rs1, rs2) {
    // M extension
    if (d.funct7 === 0b0000001) {
      const mnemonics = { 0: 'mul', 1: 'mulh', 2: 'mulhsu', 3: 'mulhu', 4: 'div', 5: 'divu', 6: 'rem', 7: 'remu' };
      return `${mnemonics[d.funct3]} ${rd}, ${rs1}, ${rs2}`;
    }
    if (d.funct3 === 0 && d.funct7 === 0b0100000) return `sub ${rd}, ${rs1}, ${rs2}`;
    if (d.funct3 === 0 && d.funct7 === 0b0100000 && d.rs1 === 0) return `neg ${rd}, ${rs2}`;
    if (d.funct3 === 5 && d.funct7 === 0b0100000) return `sra ${rd}, ${rs1}, ${rs2}`;
    const mnemonics = { 0: 'add', 1: 'sll', 2: 'slt', 3: 'sltu', 4: 'xor', 5: 'srl', 6: 'or', 7: 'and' };
    return `${mnemonics[d.funct3]} ${rd}, ${rs1}, ${rs2}`;
  }

  /**
   * Disassemble a block of memory
   */
  static disassembleBlock(words, baseAddr = 0) {
    const lines = [];
    for (let i = 0; i < words.length; i++) {
      const pc = baseAddr + i * 4;
      const hex = (words[i] >>> 0).toString(16).padStart(8, '0');
      const asm = Disassembler.disassemble(words[i], pc);
      lines.push(`  0x${pc.toString(16).padStart(8, '0')}:  ${hex}  ${asm}`);
    }
    return lines.join('\n');
  }
}

/**
 * Execution tracer — runs CPU step by step and logs
 */
class Tracer {
  static trace(cpu, maxSteps = 1000) {
    const log = [];
    let steps = 0;
    while (!cpu.halted && steps < maxSteps) {
      const pc = cpu.regs.pc;
      const inst = cpu.mem.loadWord(pc);
      const asm = Disassembler.disassemble(inst, pc);
      const before = Array.from(cpu.regs.x);
      
      cpu.step();
      steps++;
      
      const after = Array.from(cpu.regs.x);
      
      // Find changed registers
      const changes = [];
      for (let i = 1; i < 32; i++) {
        if (before[i] !== after[i]) {
          changes.push(`${REG_NAMES[i]}=${after[i]}`);
        }
      }
      if (cpu.regs.pc !== pc + 4) {
        changes.push(`pc=0x${(cpu.regs.pc >>> 0).toString(16)}`);
      }

      log.push({
        pc,
        hex: (inst >>> 0).toString(16).padStart(8, '0'),
        asm,
        changes: changes.join(', ') || '-'
      });
    }
    return log;
  }

  static formatTrace(log) {
    return log.map(e =>
      `  0x${e.pc.toString(16).padStart(8, '0')}: ${e.hex}  ${e.asm.padEnd(30)} → ${e.changes}`
    ).join('\n');
  }
}

module.exports = { Disassembler, Tracer };
