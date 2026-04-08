'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Assembler } = require('./assembler');
const { CPU } = require('./cpu');

// Helper: assemble and run
function asmRun(source, maxCycles = 10000) {
  const asm = new Assembler();
  const { words, labels, errors } = asm.assemble(source);
  if (errors.length > 0) throw new Error(`Assembly errors: ${errors.map(e => `L${e.line}: ${e.message}`).join(', ')}`);
  const cpu = new CPU(131072);
  cpu.loadProgram(words);
  // Set stack pointer to top of memory
  cpu.regs.set(2, 131072 - 4); // sp
  cpu.run(maxCycles);
  return { cpu, labels };
}

// ============================================================
// Assembler Parse Tests
// ============================================================

test('Assembler: parse line with label', () => {
  const p = Assembler.parseLine('loop: addi x1, x0, 5');
  assert.equal(p.label, 'loop');
  assert.equal(p.mnemonic, 'addi');
  assert.deepEqual(p.args, ['x1', 'x0', '5']);
});

test('Assembler: parse line with comment', () => {
  const p = Assembler.parseLine('addi x1, x0, 42 # load 42');
  assert.equal(p.mnemonic, 'addi');
  assert.deepEqual(p.args, ['x1', 'x0', '42']);
});

test('Assembler: parse empty and comment lines', () => {
  assert.equal(Assembler.parseLine(''), null);
  assert.equal(Assembler.parseLine('# comment'), null);
  assert.equal(Assembler.parseLine('   '), null);
});

test('Assembler: parse memory operand', () => {
  const m = Assembler.parseMemOp('16(sp)');
  assert.equal(m.offsetStr, '16');
  assert.equal(m.regStr, 'sp');
});

// ============================================================
// Simple Assembly Tests
// ============================================================

test('Assembler: ADDI', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 42
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 42);
});

test('Assembler: ADD', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 10
    addi t1, zero, 20
    add t2, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(7), 30); // t2 = x7
});

test('Assembler: SUB', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 100
    addi t1, zero, 37
    sub t2, t0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(7), 63);
});

test('Assembler: LUI + ADDI for large constant', () => {
  const { cpu } = asmRun(`
    lui a0, 0x12345000
    addi a0, a0, 0x678
    ebreak
  `);
  assert.equal(cpu.regs.getU(10), 0x12345678);
});

test('Assembler: li pseudo-instruction (small)', () => {
  const { cpu } = asmRun(`
    li a0, 42
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 42);
});

test('Assembler: li pseudo-instruction (large)', () => {
  const { cpu } = asmRun(`
    li a0, 0x12345678
    ebreak
  `);
  assert.equal(cpu.regs.getU(10), 0x12345678);
});

test('Assembler: mv pseudo', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 99
    mv a1, a0
    ebreak
  `);
  assert.equal(cpu.regs.get(11), 99);
});

test('Assembler: nop pseudo', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 42
    nop
    nop
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 42);
  assert.equal(cpu.cycles, 4); // 3 instructions + ebreak
});

// ============================================================
// Branch + Label Tests
// ============================================================

test('Assembler: BEQ with label', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 5
    addi t1, zero, 5
    beq t0, t1, skip
    addi a0, zero, 99
  skip:
    addi a1, zero, 42
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 0);  // skipped
  assert.equal(cpu.regs.get(11), 42);
});

test('Assembler: BNE loop', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 0
    addi t1, zero, 5
  loop:
    addi t0, t0, 1
    bne t0, t1, loop
    mv a0, t0
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 5);
});

test('Assembler: BEQZ/BNEZ pseudo', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 0
    beqz t0, zero_branch
    addi a0, zero, 99
  zero_branch:
    addi a0, zero, 1
    addi t1, zero, 5
    bnez t1, nonzero_branch
    addi a1, zero, 99
  nonzero_branch:
    addi a1, zero, 2
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 1);
  assert.equal(cpu.regs.get(11), 2);
});

// ============================================================
// Jump + Function Call Tests
// ============================================================

test('Assembler: JAL function call', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 7
    jal ra, double
    ebreak
  double:
    add a0, a0, a0
    jalr zero, ra, 0
  `);
  assert.equal(cpu.regs.get(10), 14);
});

test('Assembler: ret pseudo', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 3
    jal ra, triple
    ebreak
  triple:
    add t0, a0, a0
    add a0, t0, a0
    ret
  `);
  assert.equal(cpu.regs.get(10), 9);
});

// ============================================================
// Load/Store Tests
// ============================================================

test('Assembler: SW + LW', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 123
    sw t0, 0(sp)
    lw a0, 0(sp)
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 123);
});

test('Assembler: SB + LB', () => {
  const { cpu } = asmRun(`
    addi t0, zero, -5
    sb t0, 0(sp)
    lb a0, 0(sp)
    lbu a1, 0(sp)
    ebreak
  `);
  assert.equal(cpu.regs.get(10), -5);
  assert.equal(cpu.regs.get(11), 251); // unsigned byte of -5
});

// ============================================================
// ECALL Tests
// ============================================================

test('Assembler: print_int syscall', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 42
    addi a7, zero, 1
    ecall
    ebreak
  `);
  assert.equal(cpu.output.join(''), '42');
});

test('Assembler: exit syscall', () => {
  const { cpu } = asmRun(`
    addi a7, zero, 10
    ecall
    addi a0, zero, 99
  `);
  assert.ok(cpu.halted);
  assert.equal(cpu.regs.get(10), 0); // a0 wasn't set to 99
});

// ============================================================
// Integration: Algorithms
// ============================================================

test('Assembler: sum 1 to 10', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 1    # counter
    addi t1, zero, 0    # sum
    addi t2, zero, 11   # limit
  loop:
    add t1, t1, t0      # sum += counter
    addi t0, t0, 1      # counter++
    bne t0, t2, loop    # while counter != 11
    mv a0, t1
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 55);
});

test('Assembler: factorial (iterative)', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 1    # result = 1
    addi t1, zero, 1    # i = 1
    addi t2, zero, 8    # n+1 = 8 (compute 7!)
  loop:
    # result *= i — use manual multiplication (repeated addition)
    addi t3, zero, 0    # t3 = 0 (accumulator)
    mv t4, t0           # t4 = result (multiplier)
  mul_loop:
    beqz t4, mul_done
    add t3, t3, t1      # t3 += i
    addi t4, t4, -1
    j mul_loop
  mul_done:
    mv t0, t3           # result = t3
    addi t1, t1, 1      # i++
    bne t1, t2, loop
    mv a0, t0
    ebreak
  `, 100000);
  assert.equal(cpu.regs.get(10), 5040, `halted=${cpu.halted} cycles=${cpu.cycles}`); // 7!
});

test('Assembler: fibonacci(10)', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 0    # fib(0) = 0
    addi t1, zero, 1    # fib(1) = 1
    addi t2, zero, 10   # n = 10
    addi t3, zero, 0    # counter
  loop:
    beq t3, t2, done
    add t4, t0, t1      # next = a + b
    mv t0, t1           # a = b
    mv t1, t4           # b = next
    addi t3, t3, 1
    j loop
  done:
    mv a0, t0
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 55); // fib(10)
});

test('Assembler: recursive fibonacci', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 10   # n = 10
    jal ra, fib
    ebreak

  fib:
    # base case: if n <= 1, return n
    addi t0, zero, 2
    blt a0, t0, fib_base
    
    # save ra, n on stack
    addi sp, sp, -12
    sw ra, 8(sp)
    sw a0, 4(sp)
    
    # fib(n-1)
    addi a0, a0, -1
    jal ra, fib
    sw a0, 0(sp)         # save fib(n-1)
    
    # fib(n-2)
    lw a0, 4(sp)
    addi a0, a0, -2
    jal ra, fib
    
    # result = fib(n-1) + fib(n-2)
    lw t0, 0(sp)
    add a0, a0, t0
    
    # restore
    lw ra, 8(sp)
    addi sp, sp, 12
    ret

  fib_base:
    ret
  `);
  assert.equal(cpu.regs.get(10), 55);
});

test('Assembler: bubble sort', () => {
  const { cpu } = asmRun(`
    # Store array [5, 3, 8, 1, 4] at address 0x1000
    li t0, 0x1000
    addi t1, zero, 5
    sw t1, 0(t0)
    addi t1, zero, 3
    sw t1, 4(t0)
    addi t1, zero, 8
    sw t1, 8(t0)
    addi t1, zero, 1
    sw t1, 12(t0)
    addi t1, zero, 4
    sw t1, 16(t0)
    
    # Bubble sort: n=5
    addi s0, zero, 5     # n
    li s1, 0x1000         # base

  outer:
    addi s0, s0, -1       # n--
    beqz s0, sorted
    addi t0, zero, 0      # i = 0
    
  inner:
    beq t0, s0, outer
    # load arr[i] and arr[i+1]
    slli t1, t0, 2        # t1 = i * 4
    add t1, s1, t1        # t1 = &arr[i]
    lw t2, 0(t1)          # t2 = arr[i]
    lw t3, 4(t1)          # t3 = arr[i+1]
    blt t2, t3, no_swap   # if arr[i] < arr[i+1], no swap
    # swap
    sw t3, 0(t1)
    sw t2, 4(t1)
  no_swap:
    addi t0, t0, 1
    j inner
    
  sorted:
    # Read sorted array into a0-a4
    li t0, 0x1000
    lw a0, 0(t0)
    lw a1, 4(t0)
    lw a2, 8(t0)
    lw a3, 12(t0)
    lw a4, 16(t0)
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 1);
  assert.equal(cpu.regs.get(11), 3);
  assert.equal(cpu.regs.get(12), 4);
  assert.equal(cpu.regs.get(13), 5);
  assert.equal(cpu.regs.get(14), 8);
});

test('Assembler: GCD (Euclidean algorithm)', () => {
  const { cpu } = asmRun(`
    addi a0, zero, 48
    addi a1, zero, 36
    jal ra, gcd
    ebreak
    
  gcd:
    beqz a1, gcd_done
    # t0 = a0 % a1 (via repeated subtraction)
    mv t0, a0
  mod_loop:
    blt t0, a1, mod_done
    sub t0, t0, a1
    j mod_loop
  mod_done:
    mv a0, a1
    mv a1, t0
    j gcd
  gcd_done:
    ret
  `);
  assert.equal(cpu.regs.get(10), 12); // gcd(48, 36) = 12
});

test('Assembler: stack operations (push/pop)', () => {
  const { cpu } = asmRun(`
    # Push 10, 20, 30 onto stack
    addi t0, zero, 10
    addi sp, sp, -4
    sw t0, 0(sp)
    addi t0, zero, 20
    addi sp, sp, -4
    sw t0, 0(sp)
    addi t0, zero, 30
    addi sp, sp, -4
    sw t0, 0(sp)
    
    # Pop in reverse order
    lw a0, 0(sp)
    addi sp, sp, 4
    lw a1, 0(sp)
    addi sp, sp, 4
    lw a2, 0(sp)
    addi sp, sp, 4
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 30); // LIFO
  assert.equal(cpu.regs.get(11), 20);
  assert.equal(cpu.regs.get(12), 10);
});

test('Assembler: logical operations', () => {
  const { cpu } = asmRun(`
    addi t0, zero, 0xFF
    andi a0, t0, 0x0F    # a0 = 0x0F
    ori a1, t0, 0x100    # a1 = 0x1FF
    xori a2, t0, 0xFF    # a2 = 0
    slli a3, t0, 4       # a3 = 0xFF0
    srli a4, t0, 4       # a4 = 0x0F
    ebreak
  `);
  assert.equal(cpu.regs.get(10), 0x0F);
  assert.equal(cpu.regs.get(11), 0x1FF);
  assert.equal(cpu.regs.get(12), 0);
  assert.equal(cpu.regs.get(13), 0xFF0);
  assert.equal(cpu.regs.get(14), 0x0F);
});

test('Assembler: label resolution', () => {
  const asm = new Assembler();
  const { labels } = asm.assemble(`
  start:
    addi x1, x0, 1
    addi x2, x0, 2
  middle:
    addi x3, x0, 3
  end:
    ebreak
  `);
  assert.equal(labels.start, 0);
  assert.equal(labels.middle, 8);
  assert.equal(labels.end, 12);
});
