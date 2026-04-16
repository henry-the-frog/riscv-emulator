import { Memory } from './memory.js';
import { Registers, REG_NAMES } from './registers.js';

/**
 * RISC-V RV32I CPU
 * 
 * Instruction formats:
 *   R-type: [funct7(7)][rs2(5)][rs1(5)][funct3(3)][rd(5)][opcode(7)]
 *   I-type: [imm(12)][rs1(5)][funct3(3)][rd(5)][opcode(7)]
 *   S-type: [imm(7)][rs2(5)][rs1(5)][funct3(3)][imm(5)][opcode(7)]
 *   B-type: [imm(1|6)][rs2(5)][rs1(5)][funct3(3)][imm(4|1)][opcode(7)]
 *   U-type: [imm(20)][rd(5)][opcode(7)]
 *   J-type: [imm(1|10|1|8)][rd(5)][opcode(7)]
 */

// Opcodes
const OP_LUI    = 0b0110111;
const OP_AUIPC  = 0b0010111;
const OP_JAL    = 0b1101111;
const OP_JALR   = 0b1100111;
const OP_BRANCH = 0b1100011;
const OP_LOAD   = 0b0000011;
const OP_STORE  = 0b0100011;
const OP_IMM    = 0b0010011;
const OP_REG    = 0b0110011;
const OP_FENCE  = 0b0001111;
const OP_SYSTEM = 0b1110011;

class CPU {
  constructor(memorySize = 1024 * 1024) {
    this.mem = new Memory(memorySize);
    this.regs = new Registers();
    this.halted = false;
    this.exitCode = 0;
    this.cycles = 0;
    this.output = []; // captured output from ecall
    this.tracing = false;
    this.traceLog = [];
  }

  reset() {
    this.regs.reset();
    this.halted = false;
    this.exitCode = 0;
    this.cycles = 0;
    this.output = [];
    this.traceLog = [];
  }

  // Load a program (array of 32-bit words) at address
  loadProgram(words, addr = 0) {
    for (let i = 0; i < words.length; i++) {
      this.mem.storeWord(addr + i * 4, words[i]);
    }
    this.regs.pc = addr;
  }

  // Load raw bytes
  loadBytes(bytes, addr = 0) {
    this.mem.storeBytes(addr, bytes);
    this.regs.pc = addr;
  }

  // Sign-extend a value from bit width to 32 bits
  static signExtend(val, bits) {
    const shift = 32 - bits;
    return (val << shift) >> shift;
  }

  // Decode instruction fields
  static decode(inst) {
    const opcode = inst & 0x7F;
    const rd     = (inst >> 7) & 0x1F;
    const funct3 = (inst >> 12) & 0x7;
    const rs1    = (inst >> 15) & 0x1F;
    const rs2    = (inst >> 20) & 0x1F;
    const funct7 = (inst >> 25) & 0x7F;

    // Immediate extraction by format
    let immI = CPU.signExtend((inst >> 20) & 0xFFF, 12);
    
    let immS = CPU.signExtend(
      (((inst >> 25) & 0x7F) << 5) | ((inst >> 7) & 0x1F), 12
    );

    let immB = CPU.signExtend(
      (((inst >> 31) & 1) << 12) |
      (((inst >> 7) & 1) << 11) |
      (((inst >> 25) & 0x3F) << 5) |
      (((inst >> 8) & 0xF) << 1),
      13
    );

    let immU = inst & 0xFFFFF000; // already shifted

    let immJ = CPU.signExtend(
      (((inst >> 31) & 1) << 20) |
      (((inst >> 12) & 0xFF) << 12) |
      (((inst >> 20) & 1) << 11) |
      (((inst >> 21) & 0x3FF) << 1),
      21
    );

    return { opcode, rd, funct3, rs1, rs2, funct7, immI, immS, immB, immU, immJ };
  }

  // Execute one instruction
  step() {
    if (this.halted) return false;

    const pc = this.regs.pc;
    const inst = this.mem.loadWord(pc) | 0;
    const d = CPU.decode(inst);

    if (this.tracing) {
      this.traceLog.push({
        pc, inst: inst >>> 0, decoded: d,
        regs: Array.from(this.regs.x)
      });
    }

    let nextPC = pc + 4;

    switch (d.opcode) {
      // --- LUI ---
      case OP_LUI:
        this.regs.set(d.rd, d.immU);
        break;

      // --- AUIPC ---
      case OP_AUIPC:
        this.regs.set(d.rd, (pc + d.immU) | 0);
        break;

      // --- JAL ---
      case OP_JAL:
        this.regs.set(d.rd, pc + 4);
        nextPC = (pc + d.immJ) | 0;
        break;

      // --- JALR ---
      case OP_JALR:
        this.regs.set(d.rd, pc + 4);
        nextPC = ((this.regs.get(d.rs1) + d.immI) & ~1) | 0;
        break;

      // --- Branch ---
      case OP_BRANCH:
        if (this._evalBranch(d.funct3, d.rs1, d.rs2)) {
          nextPC = (pc + d.immB) | 0;
        }
        break;

      // --- Load ---
      case OP_LOAD:
        this._execLoad(d);
        break;

      // --- Store ---
      case OP_STORE:
        this._execStore(d);
        break;

      // --- ALU Immediate ---
      case OP_IMM:
        this._execALUImm(d);
        break;

      // --- ALU Register ---
      case OP_REG:
        this._execALUReg(d);
        break;

      // --- FENCE (no-op for single-core) ---
      case OP_FENCE:
        break;

      // --- SYSTEM ---
      case OP_SYSTEM:
        this._execSystem(d, inst);
        break;

      default:
        throw new Error(`Unknown opcode: 0b${d.opcode.toString(2).padStart(7,'0')} at PC=0x${pc.toString(16)}`);
    }

    this.regs.pc = nextPC;
    this.cycles++;
    return true;
  }

  _evalBranch(funct3, rs1, rs2) {
    const a = this.regs.get(rs1);
    const b = this.regs.get(rs2);
    switch (funct3) {
      case 0b000: return a === b;                           // BEQ
      case 0b001: return a !== b;                           // BNE
      case 0b100: return a < b;                             // BLT
      case 0b101: return a >= b;                            // BGE
      case 0b110: return (a >>> 0) < (b >>> 0);             // BLTU
      case 0b111: return (a >>> 0) >= (b >>> 0);            // BGEU
      default: throw new Error(`Unknown branch funct3: ${funct3}`);
    }
  }

  _execLoad(d) {
    const addr = (this.regs.get(d.rs1) + d.immI) | 0;
    let val;
    switch (d.funct3) {
      case 0b000: val = this.mem.loadByteSigned(addr); break;   // LB
      case 0b001: val = this.mem.loadHalfSigned(addr); break;   // LH
      case 0b010: val = this.mem.loadWordSigned(addr); break;   // LW
      case 0b100: val = this.mem.loadByte(addr); break;         // LBU
      case 0b101: val = this.mem.loadHalf(addr); break;         // LHU
      default: throw new Error(`Unknown load funct3: ${d.funct3}`);
    }
    this.regs.set(d.rd, val);
  }

  _execStore(d) {
    const addr = (this.regs.get(d.rs1) + d.immS) | 0;
    const val = this.regs.get(d.rs2);
    switch (d.funct3) {
      case 0b000: this.mem.storeByte(addr, val); break;  // SB
      case 0b001: this.mem.storeHalf(addr, val); break;  // SH
      case 0b010: this.mem.storeWord(addr, val); break;  // SW
      default: throw new Error(`Unknown store funct3: ${d.funct3}`);
    }
  }

  _execALUImm(d) {
    const src = this.regs.get(d.rs1);
    const imm = d.immI;
    let result;
    switch (d.funct3) {
      case 0b000: result = (src + imm) | 0; break;              // ADDI
      case 0b010: result = (src < imm) ? 1 : 0; break;         // SLTI
      case 0b011: result = ((src >>> 0) < (imm >>> 0)) ? 1 : 0; break; // SLTIU
      case 0b100: result = (src ^ imm) | 0; break;              // XORI
      case 0b110: result = (src | imm) | 0; break;              // ORI
      case 0b111: result = (src & imm) | 0; break;              // ANDI
      case 0b001: { // SLLI
        const shamt = d.rs2; // bits [24:20]
        result = (src << shamt) | 0;
        break;
      }
      case 0b101: { // SRLI / SRAI
        const shamt = d.rs2;
        if (d.funct7 === 0b0100000) {
          result = (src >> shamt) | 0; // SRAI (arithmetic)
        } else {
          result = (src >>> shamt) | 0; // SRLI (logical)
        }
        break;
      }
    }
    this.regs.set(d.rd, result);
  }

  _execALUReg(d) {
    const a = this.regs.get(d.rs1);
    const b = this.regs.get(d.rs2);
    let result;

    // M extension: funct7 === 0b0000001
    if (d.funct7 === 0b0000001) {
      result = this._execMulDiv(d.funct3, a, b);
      this.regs.set(d.rd, result);
      return;
    }

    switch (d.funct3) {
      case 0b000: // ADD / SUB
        result = d.funct7 === 0b0100000 ? (a - b) | 0 : (a + b) | 0;
        break;
      case 0b001: result = (a << (b & 0x1F)) | 0; break;            // SLL
      case 0b010: result = (a < b) ? 1 : 0; break;                  // SLT
      case 0b011: result = ((a >>> 0) < (b >>> 0)) ? 1 : 0; break;  // SLTU
      case 0b100: result = (a ^ b) | 0; break;                       // XOR
      case 0b101: // SRL / SRA
        if (d.funct7 === 0b0100000) {
          result = (a >> (b & 0x1F)) | 0;  // SRA
        } else {
          result = (a >>> (b & 0x1F)) | 0; // SRL
        }
        break;
      case 0b110: result = (a | b) | 0; break;                       // OR
      case 0b111: result = (a & b) | 0; break;                       // AND
      default: throw new Error(`Unknown ALU funct3: ${d.funct3}`);
    }
    this.regs.set(d.rd, result);
  }

  _execMulDiv(funct3, a, b) {
    // Use BigInt for 64-bit precision in multiply
    switch (funct3) {
      case 0b000: { // MUL — lower 32 bits of signed×signed
        return Math.imul(a, b);
      }
      case 0b001: { // MULH — upper 32 bits of signed×signed
        const product = BigInt(a) * BigInt(b);
        return Number((product >> 32n) & 0xFFFFFFFFn) | 0;
      }
      case 0b010: { // MULHSU — upper 32 bits of signed×unsigned
        const product = BigInt(a) * BigInt(b >>> 0);
        return Number((product >> 32n) & 0xFFFFFFFFn) | 0;
      }
      case 0b011: { // MULHU — upper 32 bits of unsigned×unsigned
        const product = BigInt(a >>> 0) * BigInt(b >>> 0);
        return Number((product >> 32n) & 0xFFFFFFFFn) | 0;
      }
      case 0b100: { // DIV — signed division
        if (b === 0) return -1; // division by zero → -1
        if (a === (-2147483648 | 0) && b === -1) return a; // overflow
        return (a / b) | 0;
      }
      case 0b101: { // DIVU — unsigned division
        if (b === 0) return 0xFFFFFFFF | 0;
        return ((a >>> 0) / (b >>> 0)) | 0;
      }
      case 0b110: { // REM — signed remainder
        if (b === 0) return a;
        if (a === (-2147483648 | 0) && b === -1) return 0;
        return (a % b) | 0;
      }
      case 0b111: { // REMU — unsigned remainder
        if (b === 0) return a;
        return ((a >>> 0) % (b >>> 0)) | 0;
      }
    }
  }

  _execSystem(d, inst) {
    if (inst === 0x00000073) {
      // ECALL — use Linux-like syscall convention
      // a7 = syscall number, a0-a6 = args
      this._handleEcall();
    } else if (inst === 0x00100073) {
      // EBREAK — halt
      this.halted = true;
    } else {
      // CSR instructions — ignore for now
    }
  }

  _handleEcall() {
    const syscall = this.regs.get(17); // a7
    const a0 = this.regs.get(10);      // a0
    const a1 = this.regs.get(11);      // a1
    const a2 = this.regs.get(12);      // a2

    switch (syscall) {
      case 1: // print_int
        this.output.push(String(a0));
        break;
      case 4: // print_string
        this.output.push(this.mem.loadString(a0 >>> 0));
        break;
      case 10: // exit
        this.halted = true;
        this.exitCode = 0;
        break;
      case 11: // print_char
        this.output.push(String.fromCharCode(a0 & 0xFF));
        break;
      case 64: // write (Linux-like: fd=a0, buf=a1, len=a2)
        if (a0 === 1) { // stdout
          let s = '';
          for (let i = 0; i < a2; i++) {
            s += String.fromCharCode(this.mem.loadByte((a1 + i) >>> 0));
          }
          this.output.push(s);
          this.regs.set(10, a2); // return bytes written
        }
        break;
      case 93: // exit (Linux)
        this.halted = true;
        this.exitCode = a0;
        break;
      default:
        // Unknown syscall — ignore
        break;
    }
  }

  // Run until halted or max cycles
  run(maxCycles = 1000000) {
    while (!this.halted && this.cycles < maxCycles) {
      this.step();
    }
    return {
      halted: this.halted,
      exitCode: this.exitCode,
      cycles: this.cycles,
      output: this.output.join('')
    };
  }
}

export { CPU, OP_LUI, OP_AUIPC, OP_JAL, OP_JALR, OP_BRANCH, OP_LOAD, OP_STORE, OP_IMM, OP_REG, OP_FENCE, OP_SYSTEM };
