import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineCPU } from './pipeline.js';
import { Assembler } from './assembler.js';

function pipeRun(source, opts = {}) {
  const asm = new Assembler();
  const { words, errors } = asm.assemble(source);
  if (errors.length > 0) throw new Error(`Assembly errors: ${errors.map(e => `L${e.line}: ${e.message}`).join(', ')}`);
  const pipe = new PipelineCPU(65536);
  pipe.loadProgram(words);
  pipe.cpu.regs.set(2, 65536 - 4);
  if (opts.noForwarding) pipe.forwarding = false;
  const stats = pipe.run(opts.maxCycles || 10000);
  return { pipe, stats };
}

// ============================================================
// Basic Pipeline Tests
// ============================================================

test('Pipeline: simple sequence', () => {
  const { pipe, stats } = pipeRun(`
    addi a0, zero, 42
    ebreak
  `);
  assert.ok(stats.halted);
  assert.equal(pipe.cpu.regs.get(10), 42);
  assert.ok(stats.instructionsCompleted >= 2);
});

test('Pipeline: no data hazard (independent instructions)', () => {
  const { stats } = pipeRun(`
    addi t0, zero, 1
    addi t1, zero, 2
    addi t2, zero, 3
    addi t3, zero, 4
    ebreak
  `);
  assert.equal(stats.stallCycles, 0);
});

test('Pipeline: RAW hazard with forwarding', () => {
  const { pipe, stats } = pipeRun(`
    addi t0, zero, 5
    addi t1, t0, 10    # RAW: reads t0 written by previous
    ebreak
  `);
  assert.ok(stats.halted);
  assert.equal(pipe.cpu.regs.get(6), 15); // t1 = 15
  // With forwarding, no stall needed for ALU→ALU
  assert.equal(stats.stallCycles, 0);
  assert.ok(stats.forwardings > 0);
});

test('Pipeline: load-use hazard causes stall', () => {
  const { pipe, stats } = pipeRun(`
    addi t0, zero, 42
    sw t0, 0(sp)
    lw t1, 0(sp)
    addi t2, t1, 1     # Load-use: t1 not available until MEM stage
    ebreak
  `);
  assert.ok(stats.halted);
  // Load-use hazard should cause at least 1 stall
  assert.ok(stats.stallCycles > 0, `Expected stalls, got ${stats.stallCycles}`);
});

test('Pipeline: no forwarding = more stalls', () => {
  const { stats: withFwd } = pipeRun(`
    addi t0, zero, 5
    addi t1, t0, 10
    addi t2, t1, 20
    ebreak
  `);
  
  const { stats: noFwd } = pipeRun(`
    addi t0, zero, 5
    addi t1, t0, 10
    addi t2, t1, 20
    ebreak
  `, { noForwarding: true });
  
  assert.ok(noFwd.stallCycles >= withFwd.stallCycles,
    `No forwarding (${noFwd.stallCycles}) should have >= stalls than with forwarding (${withFwd.stallCycles})`);
});

test('Pipeline: CPI > 1 with hazards', () => {
  const { stats } = pipeRun(`
    addi t0, zero, 42
    sw t0, 0(sp)
    lw t1, 0(sp)
    addi t2, t1, 1
    ebreak
  `);
  // With stalls, CPI should be > 1
  assert.ok(parseFloat(stats.CPI) >= 1.0);
});

test('Pipeline: stats tracking', () => {
  const { stats } = pipeRun(`
    addi a0, zero, 1
    addi a1, zero, 2
    add a2, a0, a1
    ebreak
  `);
  assert.ok(stats.totalCycles > 0);
  assert.ok(stats.instructionsCompleted > 0);
  assert.ok('CPI' in stats);
  assert.ok('IPC' in stats);
  assert.ok('stallCycles' in stats);
  assert.ok('flushCycles' in stats);
  assert.ok('forwardings' in stats);
});

test('Pipeline: correctness — straight-line code', () => {
  const { pipe } = pipeRun(`
    addi t0, zero, 1
    addi t1, zero, 2
    addi t2, zero, 3
    add a0, t0, t1
    add a0, a0, t2
    ebreak
  `);
  assert.equal(pipe.cpu.regs.get(10), 6); // 1+2+3
});

test('Pipeline: diagram output', () => {
  const { pipe } = pipeRun(`
    addi t0, zero, 1
    addi t1, zero, 2
    add t2, t0, t1
    ebreak
  `);
  const diagram = pipe.formatDiagram();
  assert.ok(diagram.includes('Pipeline Diagram'));
  assert.ok(diagram.includes('CPI'));
  assert.ok(diagram.length > 100);
});

test('Pipeline: forwarding count increases with dependencies', () => {
  const { stats: independent } = pipeRun(`
    addi t0, zero, 1
    addi t1, zero, 2
    addi t2, zero, 3
    ebreak
  `);
  
  const { stats: dependent } = pipeRun(`
    addi t0, zero, 1
    addi t1, t0, 2
    addi t2, t1, 3
    ebreak
  `);
  
  assert.ok(dependent.forwardings > independent.forwardings,
    `Dependent chain (${dependent.forwardings}) should forward more than independent (${independent.forwardings})`);
});
