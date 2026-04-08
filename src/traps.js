'use strict';

/**
 * RISC-V Trap & Interrupt System
 * 
 * Models the RISC-V privileged architecture for Machine mode:
 * - CSR registers (mstatus, mie, mip, mtvec, mepc, mcause, mtval)
 * - Exception handling (illegal instruction, ecall, page fault, etc.)
 * - Interrupt handling (timer, software, external)
 * - Trap delegation
 * 
 * CSR addresses:
 *   mstatus  = 0x300  Machine status
 *   mie      = 0x304  Machine interrupt enable
 *   mtvec    = 0x305  Machine trap handler vector
 *   mscratch = 0x340  Machine scratch register
 *   mepc     = 0x341  Machine exception PC
 *   mcause   = 0x342  Machine trap cause
 *   mtval    = 0x343  Machine trap value
 *   mip      = 0x344  Machine interrupt pending
 *   mcycle   = 0xB00  Cycle counter
 *   minstret = 0xB02  Instructions retired
 */

// Exception causes
const CAUSE_MISALIGNED_FETCH    = 0;
const CAUSE_FETCH_ACCESS        = 1;
const CAUSE_ILLEGAL_INSTRUCTION = 2;
const CAUSE_BREAKPOINT          = 3;
const CAUSE_MISALIGNED_LOAD     = 4;
const CAUSE_LOAD_ACCESS         = 5;
const CAUSE_MISALIGNED_STORE    = 6;
const CAUSE_STORE_ACCESS        = 7;
const CAUSE_ECALL_U             = 8;
const CAUSE_ECALL_S             = 9;
const CAUSE_ECALL_M             = 11;
const CAUSE_FETCH_PAGE_FAULT    = 12;
const CAUSE_LOAD_PAGE_FAULT     = 13;
const CAUSE_STORE_PAGE_FAULT    = 15;

// Interrupt causes (bit 31 set = interrupt)
const CAUSE_SOFTWARE_INT = 3 | (1 << 31);
const CAUSE_TIMER_INT    = 7 | (1 << 31);
const CAUSE_EXTERNAL_INT = 11 | (1 << 31);

// mstatus bits
const MSTATUS_MIE  = 1 << 3;   // Machine interrupt enable
const MSTATUS_MPIE = 1 << 7;   // Previous MIE
const MSTATUS_MPP_MASK = 3 << 11; // Previous privilege mode

// mie/mip bits
const MIE_MSIE = 1 << 3;  // Machine software interrupt enable
const MIE_MTIE = 1 << 7;  // Machine timer interrupt enable
const MIE_MEIE = 1 << 11; // Machine external interrupt enable

class CSRFile {
  constructor() {
    this.regs = new Map();
    // Initialize standard CSRs
    this.regs.set(0x300, 0);         // mstatus
    this.regs.set(0x304, 0);         // mie
    this.regs.set(0x305, 0);         // mtvec
    this.regs.set(0x340, 0);         // mscratch
    this.regs.set(0x341, 0);         // mepc
    this.regs.set(0x342, 0);         // mcause
    this.regs.set(0x343, 0);         // mtval
    this.regs.set(0x344, 0);         // mip
    this.regs.set(0xB00, 0);         // mcycle
    this.regs.set(0xB02, 0);         // minstret
    this.regs.set(0xF11, 0);         // mvendorid
    this.regs.set(0xF12, 0);         // marchid
    this.regs.set(0xF13, 0);         // mimpid
    this.regs.set(0xF14, 0);         // mhartid
  }

  read(addr) {
    addr = addr & 0xFFF;
    return (this.regs.get(addr) || 0) >>> 0;
  }

  write(addr, val) {
    addr = addr & 0xFFF;
    this.regs.set(addr, val | 0);
  }

  // CSR read-modify-write operations
  readSet(addr, mask) {
    const old = this.read(addr);
    this.write(addr, old | mask);
    return old;
  }

  readClear(addr, mask) {
    const old = this.read(addr);
    this.write(addr, old & ~mask);
    return old;
  }
}

class TrapController {
  constructor(csrs) {
    this.csrs = csrs;
    this.trapLog = [];
  }

  /**
   * Handle a trap (exception or interrupt)
   * @param pc Current PC when trap occurred
   * @param cause Trap cause number
   * @param tval Trap value (faulting address, instruction, etc.)
   * @returns New PC (trap handler address)
   */
  handleTrap(pc, cause, tval = 0) {
    const isInterrupt = (cause & (1 << 31)) !== 0;
    
    // Save state
    this.csrs.write(0x341, pc);    // mepc = PC
    this.csrs.write(0x342, cause); // mcause
    this.csrs.write(0x343, tval);  // mtval
    
    // Update mstatus: save MIE to MPIE, clear MIE
    let mstatus = this.csrs.read(0x300);
    if (mstatus & MSTATUS_MIE) {
      mstatus |= MSTATUS_MPIE;
    } else {
      mstatus &= ~MSTATUS_MPIE;
    }
    mstatus &= ~MSTATUS_MIE; // Disable interrupts
    this.csrs.write(0x300, mstatus);
    
    // Get handler address from mtvec
    const mtvec = this.csrs.read(0x305);
    const mode = mtvec & 0x3;
    const base = mtvec & ~0x3;
    
    let handlerPC;
    if (mode === 0) {
      // Direct: all traps go to base
      handlerPC = base;
    } else if (mode === 1) {
      // Vectored: interrupts go to base + 4*cause
      if (isInterrupt) {
        handlerPC = base + 4 * (cause & 0x7FFFFFFF);
      } else {
        handlerPC = base;
      }
    } else {
      handlerPC = base;
    }
    
    this.trapLog.push({
      pc,
      cause,
      isInterrupt,
      tval,
      handler: handlerPC,
    });
    
    return handlerPC;
  }

  /**
   * Return from trap (MRET instruction)
   * @returns PC to resume at
   */
  mret() {
    // Restore MIE from MPIE
    let mstatus = this.csrs.read(0x300);
    if (mstatus & MSTATUS_MPIE) {
      mstatus |= MSTATUS_MIE;
    } else {
      mstatus &= ~MSTATUS_MIE;
    }
    mstatus |= MSTATUS_MPIE; // Set MPIE
    this.csrs.write(0x300, mstatus);
    
    return this.csrs.read(0x341); // Return to mepc
  }

  /**
   * Check if any interrupt is pending and enabled
   * @returns cause number or null
   */
  checkPendingInterrupt() {
    const mstatus = this.csrs.read(0x300);
    if (!(mstatus & MSTATUS_MIE)) return null; // Interrupts disabled
    
    const mie = this.csrs.read(0x304);
    const mip = this.csrs.read(0x344);
    const pending = mie & mip;
    
    if (!pending) return null;
    
    // Priority: external > software > timer
    if (pending & MIE_MEIE) return CAUSE_EXTERNAL_INT;
    if (pending & MIE_MSIE) return CAUSE_SOFTWARE_INT;
    if (pending & MIE_MTIE) return CAUSE_TIMER_INT;
    
    return null;
  }

  /**
   * Raise a timer interrupt
   */
  raiseTimerInterrupt() {
    let mip = this.csrs.read(0x344);
    mip |= MIE_MTIE;
    this.csrs.write(0x344, mip);
  }

  /**
   * Clear timer interrupt
   */
  clearTimerInterrupt() {
    let mip = this.csrs.read(0x344);
    mip &= ~MIE_MTIE;
    this.csrs.write(0x344, mip);
  }

  /**
   * Raise an external interrupt
   */
  raiseExternalInterrupt() {
    let mip = this.csrs.read(0x344);
    mip |= MIE_MEIE;
    this.csrs.write(0x344, mip);
  }

  clearExternalInterrupt() {
    let mip = this.csrs.read(0x344);
    mip &= ~MIE_MEIE;
    this.csrs.write(0x344, mip);
  }
}

module.exports = {
  CSRFile, TrapController,
  CAUSE_MISALIGNED_FETCH, CAUSE_FETCH_ACCESS, CAUSE_ILLEGAL_INSTRUCTION,
  CAUSE_BREAKPOINT, CAUSE_MISALIGNED_LOAD, CAUSE_LOAD_ACCESS,
  CAUSE_MISALIGNED_STORE, CAUSE_STORE_ACCESS,
  CAUSE_ECALL_U, CAUSE_ECALL_S, CAUSE_ECALL_M,
  CAUSE_FETCH_PAGE_FAULT, CAUSE_LOAD_PAGE_FAULT, CAUSE_STORE_PAGE_FAULT,
  CAUSE_SOFTWARE_INT, CAUSE_TIMER_INT, CAUSE_EXTERNAL_INT,
  MSTATUS_MIE, MSTATUS_MPIE, MIE_MSIE, MIE_MTIE, MIE_MEIE
};
