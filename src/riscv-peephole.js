// riscv-peephole.js — Peephole optimizer for RISC-V assembly
//
// Runs as a post-pass on assembly text, applying pattern-based
// optimizations to reduce instruction count and cycle count.

/**
 * Apply peephole optimizations to RISC-V assembly text.
 * @param {string} asm - Assembly text
 * @returns {{ optimized: string, stats: { removed: number, patterns: Record<string, number> } }}
 */
export function peepholeOptimize(asm) {
  let lines = asm.split('\n');
  const stats = { removed: 0, patterns: {} };
  
  function incStat(pattern) {
    stats.patterns[pattern] = (stats.patterns[pattern] || 0) + 1;
    stats.removed++;
  }

  // Multiple passes until no more changes
  let changed = true;
  let passes = 0;
  while (changed && passes < 10) {
    changed = false;
    passes++;
    const newLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const next = i + 1 < lines.length ? lines[i + 1]?.trim() : '';
      const next2 = i + 2 < lines.length ? lines[i + 2]?.trim() : '';
      const next3 = i + 3 < lines.length ? lines[i + 3]?.trim() : '';

      // Pattern 1: Remove "mv rX, rX" (self-move)
      const mvMatch = trimmed.match(/^mv\s+(\w+),\s*(\w+)$/);
      if (mvMatch && mvMatch[1] === mvMatch[2]) {
        incStat('self-move');
        changed = true;
        continue; // Skip this line
      }

      // Pattern 2: Remove dead push/pop (sw + lw same reg, no intervening use)
      // Pattern: addi sp, sp, -4; sw rX, 0(sp); lw rY, 0(sp); addi sp, sp, 4
      // Where nothing between sw and lw uses the stack
      if (trimmed === 'addi sp, sp, -4' && 
          next.match(/^sw\s+(\w+),\s*0\(sp\)$/) &&
          next2.match(/^lw\s+(\w+),\s*0\(sp\)$/) &&
          next3 === 'addi sp, sp, 4') {
        const swReg = next.match(/^sw\s+(\w+)/)[1];
        const lwReg = next2.match(/^lw\s+(\w+)/)[1];
        // Replace with: mv lwReg, swReg (or nothing if same reg)
        if (swReg === lwReg) {
          // Complete no-op: push and pop same register
          incStat('push-pop-same');
          changed = true;
          i += 3; // Skip all 4 instructions
          continue;
        } else {
          // Replace with mv
          newLines.push(`  mv ${lwReg}, ${swReg}`);
          incStat('push-pop-mv');
          changed = true;
          i += 3;
          continue;
        }
      }

      // Pattern 3: Store then immediately load same location → keep store, skip load  
      // sw rX, offset(base); lw rY, offset(base) → sw rX, offset(base); mv rY, rX
      const swMatch = trimmed.match(/^sw\s+(\w+),\s*(-?\d+\(\w+\))$/);
      if (swMatch) {
        const lwMatch2 = next.match(/^lw\s+(\w+),\s*(-?\d+\(\w+\))$/);
        if (lwMatch2 && swMatch[2] === lwMatch2[2]) {
          // Store then load same address
          newLines.push(line); // Keep the store
          if (swMatch[1] !== lwMatch2[1]) {
            newLines.push(`  mv ${lwMatch2[1]}, ${swMatch[1]}`);
          }
          // Skip the load
          incStat('store-load-elim');
          changed = true;
          i++; // Skip next line
          continue;
        }
      }

      // Pattern 4: Consecutive addi to sp → merge
      const addiSpMatch = trimmed.match(/^addi\s+sp,\s*sp,\s*(-?\d+)$/);
      if (addiSpMatch) {
        const nextAddiMatch = next.match(/^addi\s+sp,\s*sp,\s*(-?\d+)$/);
        if (nextAddiMatch) {
          const combined = parseInt(addiSpMatch[1]) + parseInt(nextAddiMatch[1]);
          if (combined !== 0) {
            newLines.push(`  addi sp, sp, ${combined}`);
          }
          incStat('merge-addi-sp');
          changed = true;
          i++; // Skip next
          continue;
        }
      }

      // Pattern 5: li followed by mv to same reg → just li to target
      // li a0, X; mv t0, a0 → li t0, X (if a0 not used after)
      // This is harder to prove safe, skip for now

      // No pattern matched — keep the line
      newLines.push(line);
    }

    lines = newLines;
  }

  return {
    optimized: lines.join('\n'),
    stats: { ...stats, passes }
  };
}
