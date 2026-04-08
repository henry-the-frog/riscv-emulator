'use strict';

const { REG_NUMBERS } = require('./registers');

/**
 * RISC-V RV32I Assembler
 * Parses assembly text → array of 32-bit machine code words
 * 
 * Supports: labels, all RV32I instructions, pseudo-instructions
 * Two-pass: first pass collects labels, second pass emits code
 */

class Assembler {
  constructor() {
    this.labels = {};
    this.instructions = [];
    this.dataSegment = []; // for .data directives
    this.errors = [];
  }

  // Parse register name to number
  static parseReg(s) {
    s = s.trim().toLowerCase();
    if (s in REG_NUMBERS) return REG_NUMBERS[s];
    throw new Error(`Unknown register: ${s}`);
  }

  // Parse immediate (decimal, hex, or label reference)
  parseImm(s, pc, labels) {
    s = s.trim();
    // Label reference
    if (labels && s in labels) {
      return labels[s];
    }
    // %hi(label) and %lo(label)
    const hiMatch = s.match(/^%hi\((\w+)\)$/);
    if (hiMatch) {
      const addr = labels ? labels[hiMatch[1]] : 0;
      if (addr === undefined) throw new Error(`Unknown label: ${hiMatch[1]}`);
      // Upper 20 bits, adjusted for sign extension of lo12
      const lo = addr & 0xFFF;
      const hi = (addr - ((lo << 20) >> 20)) & 0xFFFFF000;
      return hi;
    }
    const loMatch = s.match(/^%lo\((\w+)\)$/);
    if (loMatch) {
      const addr = labels ? labels[loMatch[1]] : 0;
      if (addr === undefined) throw new Error(`Unknown label: ${loMatch[1]}`);
      return addr & 0xFFF;
    }
    // Hex
    if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
    // Binary
    if (s.startsWith('0b') || s.startsWith('0B')) return parseInt(s.slice(2), 2);
    // Decimal
    return parseInt(s, 10);
  }

  // Encode R-type
  static encR(opcode, rd, funct3, rs1, rs2, funct7) {
    return ((funct7 & 0x7F) << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
           ((funct3 & 0x7) << 12) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
  }

  // Encode I-type
  static encI(opcode, rd, funct3, rs1, imm) {
    return ((imm & 0xFFF) << 20) | ((rs1 & 0x1F) << 15) |
           ((funct3 & 0x7) << 12) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
  }

  // Encode S-type
  static encS(opcode, funct3, rs1, rs2, imm) {
    const hi = (imm >> 5) & 0x7F;
    const lo = imm & 0x1F;
    return ((hi & 0x7F) << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
           ((funct3 & 0x7) << 12) | ((lo & 0x1F) << 7) | (opcode & 0x7F);
  }

  // Encode B-type
  static encB(opcode, funct3, rs1, rs2, imm) {
    const b12 = (imm >> 12) & 1;
    const b11 = (imm >> 11) & 1;
    const b10_5 = (imm >> 5) & 0x3F;
    const b4_1 = (imm >> 1) & 0xF;
    return (b12 << 31) | (b10_5 << 25) | ((rs2 & 0x1F) << 20) | ((rs1 & 0x1F) << 15) |
           ((funct3 & 0x7) << 12) | (b4_1 << 8) | (b11 << 7) | (opcode & 0x7F);
  }

  // Encode U-type
  static encU(opcode, rd, imm) {
    return (imm & 0xFFFFF000) | ((rd & 0x1F) << 7) | (opcode & 0x7F);
  }

  // Encode J-type
  static encJ(opcode, rd, imm) {
    const b20 = (imm >> 20) & 1;
    const b19_12 = (imm >> 12) & 0xFF;
    const b11 = (imm >> 11) & 1;
    const b10_1 = (imm >> 1) & 0x3FF;
    return (b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) |
           ((rd & 0x1F) << 7) | (opcode & 0x7F);
  }

  // Parse offset(register) pattern like "16(sp)" → { offset: 16, reg: 2 }
  static parseMemOp(s) {
    const m = s.trim().match(/^(-?\w+)\((\w+)\)$/);
    if (!m) throw new Error(`Invalid memory operand: ${s}`);
    return { offsetStr: m[1], regStr: m[2] };
  }

  // Expand pseudo-instructions into real instructions
  expandPseudo(mnemonic, args, pc, labels) {
    switch (mnemonic) {
      case 'nop':
        return [Assembler.encI(0b0010011, 0, 0, 0, 0)]; // addi x0, x0, 0

      case 'li': {
        const rd = Assembler.parseReg(args[0]);
        const imm = this.parseImm(args[1], pc, labels);
        if (imm >= -2048 && imm <= 2047) {
          return [Assembler.encI(0b0010011, rd, 0, 0, imm & 0xFFF)]; // addi rd, x0, imm
        }
        // LUI + ADDI
        const lo = imm & 0xFFF;
        let hi = imm & 0xFFFFF000;
        // If lo is negative (sign-extended), adjust hi
        if (lo & 0x800) hi = (hi + 0x1000) & 0xFFFFFFFF;
        const words = [Assembler.encU(0b0110111, rd, hi)];
        if ((lo & 0xFFF) !== 0) {
          words.push(Assembler.encI(0b0010011, rd, 0, rd, lo & 0xFFF));
        }
        return words;
      }

      case 'la': {
        // Load address — same as li but for labels
        const rd = Assembler.parseReg(args[0]);
        const addr = labels ? labels[args[1].trim()] : 0;
        if (addr === undefined) throw new Error(`Unknown label: ${args[1]}`);
        if (addr >= -2048 && addr <= 2047) {
          return [Assembler.encI(0b0010011, rd, 0, 0, addr & 0xFFF)];
        }
        const lo = addr & 0xFFF;
        let hi = addr & 0xFFFFF000;
        if (lo & 0x800) hi = (hi + 0x1000) & 0xFFFFFFFF;
        const words = [Assembler.encU(0b0110111, rd, hi)];
        if ((lo & 0xFFF) !== 0) {
          words.push(Assembler.encI(0b0010011, rd, 0, rd, lo & 0xFFF));
        }
        return words;
      }

      case 'mv':
        return [Assembler.encI(0b0010011, Assembler.parseReg(args[0]), 0, Assembler.parseReg(args[1]), 0)];

      case 'not':
        return [Assembler.encI(0b0010011, Assembler.parseReg(args[0]), 0b100, Assembler.parseReg(args[1]), -1 & 0xFFF)];

      case 'neg':
        return [Assembler.encR(0b0110011, Assembler.parseReg(args[0]), 0, 0, Assembler.parseReg(args[1]), 0b0100000)];

      case 'seqz':
        return [Assembler.encI(0b0010011, Assembler.parseReg(args[0]), 0b011, Assembler.parseReg(args[1]), 1)];

      case 'snez':
        return [Assembler.encR(0b0110011, Assembler.parseReg(args[0]), 0b011, 0, Assembler.parseReg(args[1]), 0)];

      case 'j': {
        const offset = this._resolveLabel(args[0].trim(), pc, labels);
        return [Assembler.encJ(0b1101111, 0, offset)];
      }

      case 'jr':
        return [Assembler.encI(0b1100111, 0, 0, Assembler.parseReg(args[0]), 0)];

      case 'ret':
        return [Assembler.encI(0b1100111, 0, 0, 1, 0)]; // jalr x0, ra, 0

      case 'call': {
        // AUIPC ra, %hi(offset); JALR ra, ra, %lo(offset)
        const offset = this._resolveLabel(args[0].trim(), pc, labels);
        const lo = offset & 0xFFF;
        let hi = offset & 0xFFFFF000;
        if (lo & 0x800) hi = (hi + 0x1000) & 0xFFFFFFFF;
        return [
          Assembler.encU(0b0010111, 1, hi),  // auipc ra, hi
          Assembler.encI(0b1100111, 1, 0, 1, lo & 0xFFF)  // jalr ra, ra, lo
        ];
      }

      case 'beqz': {
        const offset = this._resolveLabel(args[1].trim(), pc, labels);
        return [Assembler.encB(0b1100011, 0b000, Assembler.parseReg(args[0]), 0, offset)];
      }

      case 'bnez': {
        const offset = this._resolveLabel(args[1].trim(), pc, labels);
        return [Assembler.encB(0b1100011, 0b001, Assembler.parseReg(args[0]), 0, offset)];
      }

      case 'bgt': {
        const offset = this._resolveLabel(args[2].trim(), pc, labels);
        return [Assembler.encB(0b1100011, 0b100, Assembler.parseReg(args[1]), Assembler.parseReg(args[0]), offset)];
      }

      case 'ble': {
        const offset = this._resolveLabel(args[2].trim(), pc, labels);
        return [Assembler.encB(0b1100011, 0b101, Assembler.parseReg(args[1]), Assembler.parseReg(args[0]), offset)];
      }

      default:
        return null; // not a pseudo-instruction
    }
  }

  _resolveLabel(name, pc, labels) {
    if (!labels) return 0;
    if (name in labels) return labels[name] - pc;
    // Try as immediate
    return this.parseImm(name, pc, labels);
  }

  // Assemble a single instruction (not pseudo)
  assembleInst(mnemonic, args, pc, labels) {
    const R = Assembler.parseReg.bind(Assembler);
    const I = (s) => this.parseImm(s.trim(), pc, labels);

    switch (mnemonic) {
      // R-type
      case 'add':   return Assembler.encR(0b0110011, R(args[0]), 0b000, R(args[1]), R(args[2]), 0);
      case 'sub':   return Assembler.encR(0b0110011, R(args[0]), 0b000, R(args[1]), R(args[2]), 0b0100000);
      case 'sll':   return Assembler.encR(0b0110011, R(args[0]), 0b001, R(args[1]), R(args[2]), 0);
      case 'slt':   return Assembler.encR(0b0110011, R(args[0]), 0b010, R(args[1]), R(args[2]), 0);
      case 'sltu':  return Assembler.encR(0b0110011, R(args[0]), 0b011, R(args[1]), R(args[2]), 0);
      case 'xor':   return Assembler.encR(0b0110011, R(args[0]), 0b100, R(args[1]), R(args[2]), 0);
      case 'srl':   return Assembler.encR(0b0110011, R(args[0]), 0b101, R(args[1]), R(args[2]), 0);
      case 'sra':   return Assembler.encR(0b0110011, R(args[0]), 0b101, R(args[1]), R(args[2]), 0b0100000);
      case 'or':    return Assembler.encR(0b0110011, R(args[0]), 0b110, R(args[1]), R(args[2]), 0);
      case 'and':   return Assembler.encR(0b0110011, R(args[0]), 0b111, R(args[1]), R(args[2]), 0);

      // M extension
      case 'mul':    return Assembler.encR(0b0110011, R(args[0]), 0b000, R(args[1]), R(args[2]), 0b0000001);
      case 'mulh':   return Assembler.encR(0b0110011, R(args[0]), 0b001, R(args[1]), R(args[2]), 0b0000001);
      case 'mulhsu': return Assembler.encR(0b0110011, R(args[0]), 0b010, R(args[1]), R(args[2]), 0b0000001);
      case 'mulhu':  return Assembler.encR(0b0110011, R(args[0]), 0b011, R(args[1]), R(args[2]), 0b0000001);
      case 'div':    return Assembler.encR(0b0110011, R(args[0]), 0b100, R(args[1]), R(args[2]), 0b0000001);
      case 'divu':   return Assembler.encR(0b0110011, R(args[0]), 0b101, R(args[1]), R(args[2]), 0b0000001);
      case 'rem':    return Assembler.encR(0b0110011, R(args[0]), 0b110, R(args[1]), R(args[2]), 0b0000001);
      case 'remu':   return Assembler.encR(0b0110011, R(args[0]), 0b111, R(args[1]), R(args[2]), 0b0000001);

      // I-type ALU
      case 'addi':  return Assembler.encI(0b0010011, R(args[0]), 0b000, R(args[1]), I(args[2]) & 0xFFF);
      case 'slti':  return Assembler.encI(0b0010011, R(args[0]), 0b010, R(args[1]), I(args[2]) & 0xFFF);
      case 'sltiu': return Assembler.encI(0b0010011, R(args[0]), 0b011, R(args[1]), I(args[2]) & 0xFFF);
      case 'xori':  return Assembler.encI(0b0010011, R(args[0]), 0b100, R(args[1]), I(args[2]) & 0xFFF);
      case 'ori':   return Assembler.encI(0b0010011, R(args[0]), 0b110, R(args[1]), I(args[2]) & 0xFFF);
      case 'andi':  return Assembler.encI(0b0010011, R(args[0]), 0b111, R(args[1]), I(args[2]) & 0xFFF);
      case 'slli':  return Assembler.encI(0b0010011, R(args[0]), 0b001, R(args[1]), I(args[2]) & 0x1F);
      case 'srli':  return Assembler.encI(0b0010011, R(args[0]), 0b101, R(args[1]), I(args[2]) & 0x1F);
      case 'srai':  return Assembler.encI(0b0010011, R(args[0]), 0b101, R(args[1]), (0b0100000 << 5) | (I(args[2]) & 0x1F));

      // Loads
      case 'lb':  { const m = Assembler.parseMemOp(args[1]); return Assembler.encI(0b0000011, R(args[0]), 0b000, R(m.regStr), I(m.offsetStr) & 0xFFF); }
      case 'lh':  { const m = Assembler.parseMemOp(args[1]); return Assembler.encI(0b0000011, R(args[0]), 0b001, R(m.regStr), I(m.offsetStr) & 0xFFF); }
      case 'lw':  { const m = Assembler.parseMemOp(args[1]); return Assembler.encI(0b0000011, R(args[0]), 0b010, R(m.regStr), I(m.offsetStr) & 0xFFF); }
      case 'lbu': { const m = Assembler.parseMemOp(args[1]); return Assembler.encI(0b0000011, R(args[0]), 0b100, R(m.regStr), I(m.offsetStr) & 0xFFF); }
      case 'lhu': { const m = Assembler.parseMemOp(args[1]); return Assembler.encI(0b0000011, R(args[0]), 0b101, R(m.regStr), I(m.offsetStr) & 0xFFF); }

      // Stores
      case 'sb': { const m = Assembler.parseMemOp(args[1]); return Assembler.encS(0b0100011, 0b000, R(m.regStr), R(args[0]), I(m.offsetStr)); }
      case 'sh': { const m = Assembler.parseMemOp(args[1]); return Assembler.encS(0b0100011, 0b001, R(m.regStr), R(args[0]), I(m.offsetStr)); }
      case 'sw': { const m = Assembler.parseMemOp(args[1]); return Assembler.encS(0b0100011, 0b010, R(m.regStr), R(args[0]), I(m.offsetStr)); }

      // Branches
      case 'beq':  return Assembler.encB(0b1100011, 0b000, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));
      case 'bne':  return Assembler.encB(0b1100011, 0b001, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));
      case 'blt':  return Assembler.encB(0b1100011, 0b100, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));
      case 'bge':  return Assembler.encB(0b1100011, 0b101, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));
      case 'bltu': return Assembler.encB(0b1100011, 0b110, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));
      case 'bgeu': return Assembler.encB(0b1100011, 0b111, R(args[0]), R(args[1]), this._resolveLabel(args[2].trim(), pc, labels));

      // U-type
      case 'lui':   return Assembler.encU(0b0110111, R(args[0]), I(args[1]));
      case 'auipc': return Assembler.encU(0b0010111, R(args[0]), I(args[1]));

      // J-type
      case 'jal':  {
        if (args.length === 1) {
          // jal label → jal ra, label
          return Assembler.encJ(0b1101111, 1, this._resolveLabel(args[0].trim(), pc, labels));
        }
        return Assembler.encJ(0b1101111, R(args[0]), this._resolveLabel(args[1].trim(), pc, labels));
      }

      // JALR
      case 'jalr': {
        if (args.length === 1) {
          return Assembler.encI(0b1100111, 1, 0, R(args[0]), 0); // jalr ra, rs, 0
        }
        if (args.length === 2) {
          // jalr rd, rs  OR  jalr rd, offset(rs)
          try {
            const m = Assembler.parseMemOp(args[1]);
            return Assembler.encI(0b1100111, R(args[0]), 0, R(m.regStr), I(m.offsetStr) & 0xFFF);
          } catch {
            return Assembler.encI(0b1100111, R(args[0]), 0, R(args[1]), 0);
          }
        }
        return Assembler.encI(0b1100111, R(args[0]), 0, R(args[1]), I(args[2]) & 0xFFF);
      }

      // System
      case 'ecall':  return 0x00000073;
      case 'ebreak': return 0x00100073;
      case 'fence':  return 0x0000000F;

      default:
        throw new Error(`Unknown instruction: ${mnemonic}`);
    }
  }

  // Parse line into { label?, mnemonic?, args[] }
  static parseLine(line) {
    // Remove comments
    let s = line.replace(/#.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!s) return null;

    // Check for label
    let label = null;
    const labelMatch = s.match(/^(\w+):\s*(.*)/);
    if (labelMatch) {
      label = labelMatch[1];
      s = labelMatch[2].trim();
    }

    if (!s) return { label, mnemonic: null, args: [] };

    // Directives
    if (s.startsWith('.')) {
      return { label, directive: s };
    }

    // Split mnemonic and args
    const parts = s.split(/\s+/);
    const mnemonic = parts[0].toLowerCase();
    const rest = s.slice(parts[0].length).trim();
    
    // Parse args — split on commas but be careful with offset(reg) syntax
    const args = rest ? rest.split(',').map(a => a.trim()).filter(a => a) : [];

    return { label, mnemonic, args };
  }

  /**
   * Assemble text into machine code words
   * Returns { words: number[], labels: {}, errors: [] }
   */
  assemble(text, baseAddr = 0) {
    const lines = text.split('\n');
    const labels = {};
    const parsed = [];
    this.errors = [];

    // Pass 1: collect labels and calculate sizes
    let pc = baseAddr;
    for (let i = 0; i < lines.length; i++) {
      const p = Assembler.parseLine(lines[i]);
      if (!p) continue;

      if (p.label) {
        labels[p.label] = pc;
      }

      if (p.directive) {
        // Handle .word, .byte, .string, .ascii, .asciz, .space
        const dir = p.directive.split(/\s+/);
        switch (dir[0]) {
          case '.word': pc += 4 * (dir.length - 1); break;
          case '.half': pc += 2 * (dir.length - 1); break;
          case '.byte': pc += dir.length - 1; break;
          case '.string':
          case '.asciz': {
            const str = p.directive.match(/"([^"]*)"/);
            if (str) pc += str[1].length + 1; // +1 for null terminator
            break;
          }
          case '.ascii': {
            const str = p.directive.match(/"([^"]*)"/);
            if (str) pc += str[1].length;
            break;
          }
          case '.space': pc += parseInt(dir[1]) || 0; break;
          case '.text': case '.data': case '.globl': case '.global': case '.align':
            break; // ignore these
          default:
            // ignore unknown directives
        }
        parsed.push({ ...p, pc: pc - (pc - (p.label ? labels[p.label] : pc)), line: i + 1 });
        continue;
      }

      if (!p.mnemonic) {
        parsed.push({ ...p, pc, line: i + 1 });
        continue;
      }

      // Estimate size (pseudo-instructions may expand)
      const pseudoSize = this._estimatePseudoSize(p.mnemonic, p.args);
      parsed.push({ ...p, pc, line: i + 1 });
      pc += pseudoSize * 4;
    }

    // Pass 2: emit code
    const words = [];
    for (const p of parsed) {
      if (!p.mnemonic) {
        if (p.directive) {
          // Emit directive data
          this._emitDirective(p.directive, words, labels, p.pc);
        }
        continue;
      }

      const instrPC = baseAddr + words.length * 4;

      try {
        // Try pseudo-instruction first
        const pseudo = this.expandPseudo(p.mnemonic, p.args, instrPC, labels);
        if (pseudo) {
          words.push(...pseudo);
        } else {
          words.push(this.assembleInst(p.mnemonic, p.args, instrPC, labels));
        }
      } catch (e) {
        this.errors.push({ line: p.line, message: e.message });
      }
    }

    return { words, labels, errors: this.errors };
  }

  _estimatePseudoSize(mnemonic, args) {
    switch (mnemonic) {
      case 'li': {
        // Check if small immediate
        const s = args[1]?.trim();
        if (!s) return 1;
        try {
          const v = parseInt(s);
          if (v >= -2048 && v <= 2047) return 1;
          // LUI + optional ADDI (ADDI only if low 12 bits non-zero)
          return (v & 0xFFF) === 0 ? 1 : 2;
        } catch { return 2; }
      }
      case 'la': return 2;
      case 'call': return 2;
      default: return 1;
    }
  }

  _emitDirective(directive, words, labels, pc) {
    const dir = directive.split(/\s+/);
    switch (dir[0]) {
      case '.word':
        for (let i = 1; i < dir.length; i++) {
          words.push(parseInt(dir[i]) | 0);
        }
        break;
      // Other directives handled via raw memory in the CPU
    }
  }
}

module.exports = { Assembler };
