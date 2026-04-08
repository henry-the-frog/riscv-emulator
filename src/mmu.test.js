'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Memory } = require('./memory');
const {
  PageTableEntry, TLB, MMU,
  setupIdentityPageTable,
  PTE_V, PTE_R, PTE_W, PTE_X, PTE_A, PTE_D,
  PAGE_SIZE
} = require('./mmu');

// ============================================================
// Page Table Entry Tests
// ============================================================

test('PTE: flag parsing', () => {
  const pte = PageTableEntry.create(0x12345, PTE_V | PTE_R | PTE_W | PTE_X);
  assert.ok(pte.valid);
  assert.ok(pte.readable);
  assert.ok(pte.writable);
  assert.ok(pte.executable);
  assert.ok(!pte.user);
  assert.ok(!pte.dirty);
  assert.ok(pte.isLeaf);
  assert.equal(pte.ppn, 0x12345);
});

test('PTE: non-leaf (pointer)', () => {
  const pte = PageTableEntry.create(0x100, PTE_V); // V but no R/W/X
  assert.ok(pte.valid);
  assert.ok(!pte.isLeaf);
});

test('PTE: set accessed/dirty', () => {
  const pte = PageTableEntry.create(0x100, PTE_V | PTE_R | PTE_W);
  assert.ok(!pte.accessed);
  assert.ok(!pte.dirty);
  pte.setAccessed();
  assert.ok(pte.accessed);
  pte.setDirty();
  assert.ok(pte.dirty);
});

// ============================================================
// TLB Tests
// ============================================================

test('TLB: lookup miss on empty', () => {
  const tlb = new TLB(4);
  assert.equal(tlb.lookup(0x100), null);
  assert.equal(tlb.misses, 1);
});

test('TLB: insert and hit', () => {
  const tlb = new TLB(4);
  tlb.insert(0x100, 0x200, PTE_V | PTE_R);
  const entry = tlb.lookup(0x100);
  assert.ok(entry);
  assert.equal(entry.ppn, 0x200);
  assert.equal(tlb.hits, 1);
});

test('TLB: LRU eviction', () => {
  const tlb = new TLB(3);
  tlb.insert(0x1, 0x10, 0);
  tlb.insert(0x2, 0x20, 0);
  tlb.insert(0x3, 0x30, 0);
  
  // Access 0x1 and 0x3 to make 0x2 LRU
  tlb.lookup(0x1);
  tlb.lookup(0x3);
  
  // Insert new — should evict 0x2
  tlb.insert(0x4, 0x40, 0);
  assert.equal(tlb.lookup(0x2), null); // Evicted
  assert.ok(tlb.lookup(0x1)); // Still present
});

test('TLB: flush', () => {
  const tlb = new TLB(4);
  tlb.insert(0x1, 0x10, 0);
  tlb.insert(0x2, 0x20, 0);
  tlb.flush();
  assert.equal(tlb.lookup(0x1), null);
  assert.equal(tlb.entries.length, 0);
});

test('TLB: flushVPN', () => {
  const tlb = new TLB(4);
  tlb.insert(0x1, 0x10, 0);
  tlb.insert(0x2, 0x20, 0);
  tlb.flushVPN(0x1);
  assert.equal(tlb.lookup(0x1), null);
  assert.ok(tlb.lookup(0x2));
});

test('TLB: stats', () => {
  const tlb = new TLB(4);
  tlb.insert(0x1, 0x10, 0);
  tlb.lookup(0x1); // Hit
  tlb.lookup(0x2); // Miss
  const stats = tlb.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, '50.0%');
});

// ============================================================
// MMU Tests
// ============================================================

test('MMU: disabled = identity mapping', () => {
  const mem = new Memory(1024 * 1024);
  const mmu = new MMU(mem);
  assert.equal(mmu.translate(0x12345), 0x12345);
});

test('MMU: basic translation with identity page table', () => {
  const mem = new Memory(4 * 1024 * 1024); // 4MB
  const mmu = new MMU(mem);
  
  // Set up identity mapping for 256 pages (1MB)
  const ptBase = 2 * 1024 * 1024; // Put page table at 2MB
  setupIdentityPageTable(mem, ptBase, 256);
  
  mmu.enable(ptBase);
  
  // Translate — should map to same address (identity)
  const paddr = mmu.translate(0x1000, 'R');
  assert.equal(paddr, 0x1000);
});

test('MMU: TLB caching', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256);
  mmu.enable(ptBase);
  
  // First access: TLB miss, page walk
  mmu.translate(0x1000, 'R');
  assert.equal(mmu.pageWalks, 1);
  assert.equal(mmu.tlb.misses, 1);
  
  // Second access to same page: TLB hit
  mmu.translate(0x1004, 'R');
  assert.equal(mmu.pageWalks, 1); // No new walk
  assert.equal(mmu.tlb.hits, 1);
});

test('MMU: different pages cause different walks', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256);
  mmu.enable(ptBase);
  
  mmu.translate(0x1000, 'R'); // Page 1
  mmu.translate(0x2000, 'R'); // Page 2
  assert.equal(mmu.pageWalks, 2);
});

test('MMU: write permission check', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  
  // Set up read-only mapping
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256, PTE_V | PTE_R); // No W
  mmu.enable(ptBase);
  
  // Read should work
  mmu.translate(0x1000, 'R');
  
  // Write should fault
  assert.throws(() => mmu.translate(0x1000, 'W'), /write permission denied/);
});

test('MMU: execute permission check', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256, PTE_V | PTE_R | PTE_W); // No X
  mmu.enable(ptBase);
  
  assert.throws(() => mmu.translate(0x1000, 'X'), /execute permission denied/);
});

test('MMU: invalid page fault', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  // Map only 4 pages
  setupIdentityPageTable(mem, ptBase, 4);
  mmu.enable(ptBase);
  
  // Page 0-3 should work
  mmu.translate(0x0000, 'R');
  
  // Page 1024 (beyond mapped range) — L0 PTE will be invalid
  assert.throws(() => mmu.translate(0x400000, 'R'), /Page fault/);
});

test('MMU: accessed flag set on read', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256);
  mmu.enable(ptBase);
  
  // Before access: A flag not set
  mmu.translate(0x1000, 'R');
  
  // Check L0 PTE has A flag
  // L0 table is at ptBase + PAGE_SIZE
  const vpn0 = (0x1000 >>> 12) & 0x3FF;
  const l0Addr = ptBase + PAGE_SIZE + vpn0 * 4;
  const pteVal = mem.loadWord(l0Addr);
  assert.ok(pteVal & PTE_A, 'Accessed flag should be set');
});

test('MMU: dirty flag set on write', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256);
  mmu.enable(ptBase);
  
  mmu.translate(0x1000, 'W');
  
  const vpn0 = (0x1000 >>> 12) & 0x3FF;
  const l0Addr = ptBase + PAGE_SIZE + vpn0 * 4;
  const pteVal = mem.loadWord(l0Addr);
  assert.ok(pteVal & PTE_D, 'Dirty flag should be set');
  assert.ok(pteVal & PTE_A, 'Accessed flag should also be set');
});

test('MMU: stats tracking', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 256);
  mmu.enable(ptBase);
  
  mmu.translate(0x1000, 'R');
  mmu.translate(0x1004, 'R'); // Same page, TLB hit
  mmu.translate(0x2000, 'R'); // Different page
  
  const stats = mmu.getStats();
  assert.equal(stats.translations, 3);
  assert.equal(stats.pageWalks, 2);
  assert.ok(stats.tlb.hits > 0);
});

test('MMU: custom page fault handler', () => {
  const mem = new Memory(4 * 1024 * 1024);
  const mmu = new MMU(mem);
  const ptBase = 2 * 1024 * 1024;
  setupIdentityPageTable(mem, ptBase, 4); // Only 4 pages
  mmu.enable(ptBase);
  
  let faultAddr = null;
  mmu.onPageFault = (vaddr, reason) => {
    faultAddr = vaddr;
    // "Allocate" a page on demand — return identity mapping
    return PageTableEntry.create(vaddr >>> 12, PTE_V | PTE_R | PTE_W | PTE_X);
  };
  
  // Access unmapped page — should trigger handler, not throw
  const paddr = mmu.translate(0x100000, 'R');
  assert.equal(faultAddr, 0x100000);
  assert.equal(paddr, 0x100000); // Identity mapped by handler
  assert.equal(mmu.pageFaults, 1);
});
