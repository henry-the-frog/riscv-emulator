'use strict';

const { CPU } = require('./cpu');
const { Disassembler } = require('./disassembler');

/**
 * Out-of-Order Execution Simulator — Tomasulo's Algorithm
 * 
 * Models a superscalar out-of-order processor:
 * - Register Alias Table (RAT) — register renaming
 * - Reservation Stations (RS) — hold instructions until operands ready
 * - Reorder Buffer (ROB) — ensure in-order commit
 * - Common Data Bus (CDB) — broadcast results
 * - Functional Units — ALU, Load/Store, Branch
 *
 * Pipeline: Fetch → Decode/Rename → Issue → Execute → Complete → Commit
 */

// Functional unit types
const FU_ALU = 'ALU';
const FU_MUL = 'MUL';
const FU_LOAD = 'LOAD';
const FU_STORE = 'STORE';
const FU_BRANCH = 'BRANCH';

// Execution latencies
const LATENCY = {
  [FU_ALU]: 1,
  [FU_MUL]: 3,
  [FU_LOAD]: 2,
  [FU_STORE]: 1,
  [FU_BRANCH]: 1,
};

// Classify instruction to functional unit
function classifyToFU(opcode, funct7) {
  switch (opcode) {
    case 0b0110011: // R-type
      return funct7 === 0b0000001 ? FU_MUL : FU_ALU;
    case 0b0010011: // I-type ALU
    case 0b0110111: // LUI
    case 0b0010111: // AUIPC
      return FU_ALU;
    case 0b0000011: // Load
      return FU_LOAD;
    case 0b0100011: // Store
      return FU_STORE;
    case 0b1100011: // Branch
    case 0b1101111: // JAL
    case 0b1100111: // JALR
      return FU_BRANCH;
    default:
      return FU_ALU;
  }
}

class ReservationStation {
  constructor(id, fuType) {
    this.id = id;
    this.fuType = fuType;
    this.busy = false;
    this.op = 0;       // Instruction word
    this.opcode = 0;
    this.funct3 = 0;
    this.funct7 = 0;
    this.vj = 0;       // Source operand 1 value
    this.vk = 0;       // Source operand 2 value
    this.qj = null;    // ROB entry producing vj (null = ready)
    this.qk = null;    // ROB entry producing vk
    this.dest = null;   // ROB entry for result
    this.addr = 0;      // For loads/stores: computed address
    this.imm = 0;       // Immediate value
    this.pc = 0;
    this.asm = '';
    this.cycleIssued = 0;
    this.cycleExecuteStart = 0;
    this.cycleCompleted = 0;
  }

  clear() {
    this.busy = false;
    this.qj = null;
    this.qk = null;
    this.dest = null;
    this.cycleExecuteStart = 0;
    this.cycleCompleted = 0;
  }

  isReady() {
    return this.busy && this.qj === null && this.qk === null;
  }
}

class ROBEntry {
  constructor(id) {
    this.id = id;
    this.busy = false;
    this.ready = false;   // Result computed
    this.type = '';       // 'REG' | 'STORE' | 'BRANCH'
    this.dest = 0;        // Register number (for REG type)
    this.value = 0;       // Computed value
    this.pc = 0;
    this.asm = '';
    this.mispredicted = false;
  }

  clear() {
    this.busy = false;
    this.ready = false;
    this.mispredicted = false;
  }
}

class TomasuloCPU {
  constructor(memorySize = 1024 * 1024) {
    this.cpu = new CPU(memorySize);
    
    // Configuration
    this.numALU = 3;
    this.numMUL = 2;
    this.numLoad = 2;
    this.numStore = 2;
    this.numBranch = 1;
    this.robSize = 16;

    // Reservation stations
    this.stations = [];
    for (let i = 0; i < this.numALU; i++) this.stations.push(new ReservationStation(`ALU${i}`, FU_ALU));
    for (let i = 0; i < this.numMUL; i++) this.stations.push(new ReservationStation(`MUL${i}`, FU_MUL));
    for (let i = 0; i < this.numLoad; i++) this.stations.push(new ReservationStation(`LD${i}`, FU_LOAD));
    for (let i = 0; i < this.numStore; i++) this.stations.push(new ReservationStation(`ST${i}`, FU_STORE));
    for (let i = 0; i < this.numBranch; i++) this.stations.push(new ReservationStation(`BR${i}`, FU_BRANCH));

    // Reorder Buffer (circular)
    this.rob = Array.from({ length: this.robSize }, (_, i) => new ROBEntry(i));
    this.robHead = 0;
    this.robTail = 0;
    this.robCount = 0;

    // Register Alias Table — maps architectural reg to ROB entry
    this.rat = new Array(32).fill(null);

    // Stats
    this.cycle = 0;
    this.committed = 0;
    this.halted = false;
    
    // Instruction log
    this.instrLog = []; // { pc, asm, issued, execStart, completed, committed }
  }

  get mem() { return this.cpu.mem; }
  get regs() { return this.cpu.regs; }

  reset() {
    this.cpu.reset();
    this.stations.forEach(s => s.clear());
    this.rob.forEach(r => r.clear());
    this.robHead = 0;
    this.robTail = 0;
    this.robCount = 0;
    this.rat.fill(null);
    this.cycle = 0;
    this.committed = 0;
    this.halted = false;
    this.instrLog = [];
  }

  loadProgram(words, addr = 0) {
    this.cpu.loadProgram(words, addr);
  }

  // Find a free reservation station for the given FU type
  _findFreeRS(fuType) {
    return this.stations.find(s => !s.busy && s.fuType === fuType) || null;
  }

  // Allocate ROB entry
  _allocROB() {
    if (this.robCount >= this.robSize) return null;
    const entry = this.rob[this.robTail];
    entry.busy = true;
    entry.ready = false;
    entry.mispredicted = false;
    this.robTail = (this.robTail + 1) % this.robSize;
    this.robCount++;
    return entry;
  }

  // Read register value, possibly from ROB
  _readReg(reg) {
    if (reg === 0) return { value: 0, source: null };
    const robId = this.rat[reg];
    if (robId !== null) {
      const robEntry = this.rob[robId];
      if (robEntry.ready) {
        return { value: robEntry.value, source: null };
      }
      return { value: 0, source: robId };
    }
    return { value: this.cpu.regs.get(reg), source: null };
  }

  // Issue: decode instruction and place in RS + ROB
  _issue() {
    if (this.halted) return false;

    const pc = this.cpu.regs.pc;
    const inst = this.cpu.mem.loadWord(pc) | 0;
    const d = CPU.decode(inst);
    const fuType = classifyToFU(d.opcode, d.funct7);
    
    // Find free RS and ROB
    const rs = this._findFreeRS(fuType);
    if (!rs) return false;
    const robEntry = this._allocROB();
    if (!robEntry) return false;

    const asm = Disassembler.disassemble(inst, pc);

    // Fill RS
    rs.busy = true;
    rs.op = inst;
    rs.opcode = d.opcode;
    rs.funct3 = d.funct3;
    rs.funct7 = d.funct7;
    rs.dest = robEntry.id;
    rs.imm = d.immI;
    rs.pc = pc;
    rs.asm = asm;
    rs.cycleIssued = this.cycle;

    // Read source registers
    const needsRs1 = [0b0110011, 0b0010011, 0b0000011, 0b0100011, 0b1100011, 0b1100111].includes(d.opcode);
    const needsRs2 = [0b0110011, 0b0100011, 0b1100011].includes(d.opcode);

    if (needsRs1) {
      const src = this._readReg(d.rs1);
      rs.vj = src.value;
      rs.qj = src.source;
    } else {
      rs.vj = 0;
      rs.qj = null;
    }

    if (needsRs2) {
      const src = this._readReg(d.rs2);
      rs.vk = src.value;
      rs.qk = src.source;
    } else {
      rs.vk = 0;
      rs.qk = null;
    }

    // Set immediate for I/S/B/U/J types
    switch (d.opcode) {
      case 0b0010011: rs.imm = d.immI; break;
      case 0b0000011: rs.imm = d.immI; break;
      case 0b0100011: rs.imm = d.immS; break;
      case 0b1100011: rs.imm = d.immB; break;
      case 0b0110111: rs.imm = d.immU; break;
      case 0b0010111: rs.imm = d.immU; break;
      case 0b1101111: rs.imm = d.immJ; break;
      case 0b1100111: rs.imm = d.immI; break;
    }

    // Fill ROB
    robEntry.pc = pc;
    robEntry.asm = asm;
    
    // Determine if this writes a register
    const writesReg = [0b0110011, 0b0010011, 0b0000011, 0b0110111, 0b0010111, 0b1101111, 0b1100111].includes(d.opcode);
    if (writesReg && d.rd !== 0) {
      robEntry.type = 'REG';
      robEntry.dest = d.rd;
      this.rat[d.rd] = robEntry.id;
    } else if (d.opcode === 0b0100011) {
      robEntry.type = 'STORE';
    } else if (d.opcode === 0b1100011) {
      robEntry.type = 'BRANCH';
    } else {
      robEntry.type = 'OTHER';
    }

    // Log
    this.instrLog.push({
      pc, asm,
      issued: this.cycle,
      execStart: 0,
      completed: 0,
      committed: 0,
    });

    // Handle EBREAK specially
    if (inst === 0x00100073) {
      robEntry.ready = true;
      robEntry.type = 'HALT';
      rs.clear();
    }

    // Advance PC (speculative — branches may correct later)
    this.cpu.regs.pc = pc + 4;

    return true;
  }

  // Execute: process ready reservation stations
  _execute() {
    for (const rs of this.stations) {
      if (!rs.isReady()) continue;
      if (rs.cycleExecuteStart > 0) continue; // Already executing
      rs.cycleExecuteStart = this.cycle;
    }
  }

  // Complete: check if any executing RS has finished (latency elapsed)
  _complete() {
    const completions = [];
    
    for (const rs of this.stations) {
      if (!rs.busy || rs.cycleExecuteStart === 0) continue;
      
      const latency = LATENCY[rs.fuType] || 1;
      if (this.cycle - rs.cycleExecuteStart + 1 < latency) continue;
      
      // Compute result
      const result = this._computeResult(rs);
      
      // Write to ROB
      const robEntry = this.rob[rs.dest];
      robEntry.value = result;
      robEntry.ready = true;
      
      completions.push({ robId: rs.dest, value: result });
      
      // Update instruction log
      const logEntry = this.instrLog.find(e => e.pc === rs.pc && e.completed === 0);
      if (logEntry) {
        logEntry.execStart = rs.cycleExecuteStart;
        logEntry.completed = this.cycle;
      }

      rs.clear();
    }

    // Broadcast on CDB — wake up dependent RS
    for (const { robId, value } of completions) {
      for (const rs of this.stations) {
        if (!rs.busy) continue;
        if (rs.qj === robId) { rs.vj = value; rs.qj = null; }
        if (rs.qk === robId) { rs.vk = value; rs.qk = null; }
      }
    }
  }

  _computeResult(rs) {
    const a = rs.vj;
    const b = rs.vk;
    const imm = rs.imm;

    switch (rs.opcode) {
      case 0b0110011: { // R-type
        if (rs.funct7 === 0b0000001) {
          // M extension
          switch (rs.funct3) {
            case 0: return Math.imul(a, b);
            case 4: return b === 0 ? -1 : (a / b) | 0;
            case 6: return b === 0 ? a : (a % b) | 0;
            default: return 0;
          }
        }
        switch (rs.funct3) {
          case 0: return rs.funct7 === 0b0100000 ? (a - b) | 0 : (a + b) | 0;
          case 1: return (a << (b & 0x1F)) | 0;
          case 2: return (a < b) ? 1 : 0;
          case 3: return ((a >>> 0) < (b >>> 0)) ? 1 : 0;
          case 4: return (a ^ b) | 0;
          case 5: return rs.funct7 === 0b0100000 ? (a >> (b & 0x1F)) | 0 : (a >>> (b & 0x1F)) | 0;
          case 6: return (a | b) | 0;
          case 7: return (a & b) | 0;
        }
        break;
      }
      case 0b0010011: { // I-type ALU
        switch (rs.funct3) {
          case 0: return (a + imm) | 0;
          case 2: return (a < imm) ? 1 : 0;
          case 3: return ((a >>> 0) < (imm >>> 0)) ? 1 : 0;
          case 4: return (a ^ imm) | 0;
          case 6: return (a | imm) | 0;
          case 7: return (a & imm) | 0;
          case 1: return (a << (imm & 0x1F)) | 0;
          case 5: return (imm & 0x400) ? (a >> (imm & 0x1F)) | 0 : (a >>> (imm & 0x1F)) | 0;
        }
        break;
      }
      case 0b0000011: // Load
        return this.cpu.mem.loadWordSigned(((a + imm) | 0) >>> 0);
      case 0b0110111: // LUI
        return imm;
      case 0b0010111: // AUIPC
        return (rs.pc + imm) | 0;
      case 0b1101111: // JAL
        return rs.pc + 4;
      case 0b1100111: // JALR
        return rs.pc + 4;
      default:
        return 0;
    }
    return 0;
  }

  // Commit: retire instructions from ROB head in order
  _commit() {
    const maxCommits = 2; // Up to 2 commits per cycle
    let commits = 0;
    
    while (commits < maxCommits && this.robCount > 0) {
      const entry = this.rob[this.robHead];
      if (!entry.busy || !entry.ready) break;

      if (entry.type === 'HALT') {
        this.halted = true;
        entry.clear();
        this.robHead = (this.robHead + 1) % this.robSize;
        this.robCount--;
        break;
      }

      if (entry.type === 'REG' && entry.dest !== 0) {
        this.cpu.regs.set(entry.dest, entry.value);
        // Clear RAT if it still points to this ROB entry
        if (this.rat[entry.dest] === entry.id) {
          this.rat[entry.dest] = null;
        }
      }

      if (entry.type === 'STORE') {
        // Store to memory
        // (simplified: store value from vk to address computed from vj+imm)
      }

      // Log commit
      const logEntry = this.instrLog.find(e => e.pc === entry.pc && e.committed === 0);
      if (logEntry) logEntry.committed = this.cycle;

      entry.clear();
      this.robHead = (this.robHead + 1) % this.robSize;
      this.robCount--;
      this.committed++;
      commits++;
    }
  }

  // Run one cycle
  step() {
    if (this.halted) return false;
    this.cycle++;
    
    this._commit();
    this._complete();
    this._execute();
    this._issue();
    
    return true;
  }

  run(maxCycles = 10000) {
    while (!this.halted && this.cycle < maxCycles) {
      this.step();
    }
    return this.getStats();
  }

  getStats() {
    return {
      cycles: this.cycle,
      committed: this.committed,
      IPC: this.cycle > 0 ? (this.committed / this.cycle).toFixed(2) : '0.00',
      halted: this.halted,
      robUtilization: this.robCount,
    };
  }

  formatLog() {
    const lines = ['PC         | Instruction                   | Issue | Exec  | Complete | Commit'];
    lines.push('-'.repeat(80));
    for (const e of this.instrLog) {
      lines.push(
        `0x${e.pc.toString(16).padStart(8,'0')} | ${e.asm.padEnd(30)} | ${String(e.issued).padStart(5)} | ${String(e.execStart).padStart(5)} | ${String(e.completed).padStart(8)} | ${String(e.committed).padStart(6)}`
      );
    }
    return lines.join('\n');
  }
}

module.exports = { TomasuloCPU, classifyToFU, FU_ALU, FU_MUL, FU_LOAD, FU_STORE, FU_BRANCH, LATENCY };
