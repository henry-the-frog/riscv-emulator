'use strict';

/**
 * Cache Simulator for RISC-V
 * 
 * Models CPU cache behavior with configurable:
 * - Cache size (total bytes)
 * - Block/line size (bytes per cache line)
 * - Associativity (1 = direct-mapped, N = N-way, numSets = fully assoc)
 * - Replacement policy (LRU, FIFO, Random)
 * - Write policy (write-back, write-through)
 * 
 * Address decomposition:
 *   [Tag | Set Index | Block Offset]
 *   - Block offset: log2(blockSize) bits
 *   - Set index: log2(numSets) bits
 *   - Tag: remaining bits
 */

class CacheLine {
  constructor() {
    this.valid = false;
    this.dirty = false;
    this.tag = 0;
    this.lastAccess = 0;   // For LRU
    this.insertOrder = 0;  // For FIFO
  }
}

class CacheSet {
  constructor(ways) {
    this.ways = ways;
    this.lines = Array.from({ length: ways }, () => new CacheLine());
  }

  // Find a line with matching tag
  find(tag) {
    for (let i = 0; i < this.ways; i++) {
      if (this.lines[i].valid && this.lines[i].tag === tag) {
        return i;
      }
    }
    return -1;
  }

  // Find an empty line
  findEmpty() {
    for (let i = 0; i < this.ways; i++) {
      if (!this.lines[i].valid) return i;
    }
    return -1;
  }

  // Find victim based on replacement policy
  findVictim(policy) {
    switch (policy) {
      case 'LRU': {
        let oldest = Infinity;
        let victim = 0;
        for (let i = 0; i < this.ways; i++) {
          if (this.lines[i].lastAccess < oldest) {
            oldest = this.lines[i].lastAccess;
            victim = i;
          }
        }
        return victim;
      }
      case 'FIFO': {
        let earliest = Infinity;
        let victim = 0;
        for (let i = 0; i < this.ways; i++) {
          if (this.lines[i].insertOrder < earliest) {
            earliest = this.lines[i].insertOrder;
            victim = i;
          }
        }
        return victim;
      }
      case 'Random':
        return Math.floor(Math.random() * this.ways);
      default:
        return 0;
    }
  }
}

class Cache {
  constructor(opts = {}) {
    this.totalSize = opts.size || 4096;       // Total cache size in bytes
    this.blockSize = opts.blockSize || 64;    // Cache line size
    this.ways = opts.ways || 1;              // Associativity (1=direct-mapped)
    this.policy = opts.policy || 'LRU';       // Replacement policy
    this.writePolicy = opts.writePolicy || 'write-back';

    // Derived parameters
    this.numLines = this.totalSize / this.blockSize;
    this.numSets = this.numLines / this.ways;

    // Bit widths
    this.offsetBits = Math.log2(this.blockSize);
    this.indexBits = Math.log2(this.numSets);
    this.tagBits = 32 - this.offsetBits - this.indexBits;

    // Masks
    this.offsetMask = (1 << this.offsetBits) - 1;
    this.indexMask = ((1 << this.indexBits) - 1) << this.offsetBits;

    // Cache storage
    this.sets = Array.from({ length: this.numSets }, () => new CacheSet(this.ways));

    // Statistics
    this.stats = {
      reads: 0,
      writes: 0,
      readHits: 0,
      readMisses: 0,
      writeHits: 0,
      writeMisses: 0,
      evictions: 0,
      dirtyEvictions: 0,
    };

    this.accessCounter = 0;
    this.insertCounter = 0;
  }

  // Decompose address
  decompose(addr) {
    addr = addr >>> 0;
    const offset = addr & this.offsetMask;
    const index = (addr >>> this.offsetBits) & ((1 << this.indexBits) - 1);
    const tag = addr >>> (this.offsetBits + this.indexBits);
    return { tag, index, offset };
  }

  // Read access
  read(addr) {
    this.stats.reads++;
    const { tag, index } = this.decompose(addr);
    const set = this.sets[index];
    this.accessCounter++;

    const way = set.find(tag);
    if (way !== -1) {
      // Hit
      this.stats.readHits++;
      set.lines[way].lastAccess = this.accessCounter;
      return true;
    }

    // Miss — load into cache
    this.stats.readMisses++;
    this._allocate(set, tag);
    return false;
  }

  // Write access
  write(addr) {
    this.stats.writes++;
    const { tag, index } = this.decompose(addr);
    const set = this.sets[index];
    this.accessCounter++;

    const way = set.find(tag);
    if (way !== -1) {
      // Hit
      this.stats.writeHits++;
      set.lines[way].lastAccess = this.accessCounter;
      if (this.writePolicy === 'write-back') {
        set.lines[way].dirty = true;
      }
      return true;
    }

    // Miss
    this.stats.writeMisses++;
    if (this.writePolicy === 'write-back') {
      const line = this._allocate(set, tag);
      line.dirty = true;
    }
    // write-through: don't allocate on write miss (write-no-allocate)
    return false;
  }

  _allocate(set, tag) {
    this.insertCounter++;
    let way = set.findEmpty();
    
    if (way === -1) {
      // Need to evict
      way = set.findVictim(this.policy);
      this.stats.evictions++;
      if (set.lines[way].dirty) {
        this.stats.dirtyEvictions++;
      }
    }

    const line = set.lines[way];
    line.valid = true;
    line.tag = tag;
    line.dirty = false;
    line.lastAccess = this.accessCounter;
    line.insertOrder = this.insertCounter;
    return line;
  }

  // Get statistics
  getStats() {
    const totalAccesses = this.stats.reads + this.stats.writes;
    const totalHits = this.stats.readHits + this.stats.writeHits;
    const totalMisses = this.stats.readMisses + this.stats.writeMisses;
    return {
      ...this.stats,
      totalAccesses,
      totalHits,
      totalMisses,
      hitRate: totalAccesses > 0 ? ((totalHits / totalAccesses) * 100).toFixed(1) + '%' : 'N/A',
      missRate: totalAccesses > 0 ? ((totalMisses / totalAccesses) * 100).toFixed(1) + '%' : 'N/A',
    };
  }

  // Reset stats
  resetStats() {
    for (const key in this.stats) this.stats[key] = 0;
    this.accessCounter = 0;
    this.insertCounter = 0;
  }

  // Configuration string
  describe() {
    const type = this.ways === 1 ? 'Direct-Mapped'
      : this.ways === this.numLines ? 'Fully Associative'
      : `${this.ways}-way Set Associative`;
    return `${type}, ${this.totalSize}B, ${this.blockSize}B lines, ${this.numSets} sets, ${this.policy}`;
  }
}

/**
 * Cache hierarchy (L1 + L2 + optional L3)
 */
class CacheHierarchy {
  constructor(levels) {
    this.levels = levels.map(opts => new Cache(opts));
  }

  read(addr) {
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i].read(addr)) {
        return { hit: true, level: i + 1 };
      }
    }
    return { hit: false, level: 0 }; // Main memory
  }

  write(addr) {
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i].write(addr)) {
        return { hit: true, level: i + 1 };
      }
    }
    return { hit: false, level: 0 };
  }

  getStats() {
    return this.levels.map((cache, i) => ({
      level: i + 1,
      config: cache.describe(),
      ...cache.getStats(),
    }));
  }
}

module.exports = { Cache, CacheHierarchy, CacheLine, CacheSet };
