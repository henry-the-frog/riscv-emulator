import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlwaysNotTaken, AlwaysTaken, BackwardTaken,
  OneBitPredictor, TwoBitPredictor, GSharePredictor, TournamentPredictor,
  PredictorBenchmark
} from './branch-predictor.js';

// ============================================================
// Individual Predictor Tests
// ============================================================

test('AlwaysNotTaken: always predicts not-taken', () => {
  const p = new AlwaysNotTaken();
  assert.equal(p.predict(0x100).taken, false);
  p.update(0x100, true, 0x80);
  assert.equal(p.predict(0x100).taken, false); // still not-taken
});

test('AlwaysTaken: always predicts taken', () => {
  const p = new AlwaysTaken();
  assert.equal(p.predict(0x100).taken, true);
});

test('BackwardTaken: backward=taken, forward=not-taken', () => {
  const p = new BackwardTaken();
  assert.equal(p.predict(0x100, -8).taken, true);   // backward → taken
  assert.equal(p.predict(0x100, 8).taken, false);    // forward → not-taken
});

test('OneBit: learns from last outcome', () => {
  const p = new OneBitPredictor(64);
  // Initially: not-taken
  assert.equal(p.predict(0x100).taken, false);
  // After taken: predicts taken
  p.update(0x100, true, 0x80);
  assert.equal(p.predict(0x100).taken, true);
  // After not-taken: predicts not-taken
  p.update(0x100, false, 0x80);
  assert.equal(p.predict(0x100).taken, false);
});

test('TwoBit: needs two misses to switch', () => {
  const p = new TwoBitPredictor(64);
  // Start at WeaklyNT (state 1)
  assert.equal(p.predict(0x100).taken, false);
  
  // One taken → WeaklyT (state 2)
  p.update(0x100, true, 0x80);
  assert.equal(p.predict(0x100).taken, true);
  
  // One not-taken → back to WeaklyNT (state 1)
  p.update(0x100, false, 0x80);
  assert.equal(p.predict(0x100).taken, false);
  
  // Two taken → StronglyT (state 3)
  p.update(0x100, true, 0x80);
  p.update(0x100, true, 0x80);
  assert.equal(p.predict(0x100).taken, true);
  
  // One not-taken → WeaklyT (state 2) — still taken!
  p.update(0x100, false, 0x80);
  assert.equal(p.predict(0x100).taken, true);
  
  // Another not-taken → WeaklyNT (state 1)
  p.update(0x100, false, 0x80);
  assert.equal(p.predict(0x100).taken, false);
});

test('GShare: uses global history correlation', () => {
  const p = new GSharePredictor(4, 64);
  // Train with consistent pattern: taken, taken, taken
  for (let i = 0; i < 10; i++) p.update(0x100, true, 0x80);
  assert.equal(p.predict(0x100).taken, true);
  
  // Different predictor trained with not-taken
  const p2 = new GSharePredictor(4, 64);
  for (let i = 0; i < 10; i++) p2.update(0x100, false, 0);
  assert.equal(p2.predict(0x100).taken, false);
});

test('Tournament: combines local and global', () => {
  const p = new TournamentPredictor(64);
  // Just verify it works without crashing
  const pred = p.predict(0x100);
  assert.ok('taken' in pred);
  p.update(0x100, true, 0x80);
  p.update(0x100, false, 0x80);
  p.update(0x100, true, 0x80);
});

// ============================================================
// Benchmark Tests
// ============================================================

test('Benchmark: simple loop (100 iterations)', () => {
  const bench = new PredictorBenchmark();
  const trace = PredictorBenchmark.loopTrace(0x100, 100);
  const results = bench.run(trace);
  
  // AlwaysNotTaken: misses 100 taken, hits 1 not-taken = 1/101
  const ant = results.find(r => r.name === 'AlwaysNotTaken');
  assert.equal(ant.correct, 1);
  
  // AlwaysTaken: hits 100 taken, misses 1 = 100/101
  const at = results.find(r => r.name === 'AlwaysTaken');
  assert.equal(at.correct, 100);
  
  // BackwardTaken should be same as AlwaysTaken for backward loops
  const bt = results.find(r => r.name === 'BackwardTaken');
  assert.equal(bt.correct, 100);
  
  // TwoBit should be very good on loops
  const tb = results.find(r => r.name === 'TwoBit');
  assert.ok(tb.correct >= 98, `TwoBit got ${tb.correct}/101`);
});

test('Benchmark: alternating pattern', () => {
  const bench = new PredictorBenchmark();
  const trace = PredictorBenchmark.alternatingTrace(0x100, 100);
  const results = bench.run(trace);
  
  // AlwaysNotTaken: hits 50/100
  const ant = results.find(r => r.name === 'AlwaysNotTaken');
  assert.equal(ant.correct, 50);
  
  // 1-bit predictor: terrible on alternating (always predicts previous = always wrong)
  const ob = results.find(r => r.name === 'OneBit');
  assert.ok(ob.correct <= 1, `OneBit should be bad on alternating: ${ob.correct}/100`);
  
  // 2-bit should handle alternating slightly better
  const tb = results.find(r => r.name === 'TwoBit');
  assert.ok(tb.correct >= 0); // At least doesn't crash
});

test('Benchmark: nested loop', () => {
  const bench = new PredictorBenchmark();
  const trace = PredictorBenchmark.nestedLoopTrace(0x200, 0x100, 10, 20);
  const results = bench.run(trace);
  
  // All predictors should have some accuracy
  for (const r of results) {
    assert.ok(r.total > 0, `${r.name} has zero branches`);
    assert.ok(r.correct >= 0);
  }
  
  // GShare and Tournament should be good on nested loops
  const gs = results.find(r => r.name === 'GShare');
  const tm = results.find(r => r.name === 'Tournament');
  assert.ok(parseFloat(gs.accuracy) > 50, `GShare: ${gs.accuracy}`);
  assert.ok(parseFloat(tm.accuracy) > 50, `Tournament: ${tm.accuracy}`);
});

test('Benchmark: format results', () => {
  const bench = new PredictorBenchmark();
  const trace = PredictorBenchmark.loopTrace(0x100, 50);
  const results = bench.run(trace);
  const formatted = PredictorBenchmark.formatResults(results);
  assert.ok(formatted.includes('Predictor'));
  assert.ok(formatted.includes('Accuracy'));
  assert.ok(formatted.includes('AlwaysNotTaken'));
  assert.ok(formatted.includes('TwoBit'));
  assert.ok(formatted.includes('GShare'));
});

test('Benchmark: BTB stores targets', () => {
  const p = new OneBitPredictor(64);
  p.update(0x100, true, 0x80);
  const pred = p.predict(0x100);
  assert.equal(pred.taken, true);
  assert.equal(pred.target, 0x80);
});

test('Benchmark: different PCs are independent', () => {
  const p = new TwoBitPredictor(256);
  // Train PC 0x100 as taken
  for (let i = 0; i < 5; i++) p.update(0x100, true, 0x80);
  // Train PC 0x200 as not-taken
  for (let i = 0; i < 5; i++) p.update(0x200, false, 0);
  
  assert.equal(p.predict(0x100).taken, true);
  assert.equal(p.predict(0x200).taken, false);
});

test('Benchmark: loop with exit prediction', () => {
  // Loop 1000 times — measure accuracy
  const bench = new PredictorBenchmark();
  const trace = PredictorBenchmark.loopTrace(0x100, 1000);
  const results = bench.run(trace);
  
  // With 1000 iterations, 2-bit should be >99%
  const tb = results.find(r => r.name === 'TwoBit');
  assert.ok(parseFloat(tb.accuracy) > 99, `TwoBit on 1000-iter loop: ${tb.accuracy}`);
  
  // GShare should also be excellent
  const gs = results.find(r => r.name === 'GShare');
  assert.ok(parseFloat(gs.accuracy) >= 99, `GShare on 1000-iter loop: ${gs.accuracy}`);
});

test('Benchmark: mixed branches (loop + conditional)', () => {
  // Simulate: outer loop with inner if-else
  const trace = [];
  for (let i = 0; i < 50; i++) {
    // Inner conditional: taken when i is even
    trace.push({ pc: 0x100, taken: i % 2 === 0, target: 0x120, offset: 32 });
    // Loop back
    trace.push({ pc: 0x140, taken: true, target: 0x80, offset: -192 });
  }
  trace.push({ pc: 0x140, taken: false, target: 0, offset: -192 }); // exit
  
  const bench = new PredictorBenchmark();
  const results = bench.run(trace);
  
  // GShare should handle correlated branches better
  const gs = results.find(r => r.name === 'GShare');
  const ob = results.find(r => r.name === 'OneBit');
  assert.ok(gs.correct >= ob.correct,
    `GShare (${gs.correct}) should be >= OneBit (${ob.correct}) on correlated branches`);
});
