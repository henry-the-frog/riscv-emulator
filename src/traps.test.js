import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSRFile, TrapController,
  CAUSE_ILLEGAL_INSTRUCTION, CAUSE_BREAKPOINT, CAUSE_ECALL_M,
  CAUSE_LOAD_PAGE_FAULT, CAUSE_STORE_PAGE_FAULT,
  CAUSE_SOFTWARE_INT, CAUSE_TIMER_INT, CAUSE_EXTERNAL_INT,
  MSTATUS_MIE, MSTATUS_MPIE, MIE_MSIE, MIE_MTIE, MIE_MEIE
} from './traps.js';

// ============================================================
// CSR Tests
// ============================================================

test('CSR: read/write', () => {
  const csrs = new CSRFile();
  csrs.write(0x305, 0x1000); // mtvec
  assert.equal(csrs.read(0x305), 0x1000);
});

test('CSR: read-set (atomic OR)', () => {
  const csrs = new CSRFile();
  csrs.write(0x300, 0x08);  // mstatus = 0x08
  const old = csrs.readSet(0x300, 0x80); // Set MPIE
  assert.equal(old, 0x08);
  assert.equal(csrs.read(0x300), 0x88);
});

test('CSR: read-clear (atomic AND NOT)', () => {
  const csrs = new CSRFile();
  csrs.write(0x300, 0xFF);
  const old = csrs.readClear(0x300, 0x08); // Clear MIE
  assert.equal(old, 0xFF);
  assert.equal(csrs.read(0x300), 0xF7);
});

test('CSR: unknown register returns 0', () => {
  const csrs = new CSRFile();
  assert.equal(csrs.read(0xFFF), 0);
});

// ============================================================
// Trap Handling Tests
// ============================================================

test('Trap: exception saves state', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  // Set handler
  csrs.write(0x305, 0x2000); // mtvec = 0x2000
  csrs.write(0x300, MSTATUS_MIE); // Enable interrupts
  
  // Trigger illegal instruction exception
  const handlerPC = trap.handleTrap(0x1000, CAUSE_ILLEGAL_INSTRUCTION, 0xDEAD);
  
  assert.equal(handlerPC, 0x2000);
  assert.equal(csrs.read(0x341), 0x1000);  // mepc saved
  assert.equal(csrs.read(0x342), CAUSE_ILLEGAL_INSTRUCTION); // mcause
  assert.equal(csrs.read(0x343), 0xDEAD);  // mtval
  
  // MIE should be cleared, MPIE should be set
  const mstatus = csrs.read(0x300);
  assert.ok(!(mstatus & MSTATUS_MIE));
  assert.ok(mstatus & MSTATUS_MPIE);
});

test('Trap: mret restores state', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  csrs.write(0x305, 0x2000);
  csrs.write(0x300, MSTATUS_MIE);
  
  // Take a trap
  trap.handleTrap(0x1000, CAUSE_ECALL_M);
  
  // MIE should be off now
  assert.ok(!(csrs.read(0x300) & MSTATUS_MIE));
  
  // Return from trap
  const resumePC = trap.mret();
  assert.equal(resumePC, 0x1000);
  
  // MIE should be restored
  assert.ok(csrs.read(0x300) & MSTATUS_MIE);
});

test('Trap: vectored mode', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  // Vectored mode: base | 1
  csrs.write(0x305, 0x2000 | 1);
  csrs.write(0x300, MSTATUS_MIE);
  
  // Timer interrupt (cause 7)
  const handlerPC = trap.handleTrap(0x1000, CAUSE_TIMER_INT);
  // base + 4 * 7 = 0x2000 + 28 = 0x201C
  assert.equal(handlerPC, 0x2000 + 4 * 7);
});

test('Trap: direct mode for exception', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  // Vectored mode
  csrs.write(0x305, 0x2000 | 1);
  csrs.write(0x300, MSTATUS_MIE);
  
  // Exceptions always go to base in vectored mode
  const handlerPC = trap.handleTrap(0x1000, CAUSE_ILLEGAL_INSTRUCTION);
  assert.equal(handlerPC, 0x2000);
});

// ============================================================
// Interrupt Tests
// ============================================================

test('Interrupt: no pending when disabled', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  // Global interrupts disabled
  csrs.write(0x300, 0); // MIE = 0
  csrs.write(0x304, MIE_MTIE); // Timer enabled
  trap.raiseTimerInterrupt();
  
  assert.equal(trap.checkPendingInterrupt(), null);
});

test('Interrupt: pending when enabled', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  csrs.write(0x300, MSTATUS_MIE);
  csrs.write(0x304, MIE_MTIE);
  trap.raiseTimerInterrupt();
  
  assert.equal(trap.checkPendingInterrupt(), CAUSE_TIMER_INT);
});

test('Interrupt: priority (external > software > timer)', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  csrs.write(0x300, MSTATUS_MIE);
  csrs.write(0x304, MIE_MTIE | MIE_MSIE | MIE_MEIE);
  
  // Raise all three
  trap.raiseTimerInterrupt();
  let mip = csrs.read(0x344);
  mip |= MIE_MSIE; // Software
  csrs.write(0x344, mip);
  trap.raiseExternalInterrupt();
  
  // External should be highest priority
  assert.equal(trap.checkPendingInterrupt(), CAUSE_EXTERNAL_INT);
});

test('Interrupt: clear interrupt', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  csrs.write(0x300, MSTATUS_MIE);
  csrs.write(0x304, MIE_MTIE);
  
  trap.raiseTimerInterrupt();
  assert.ok(trap.checkPendingInterrupt());
  
  trap.clearTimerInterrupt();
  assert.equal(trap.checkPendingInterrupt(), null);
});

test('Interrupt: disabled after trap, re-enabled on mret', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  
  csrs.write(0x305, 0x2000);
  csrs.write(0x300, MSTATUS_MIE);
  csrs.write(0x304, MIE_MTIE);
  
  trap.raiseTimerInterrupt();
  const cause = trap.checkPendingInterrupt();
  assert.equal(cause, CAUSE_TIMER_INT);
  
  // Take the trap
  trap.handleTrap(0x1000, cause);
  
  // Interrupts now disabled — no pending
  assert.equal(trap.checkPendingInterrupt(), null);
  
  // Return from trap handler
  trap.clearTimerInterrupt();
  trap.mret();
  
  // Interrupts re-enabled
  assert.ok(csrs.read(0x300) & MSTATUS_MIE);
});

// ============================================================
// Trap Log Tests
// ============================================================

test('Trap: log records traps', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  csrs.write(0x305, 0x2000);
  csrs.write(0x300, MSTATUS_MIE);
  
  trap.handleTrap(0x1000, CAUSE_ECALL_M);
  trap.handleTrap(0x1004, CAUSE_BREAKPOINT);
  
  assert.equal(trap.trapLog.length, 2);
  assert.equal(trap.trapLog[0].cause, CAUSE_ECALL_M);
  assert.equal(trap.trapLog[0].isInterrupt, false);
  assert.equal(trap.trapLog[1].cause, CAUSE_BREAKPOINT);
});

test('Trap: interrupt flag in cause', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  csrs.write(0x305, 0x2000);
  csrs.write(0x300, MSTATUS_MIE);
  
  trap.handleTrap(0x1000, CAUSE_TIMER_INT);
  
  assert.equal(trap.trapLog[0].isInterrupt, true);
  // mcause should have MSB set
  const mcause = csrs.read(0x342);
  assert.ok(mcause & (1 << 31));
});

test('Trap: nested trap (MIE cleared)', () => {
  const csrs = new CSRFile();
  const trap = new TrapController(csrs);
  csrs.write(0x305, 0x2000);
  csrs.write(0x300, MSTATUS_MIE);
  
  // First trap
  trap.handleTrap(0x1000, CAUSE_ECALL_M);
  assert.ok(!(csrs.read(0x300) & MSTATUS_MIE));
  
  // Second trap while in handler (MIE off)
  trap.handleTrap(0x2004, CAUSE_LOAD_PAGE_FAULT, 0xBAD);
  assert.equal(csrs.read(0x341), 0x2004);  // mepc updated
  assert.equal(csrs.read(0x342), CAUSE_LOAD_PAGE_FAULT);
  assert.equal(csrs.read(0x343), 0xBAD);
});
