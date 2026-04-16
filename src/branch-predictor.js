/**
 * RISC-V Branch Predictors
 * 
 * Implements multiple branch prediction strategies:
 * 1. AlwaysNotTaken — simplest, predict fall-through
 * 2. AlwaysTaken — predict branch taken
 * 3. BackwardTaken — predict backward branches taken (loops), forward not-taken
 * 4. OneBit — 1-bit predictor (last outcome)
 * 5. TwoBitSaturating — 2-bit saturating counter (classic textbook)
 * 6. GShare — global history XOR'd with PC (correlating predictor)
 * 7. Tournament — hybrid: choose between local and global predictor
 * 
 * All implement: predict(pc) → { taken, target } and update(pc, actualTaken, actualTarget)
 */

class AlwaysNotTaken {
  constructor() { this.name = 'AlwaysNotTaken'; }
  predict(_pc) { return { taken: false, target: 0 }; }
  update(_pc, _taken, _target) {}
}

class AlwaysTaken {
  constructor() { this.name = 'AlwaysTaken'; }
  predict(_pc) { return { taken: true, target: 0 }; } // target unknown without BTB
  update(_pc, _taken, _target) {}
}

class BackwardTaken {
  constructor() { this.name = 'BackwardTaken'; }
  predict(pc, branchOffset) {
    // Backward (negative offset) = taken (loop), forward = not taken
    return { taken: branchOffset < 0, target: pc + branchOffset };
  }
  update(_pc, _taken, _target) {}
}

class OneBitPredictor {
  constructor(tableSize = 256) {
    this.name = 'OneBit';
    this.table = new Uint8Array(tableSize); // 0 = not-taken, 1 = taken
    this.size = tableSize;
    // Branch Target Buffer
    this.btb = new Map();
  }

  _index(pc) { return (pc >>> 2) % this.size; }

  predict(pc) {
    const idx = this._index(pc);
    const taken = this.table[idx] === 1;
    return { taken, target: this.btb.get(pc) || 0 };
  }

  update(pc, taken, target) {
    const idx = this._index(pc);
    this.table[idx] = taken ? 1 : 0;
    if (taken && target) this.btb.set(pc, target);
  }
}

class TwoBitPredictor {
  constructor(tableSize = 256) {
    this.name = 'TwoBit';
    // States: 0=StronglyNT, 1=WeaklyNT, 2=WeaklyT, 3=StronglyT
    this.table = new Uint8Array(tableSize);
    this.table.fill(1); // Start weakly not-taken
    this.size = tableSize;
    this.btb = new Map();
  }

  _index(pc) { return (pc >>> 2) % this.size; }

  predict(pc) {
    const idx = this._index(pc);
    const taken = this.table[idx] >= 2;
    return { taken, target: this.btb.get(pc) || 0 };
  }

  update(pc, taken, target) {
    const idx = this._index(pc);
    if (taken) {
      this.table[idx] = Math.min(3, this.table[idx] + 1);
    } else {
      this.table[idx] = Math.max(0, this.table[idx] - 1);
    }
    if (taken && target) this.btb.set(pc, target);
  }
}

class GSharePredictor {
  constructor(historyBits = 8, tableSize = 256) {
    this.name = 'GShare';
    this.historyBits = historyBits;
    this.history = 0;
    this.historyMask = (1 << historyBits) - 1;
    this.table = new Uint8Array(tableSize);
    this.table.fill(1);
    this.size = tableSize;
    this.btb = new Map();
  }

  _index(pc) {
    return ((pc >>> 2) ^ this.history) % this.size;
  }

  predict(pc) {
    const idx = this._index(pc);
    const taken = this.table[idx] >= 2;
    return { taken, target: this.btb.get(pc) || 0 };
  }

  update(pc, taken, target) {
    const idx = this._index(pc);
    if (taken) {
      this.table[idx] = Math.min(3, this.table[idx] + 1);
    } else {
      this.table[idx] = Math.max(0, this.table[idx] - 1);
    }
    // Update global history register
    this.history = ((this.history << 1) | (taken ? 1 : 0)) & this.historyMask;
    if (taken && target) this.btb.set(pc, target);
  }
}

class TournamentPredictor {
  constructor(tableSize = 256) {
    this.name = 'Tournament';
    this.local = new TwoBitPredictor(tableSize);
    this.global = new GSharePredictor(8, tableSize);
    // Choice table: 0-1 = use local, 2-3 = use global
    this.choice = new Uint8Array(tableSize);
    this.choice.fill(2); // Start preferring global
    this.size = tableSize;
  }

  _choiceIndex(pc) { return (pc >>> 2) % this.size; }

  predict(pc) {
    const ci = this._choiceIndex(pc);
    const useGlobal = this.choice[ci] >= 2;
    return useGlobal ? this.global.predict(pc) : this.local.predict(pc);
  }

  update(pc, taken, target) {
    const localPred = this.local.predict(pc).taken;
    const globalPred = this.global.predict(pc).taken;
    
    // Update choice based on which was correct
    const ci = this._choiceIndex(pc);
    const localCorrect = localPred === taken;
    const globalCorrect = globalPred === taken;
    
    if (globalCorrect && !localCorrect) {
      this.choice[ci] = Math.min(3, this.choice[ci] + 1);
    } else if (!globalCorrect && localCorrect) {
      this.choice[ci] = Math.max(0, this.choice[ci] - 1);
    }
    
    // Update both sub-predictors
    this.local.update(pc, taken, target);
    this.global.update(pc, taken, target);
  }
}

/**
 * Branch prediction benchmarker
 * Runs a trace of branch outcomes through multiple predictors
 */
class PredictorBenchmark {
  constructor() {
    this.predictors = [
      new AlwaysNotTaken(),
      new AlwaysTaken(),
      new BackwardTaken(),
      new OneBitPredictor(),
      new TwoBitPredictor(),
      new GSharePredictor(),
      new TournamentPredictor(),
    ];
  }

  /**
   * Run a branch trace through all predictors
   * trace: [{ pc, taken, target, offset }]
   */
  run(trace) {
    const results = [];
    
    for (const predictor of this.predictors) {
      let correct = 0;
      let total = trace.length;
      
      for (const branch of trace) {
        let prediction;
        if (predictor.name === 'BackwardTaken') {
          prediction = predictor.predict(branch.pc, branch.offset || 0);
        } else {
          prediction = predictor.predict(branch.pc);
        }
        
        if (prediction.taken === branch.taken) correct++;
        predictor.update(branch.pc, branch.taken, branch.target);
      }
      
      results.push({
        name: predictor.name,
        correct,
        total,
        accuracy: total > 0 ? ((correct / total) * 100).toFixed(1) + '%' : 'N/A',
        mispredictions: total - correct,
      });
    }
    
    return results;
  }

  /**
   * Generate a loop trace (N iterations of a loop)
   */
  static loopTrace(pc, iterations) {
    const trace = [];
    for (let i = 0; i < iterations; i++) {
      trace.push({ pc, taken: true, target: pc - 8, offset: -8 }); // backward branch, taken
    }
    trace.push({ pc, taken: false, target: 0, offset: -8 }); // last iteration: not taken (exit)
    return trace;
  }

  /**
   * Generate alternating branch pattern
   */
  static alternatingTrace(pc, count) {
    const trace = [];
    for (let i = 0; i < count; i++) {
      trace.push({ pc, taken: i % 2 === 0, target: pc + 8, offset: 8 });
    }
    return trace;
  }

  /**
   * Generate a nested loop trace
   */
  static nestedLoopTrace(outerPC, innerPC, outerIters, innerIters) {
    const trace = [];
    for (let i = 0; i < outerIters; i++) {
      for (let j = 0; j < innerIters; j++) {
        trace.push({ pc: innerPC, taken: true, target: innerPC - 8, offset: -8 });
      }
      trace.push({ pc: innerPC, taken: false, target: 0, offset: -8 }); // exit inner
      trace.push({ pc: outerPC, taken: true, target: outerPC - 16, offset: -16 });
    }
    trace.push({ pc: outerPC, taken: false, target: 0, offset: -16 }); // exit outer
    return trace;
  }

  /**
   * Format results as a comparison table
   */
  static formatResults(results) {
    const lines = ['Predictor            | Accuracy | Mispredict | Correct/Total'];
    lines.push('-'.repeat(65));
    for (const r of results) {
      lines.push(
        `${r.name.padEnd(20)} | ${r.accuracy.padStart(8)} | ${String(r.mispredictions).padStart(10)} | ${r.correct}/${r.total}`
      );
    }
    return lines.join('\n');
  }
}

export {
  AlwaysNotTaken, AlwaysTaken, BackwardTaken,
  OneBitPredictor, TwoBitPredictor, GSharePredictor, TournamentPredictor,
  PredictorBenchmark
};
