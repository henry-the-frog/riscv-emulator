/**
 * RISC-V Register File — 32 registers (x0-x31)
 * x0 is hardwired to 0 (writes are discarded)
 * 
 * ABI names: zero, ra, sp, gp, tp, t0-t6, s0-s11, a0-a7
 */

const REG_NAMES = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'
];

// Reverse mapping
const REG_NUMBERS = {};
REG_NAMES.forEach((name, i) => { REG_NUMBERS[name] = i; });
// fp is alias for s0
REG_NUMBERS['fp'] = 8;
// x0..x31 numeric aliases
for (let i = 0; i < 32; i++) REG_NUMBERS[`x${i}`] = i;

class Registers {
  constructor() {
    // Use Int32Array for signed 32-bit values (RISC-V is 32-bit)
    this.x = new Int32Array(32);
    this.pc = 0;
  }

  get(reg) {
    if (reg === 0) return 0; // x0 always 0
    return this.x[reg];
  }

  getU(reg) {
    // Unsigned interpretation
    return this.get(reg) >>> 0;
  }

  set(reg, val) {
    if (reg === 0) return; // x0 writes ignored
    this.x[reg] = val | 0; // truncate to 32-bit signed
  }

  dump() {
    const lines = [];
    for (let i = 0; i < 32; i += 4) {
      const cols = [];
      for (let j = i; j < i + 4; j++) {
        const name = REG_NAMES[j].padEnd(4);
        const val = (this.x[j] >>> 0).toString(16).padStart(8, '0');
        cols.push(`x${j.toString().padStart(2,'0')}(${name})=0x${val}`);
      }
      lines.push(cols.join('  '));
    }
    lines.push(`pc=0x${(this.pc >>> 0).toString(16).padStart(8, '0')}`);
    return lines.join('\n');
  }

  reset() {
    this.x.fill(0);
    this.pc = 0;
  }
}

export { Registers, REG_NAMES, REG_NUMBERS };
