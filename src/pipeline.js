'use strict';

const { CPU } = require('./cpu');
const { Disassembler } = require('./disassembler');

/**
 * RISC-V 5-Stage Pipeline Simulator
 * 
 * Classic RISC pipeline:
 *   IF  → ID  → EX  → MEM → WB
 *   Fetch  Decode  Execute  Memory  Writeback
 * 
 * Models:
 *   - Data hazards (RAW dependencies)
 *   - Forwarding (EX→EX, MEM→EX bypasses)
 *   - Load-use hazard stalls (1 cycle bubble)
 *   - Control hazards (branch taken → flush + 1 cycle penalty)
 *   - Pipeline diagram output
 */

// Stage names
const STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'];

// Instruction classification
function classifyInst(opcode, funct3) {
  switch (opcode) {
    case 0b0000011: return 'LOAD';
    case 0b0100011: return 'STORE';
    case 0b1100011: return 'BRANCH';
    case 0b1101111: return 'JAL';
    case 0b1100111: return 'JALR';
    case 0b0110111: return 'LUI';
    case 0b0010111: return 'AUIPC';
    case 0b0010011: return 'ALU_IMM';
    case 0b0110011: return 'ALU_REG';
    case 0b1110011: return 'SYSTEM';
    default: return 'OTHER';
  }
}

// Does this instruction write to rd?
function writesRd(type) {
  return ['LOAD', 'ALU_IMM', 'ALU_REG', 'LUI', 'AUIPC', 'JAL', 'JALR'].includes(type);
}

// Does this instruction read rs1?
function readsRs1(type) {
  return ['LOAD', 'STORE', 'BRANCH', 'ALU_IMM', 'ALU_REG', 'JALR'].includes(type);
}

// Does this instruction read rs2?
function readsRs2(type) {
  return ['STORE', 'BRANCH', 'ALU_REG'].includes(type);
}

class PipelineStage {
  constructor() {
    this.valid = false;
    this.pc = 0;
    this.inst = 0;
    this.decoded = null;
    this.type = '';
    this.asm = '';
    this.bubble = false;
  }

  clear() {
    this.valid = false;
    this.pc = 0;
    this.inst = 0;
    this.decoded = null;
    this.type = '';
    this.asm = '';
    this.bubble = false;
  }

  copyFrom(other) {
    this.valid = other.valid;
    this.pc = other.pc;
    this.inst = other.inst;
    this.decoded = other.decoded;
    this.type = other.type;
    this.asm = other.asm;
    this.bubble = other.bubble;
  }
}

class PipelineCPU {
  constructor(memorySize = 1024 * 1024) {
    // Underlying functional CPU for actual execution
    this.cpu = new CPU(memorySize);
    
    // Pipeline registers (between stages)
    this.stages = STAGES.map(() => new PipelineStage());
    
    // Stats
    this.totalCycles = 0;
    this.instructionsCompleted = 0;
    this.stallCycles = 0;
    this.flushCycles = 0;
    this.forwardings = 0;
    
    // Diagram log: each entry is { cycle, stages: [asm/bubble/stall for each stage] }
    this.diagram = [];
    
    // History of instruction flows
    this.instrHistory = []; // { pc, asm, stages: ['IF','ID',...,'WB'], startCycle }
    
    this.halted = false;
    this.forwarding = true; // Enable data forwarding by default
  }

  get mem() { return this.cpu.mem; }
  get regs() { return this.cpu.regs; }

  reset() {
    this.cpu.reset();
    this.stages.forEach(s => s.clear());
    this.totalCycles = 0;
    this.instructionsCompleted = 0;
    this.stallCycles = 0;
    this.flushCycles = 0;
    this.forwardings = 0;
    this.diagram = [];
    this.instrHistory = [];
    this.halted = false;
  }

  loadProgram(words, addr = 0) {
    this.cpu.loadProgram(words, addr);
  }

  /**
   * Detect data hazards between pipeline stages
   * Returns: 'none' | 'forward' | 'stall'
   */
  detectHazard() {
    const id = this.stages[1]; // ID stage (needs data)
    const ex = this.stages[2]; // EX stage (may produce data)
    const mem = this.stages[3]; // MEM stage (may produce data)

    if (!id.valid || !id.decoded) return 'none';

    const idType = id.type;
    const rs1 = id.decoded.rs1;
    const rs2 = id.decoded.rs2;
    const needsRs1 = readsRs1(idType) && rs1 !== 0;
    const needsRs2 = readsRs2(idType) && rs2 !== 0;

    // Check EX stage (1 cycle ahead)
    if (ex.valid && ex.decoded && writesRd(ex.type) && ex.decoded.rd !== 0) {
      const exRd = ex.decoded.rd;
      if ((needsRs1 && rs1 === exRd) || (needsRs2 && rs2 === exRd)) {
        // Load-use hazard: can't forward from EX stage of a LOAD (data not available yet)
        if (ex.type === 'LOAD') return 'stall';
        // Otherwise: can forward EX result
        if (this.forwarding) {
          this.forwardings++;
          return 'forward';
        }
        return 'stall';
      }
    }

    // Check MEM stage (2 cycles ahead)
    if (mem.valid && mem.decoded && writesRd(mem.type) && mem.decoded.rd !== 0) {
      const memRd = mem.decoded.rd;
      if ((needsRs1 && rs1 === memRd) || (needsRs2 && rs2 === memRd)) {
        if (this.forwarding) {
          this.forwardings++;
          return 'forward';
        }
        return 'stall';
      }
    }

    return 'none';
  }

  /**
   * Detect control hazard (branch taken or jump)
   */
  detectControlHazard() {
    const ex = this.stages[2];
    if (!ex.valid || !ex.decoded) return false;
    
    // Branches resolved in EX stage
    if (ex.type === 'BRANCH') {
      // Check if branch would be taken using functional CPU
      const d = ex.decoded;
      const a = this.cpu.regs.get(d.rs1);
      const b = this.cpu.regs.get(d.rs2);
      let taken = false;
      switch (d.funct3) {
        case 0b000: taken = a === b; break;
        case 0b001: taken = a !== b; break;
        case 0b100: taken = a < b; break;
        case 0b101: taken = a >= b; break;
        case 0b110: taken = (a >>> 0) < (b >>> 0); break;
        case 0b111: taken = (a >>> 0) >= (b >>> 0); break;
      }
      return taken;
    }
    
    // JAL/JALR always redirect
    if (ex.type === 'JAL' || ex.type === 'JALR') return true;
    
    return false;
  }

  /**
   * Run one pipeline cycle
   */
  step() {
    if (this.halted) return false;
    
    this.totalCycles++;
    
    // Detect hazards
    const hazard = this.detectHazard();
    const controlHazard = this.detectControlHazard();
    
    // Record diagram before advancing
    const cycleEntry = { cycle: this.totalCycles, stages: [] };
    
    // --- WB stage: complete instruction ---
    if (this.stages[4].valid && !this.stages[4].bubble) {
      this.instructionsCompleted++;
      // Actually execute the instruction on functional CPU
      this.cpu.regs.pc = this.stages[4].pc;
      this.cpu.step();
      
      if (this.cpu.halted) {
        this.halted = true;
      }
    }
    
    // Record current state for diagram
    for (let i = 0; i < 5; i++) {
      if (this.stages[i].valid) {
        cycleEntry.stages.push(this.stages[i].bubble ? '**' : this.stages[i].asm);
      } else {
        cycleEntry.stages.push('');
      }
    }
    this.diagram.push(cycleEntry);
    
    // --- Advance pipeline ---
    if (hazard === 'stall') {
      // Insert bubble: freeze IF and ID, insert bubble into EX
      this.stages[4].copyFrom(this.stages[3]); // MEM → WB
      this.stages[3].copyFrom(this.stages[2]); // EX → MEM
      this.stages[2].clear();                   // Bubble in EX
      this.stages[2].valid = true;
      this.stages[2].bubble = true;
      // IF and ID frozen (not advanced)
      this.stallCycles++;
    } else if (controlHazard) {
      // Flush IF and ID (2-cycle penalty with branch in EX)
      this.stages[4].copyFrom(this.stages[3]); // MEM → WB
      this.stages[3].copyFrom(this.stages[2]); // EX → MEM
      // Flush: insert bubbles for the 2 instructions in IF and ID
      this.stages[2].clear();
      this.stages[1].clear();
      // Fetch will resume from correct target next cycle
      this.stages[0].clear();
      this.flushCycles += 2;
      
      // Redirect PC to branch target
      const ex = this.stages[3]; // was EX, now MEM
      if (ex.valid && ex.decoded) {
        const d = ex.decoded;
        if (ex.type === 'BRANCH') {
          this.cpu.regs.pc = (ex.pc + d.immB) | 0;
        } else if (ex.type === 'JAL') {
          this.cpu.regs.pc = (ex.pc + d.immJ) | 0;
        } else if (ex.type === 'JALR') {
          this.cpu.regs.pc = ((this.cpu.regs.get(d.rs1) + d.immI) & ~1) | 0;
        }
      }
    } else {
      // Normal advance: WB ← MEM ← EX ← ID ← IF ← fetch
      this.stages[4].copyFrom(this.stages[3]);
      this.stages[3].copyFrom(this.stages[2]);
      this.stages[2].copyFrom(this.stages[1]);
      
      // Fetch new instruction into IF
      const pc = this.cpu.regs.pc;
      const inst = this.cpu.mem.loadWord(pc) | 0;
      const decoded = CPU.decode(inst);
      const type = classifyInst(decoded.opcode, decoded.funct3);
      
      this.stages[1].copyFrom(this.stages[0]);
      
      this.stages[0].valid = true;
      this.stages[0].pc = pc;
      this.stages[0].inst = inst;
      this.stages[0].decoded = decoded;
      this.stages[0].type = type;
      this.stages[0].asm = Disassembler.disassemble(inst, pc);
      this.stages[0].bubble = false;
      
      // Advance PC for next fetch
      this.cpu.regs.pc = pc + 4;
    }
    
    return true;
  }

  /**
   * Run until halted or maxCycles
   */
  run(maxCycles = 100000) {
    while (!this.halted && this.totalCycles < maxCycles) {
      this.step();
    }
    return this.getStats();
  }

  getStats() {
    return {
      totalCycles: this.totalCycles,
      instructionsCompleted: this.instructionsCompleted,
      CPI: this.instructionsCompleted > 0
        ? (this.totalCycles / this.instructionsCompleted).toFixed(2)
        : '∞',
      IPC: this.instructionsCompleted > 0
        ? (this.instructionsCompleted / this.totalCycles).toFixed(2)
        : '0.00',
      stallCycles: this.stallCycles,
      flushCycles: this.flushCycles,
      forwardings: this.forwardings,
      halted: this.halted,
    };
  }

  /**
   * Generate pipeline diagram (text format)
   * Shows how each instruction flows through the pipeline
   */
  formatDiagram(maxInstructions = 20) {
    // Reconstruct per-instruction flow
    const instFlows = new Map(); // pc → { asm, timeline: [stage per cycle] }
    const order = [];
    
    for (const entry of this.diagram) {
      for (let s = 0; s < 5; s++) {
        const asm = entry.stages[s];
        if (asm && asm !== '**') {
          if (!instFlows.has(asm + entry.cycle)) {
            // Find or create
            let key = asm;
            let found = false;
            for (const [k, v] of instFlows) {
              if (v.asm === asm && !v.done) {
                v.timeline.push({ cycle: entry.cycle, stage: STAGES[s] });
                found = true;
                break;
              }
            }
            if (!found) {
              const k = asm + '_' + order.length;
              instFlows.set(k, { asm, timeline: [{ cycle: entry.cycle, stage: STAGES[s] }], done: false });
              order.push(k);
            }
          }
        }
      }
    }
    
    // Simple text diagram
    const lines = [];
    lines.push(`Pipeline Diagram (${this.totalCycles} cycles, ${this.instructionsCompleted} instructions)`);
    lines.push(`CPI: ${this.getStats().CPI} | Stalls: ${this.stallCycles} | Flushes: ${this.flushCycles} | Forwards: ${this.forwardings}`);
    lines.push('');
    
    // Show cycle numbers
    const maxCyc = Math.min(this.totalCycles, 30);
    let header = 'Instruction'.padEnd(35) + ' | ';
    for (let c = 1; c <= maxCyc; c++) header += c.toString().padStart(3);
    lines.push(header);
    lines.push('-'.repeat(header.length));
    
    let count = 0;
    for (const key of order) {
      if (count >= maxInstructions) break;
      const flow = instFlows.get(key);
      let row = flow.asm.padEnd(35).slice(0, 35) + ' | ';
      for (let c = 1; c <= maxCyc; c++) {
        const t = flow.timeline.find(t => t.cycle === c);
        row += t ? t.stage.padStart(3) : '   ';
      }
      lines.push(row);
      count++;
    }
    
    return lines.join('\n');
  }
}

module.exports = { PipelineCPU, classifyInst, STAGES };
