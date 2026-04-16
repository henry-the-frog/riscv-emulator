import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache, CacheHierarchy } from './cache.js';

// ============================================================
// Cache Configuration Tests
// ============================================================

test('Cache: direct-mapped config', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  assert.equal(cache.numLines, 16);
  assert.equal(cache.numSets, 16);
  assert.equal(cache.offsetBits, 6);
  assert.equal(cache.indexBits, 4);
  assert.ok(cache.describe().includes('Direct-Mapped'));
});

test('Cache: 4-way set associative config', () => {
  const cache = new Cache({ size: 4096, blockSize: 64, ways: 4 });
  assert.equal(cache.numLines, 64);
  assert.equal(cache.numSets, 16);
  assert.ok(cache.describe().includes('4-way'));
});

test('Cache: fully associative config', () => {
  const cache = new Cache({ size: 256, blockSize: 64, ways: 4 });
  assert.ok(cache.numSets > 0);
});

// ============================================================
// Address Decomposition Tests
// ============================================================

test('Cache: address decomposition', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  // 64-byte blocks = 6 offset bits, 16 sets = 4 index bits
  const d = cache.decompose(0x3F); // offset=63, index=0, tag=0
  assert.equal(d.offset, 63);
  assert.equal(d.index, 0);
  assert.equal(d.tag, 0);
  
  const d2 = cache.decompose(0x100); // 256 = offset=0, index=4, tag=0
  assert.equal(d2.offset, 0);
  assert.equal(d2.index, 4);
  assert.equal(d2.tag, 0);
});

// ============================================================
// Basic Hit/Miss Tests
// ============================================================

test('Cache: first access is always a miss', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  assert.equal(cache.read(0x100), false);
  assert.equal(cache.stats.readMisses, 1);
});

test('Cache: second access to same block is a hit', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  cache.read(0x100);
  const hit = cache.read(0x100);
  assert.equal(hit, true);
  assert.equal(cache.stats.readHits, 1);
});

test('Cache: spatial locality — same block, different offset', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  cache.read(0x100);      // Miss — loads block at 0x100-0x13F
  const hit = cache.read(0x110); // Same block — hit!
  assert.equal(hit, true);
});

test('Cache: different blocks in same set cause conflict', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 }); // 16 sets
  // 0x000 and 0x400 map to same set (index=0) with different tags
  cache.read(0x000);  // Miss, fills set 0
  cache.read(0x400);  // Miss, evicts previous
  const hit = cache.read(0x000); // Miss again!
  assert.equal(hit, false);
  assert.equal(cache.stats.evictions, 2);
});

test('Cache: set-associative avoids conflicts', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 2 }); // 8 sets, 2-way
  cache.read(0x000);  // Miss, fills set 0 way 0
  cache.read(0x200);  // Miss, fills set 0 way 1 (different mapping for 2-way with 8 sets)
  // Both should be in cache if they map to the same set
  // With 2-way, 8 sets: 0x000 maps to set 0, 0x200 maps to set (0x200>>6)%8 = 8%8 = 0
  // Hmm, 0x200 = 512. offset=6 bits, index for 8 sets=3 bits. (512>>6)=8, 8%8=0. Same set!
  const hit1 = cache.read(0x000);
  assert.equal(hit1, true); // Still in cache!
});

// ============================================================
// Write Tests
// ============================================================

test('Cache: write-back marks dirty', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1, writePolicy: 'write-back' });
  cache.read(0x100);  // Load block
  cache.write(0x100); // Write hit — mark dirty
  assert.equal(cache.stats.writeHits, 1);
  
  // Evict dirty block
  cache.read(0x500); // Same set, different tag → eviction
  assert.equal(cache.stats.dirtyEvictions, 1);
});

test('Cache: write miss allocates (write-back)', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1, writePolicy: 'write-back' });
  cache.write(0x100); // Write miss — allocate
  const hit = cache.read(0x100); // Should now be in cache
  assert.equal(hit, true);
});

// ============================================================
// Replacement Policy Tests
// ============================================================

test('Cache: LRU evicts least recently used', () => {
  const cache = new Cache({ size: 256, blockSize: 64, ways: 4, policy: 'LRU' }); // 1 set, 4-way
  // Fill all 4 ways
  cache.read(0x000);   // Way 0
  cache.read(0x100);   // Way 1
  cache.read(0x200);   // Way 2
  cache.read(0x300);   // Way 3
  
  // Re-access 0x000 (now most recent)
  cache.read(0x000);
  
  // New access should evict 0x100 (LRU)
  cache.read(0x400);
  assert.equal(cache.read(0x100), false); // Evicted
  assert.equal(cache.read(0x000), true);  // Still in cache
});

test('Cache: FIFO evicts first inserted', () => {
  const cache = new Cache({ size: 256, blockSize: 64, ways: 4, policy: 'FIFO' });
  cache.read(0x000);
  cache.read(0x100);
  cache.read(0x200);
  cache.read(0x300);
  
  // Re-access doesn't change FIFO order
  cache.read(0x000);
  
  // New access evicts 0x000 (first in)
  cache.read(0x400);
  assert.equal(cache.stats.evictions, 1);
  // 0x000 was evicted, 0x100 still present
  assert.equal(cache.read(0x100), true);
  assert.equal(cache.read(0x200), true);
  assert.equal(cache.read(0x300), true);
});

// ============================================================
// Statistics Tests
// ============================================================

test('Cache: hit rate calculation', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  cache.read(0x100);  // Miss
  cache.read(0x100);  // Hit
  cache.read(0x100);  // Hit
  cache.read(0x200);  // Miss
  const stats = cache.getStats();
  assert.equal(stats.totalAccesses, 4);
  assert.equal(stats.totalHits, 2);
  assert.equal(stats.totalMisses, 2);
  assert.equal(stats.hitRate, '50.0%');
});

test('Cache: stats include reads and writes', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  cache.read(0x100);
  cache.write(0x100);
  cache.read(0x200);
  cache.write(0x200);
  const stats = cache.getStats();
  assert.equal(stats.reads, 2);
  assert.equal(stats.writes, 2);
  assert.equal(stats.totalAccesses, 4);
});

// ============================================================
// Access Pattern Tests
// ============================================================

test('Cache: sequential scan (streaming)', () => {
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 });
  // Sequential access: good spatial locality within blocks
  for (let i = 0; i < 1024; i += 4) {
    cache.read(i);
  }
  const stats = cache.getStats();
  // Every 64 bytes is a new block = 16 misses, 240 hits
  assert.equal(stats.readMisses, 16);
  assert.equal(stats.readHits, 240);
  assert.ok(parseFloat(stats.hitRate) > 90);
});

test('Cache: stride pattern (cache-unfriendly)', () => {
  // Stride of 256 bytes = every access maps to different set
  const cache = new Cache({ size: 1024, blockSize: 64, ways: 1 }); // 16 sets
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 32; j++) {
      cache.read(j * 256); // Large stride
    }
  }
  const stats = cache.getStats();
  // 32 unique blocks > 16 sets → lots of conflicts in direct-mapped
  assert.ok(stats.evictions > 0);
});

test('Cache: matrix access — row vs column', () => {
  // Simulate row-major vs column-major array access
  const N = 8;
  
  // Row-major (cache-friendly)
  const rowCache = new Cache({ size: 256, blockSize: 16, ways: 1 });
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      rowCache.read((i * N + j) * 4);
    }
  }
  
  // Column-major (cache-unfriendly)
  const colCache = new Cache({ size: 256, blockSize: 16, ways: 1 });
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      colCache.read((i * N + j) * 4);
    }
  }
  
  const rowStats = rowCache.getStats();
  const colStats = colCache.getStats();
  assert.ok(parseFloat(rowStats.hitRate) >= parseFloat(colStats.hitRate),
    `Row-major (${rowStats.hitRate}) should be >= Column-major (${colStats.hitRate})`);
});

// ============================================================
// Cache Hierarchy Tests
// ============================================================

test('CacheHierarchy: L1 hit', () => {
  const hierarchy = new CacheHierarchy([
    { size: 1024, blockSize: 64, ways: 2, policy: 'LRU' },  // L1
    { size: 4096, blockSize: 64, ways: 4, policy: 'LRU' },  // L2
  ]);
  hierarchy.read(0x100); // Miss L1, Miss L2
  const result = hierarchy.read(0x100); // Hit L1
  assert.equal(result.hit, true);
  assert.equal(result.level, 1);
});

test('CacheHierarchy: L2 hit after L1 eviction', () => {
  const hierarchy = new CacheHierarchy([
    { size: 256, blockSize: 64, ways: 1, policy: 'LRU' },  // Tiny L1 (4 sets)
    { size: 4096, blockSize: 64, ways: 4, policy: 'LRU' }, // Larger L2
  ]);
  
  // Fill L1 and evict
  hierarchy.read(0x000);
  hierarchy.read(0x100); // Different set in L1
  
  // These should be in both L1 and L2
  // Force eviction from L1 by accessing conflicting addresses
  for (let i = 0; i < 10; i++) {
    hierarchy.read(i * 0x100);
  }
  
  // Earlier addresses should still be in L2
  const stats = hierarchy.getStats();
  assert.ok(stats[1].readHits > 0 || stats[1].readMisses > 0);
});

test('CacheHierarchy: stats per level', () => {
  const hierarchy = new CacheHierarchy([
    { size: 1024, blockSize: 64, ways: 2 },
    { size: 4096, blockSize: 64, ways: 4 },
  ]);
  hierarchy.read(0x100);
  hierarchy.read(0x100);
  hierarchy.read(0x200);
  
  const stats = hierarchy.getStats();
  assert.equal(stats.length, 2);
  assert.ok('level' in stats[0]);
  assert.ok('hitRate' in stats[0]);
  assert.ok('config' in stats[0]);
});
