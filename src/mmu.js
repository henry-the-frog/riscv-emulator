/**
 * RISC-V Virtual Memory — Sv32 (2-level page table)
 * 
 * Sv32 address translation:
 *   Virtual address: [VPN[1](10) | VPN[0](10) | Offset(12)]
 *   Physical address: [PPN[1](12) | PPN[0](10) | Offset(12)]
 *   Page size: 4KB (2^12)
 *   Page Table Entry (PTE): 32 bits
 *     [PPN[1](12) | PPN[0](10) | RSW(2) | D | A | G | U | X | W | R | V]
 *   
 *   Two-level walk:
 *   1. satp.ppn → level-1 page table base
 *   2. PTE at base + VPN[1]*4
 *   3. If leaf, done. If pointer, follow to level-0 table.
 *   4. PTE at next_base + VPN[0]*4
 */

// PTE flag bits
const PTE_V = 1 << 0;  // Valid
const PTE_R = 1 << 1;  // Readable
const PTE_W = 1 << 2;  // Writable
const PTE_X = 1 << 3;  // Executable
const PTE_U = 1 << 4;  // User-accessible
const PTE_G = 1 << 5;  // Global
const PTE_A = 1 << 6;  // Accessed
const PTE_D = 1 << 7;  // Dirty

const PAGE_SIZE = 4096;
const PAGE_OFFSET_BITS = 12;
const VPN_BITS = 10;
const VPN_MASK = (1 << VPN_BITS) - 1;
const OFFSET_MASK = (1 << PAGE_OFFSET_BITS) - 1;

class PageTableEntry {
  constructor(value = 0) {
    this.value = value >>> 0;
  }

  get valid() { return !!(this.value & PTE_V); }
  get readable() { return !!(this.value & PTE_R); }
  get writable() { return !!(this.value & PTE_W); }
  get executable() { return !!(this.value & PTE_X); }
  get user() { return !!(this.value & PTE_U); }
  get global() { return !!(this.value & PTE_G); }
  get accessed() { return !!(this.value & PTE_A); }
  get dirty() { return !!(this.value & PTE_D); }

  // Is this a leaf PTE (has R, W, or X)?
  get isLeaf() {
    return !!(this.value & (PTE_R | PTE_W | PTE_X));
  }

  // Extract physical page number
  get ppn() { return (this.value >>> 10) & 0x3FFFFF; } // 22 bits
  get ppn0() { return (this.value >>> 10) & VPN_MASK; }
  get ppn1() { return (this.value >>> 20) & 0xFFF; }

  // Set accessed flag
  setAccessed() { this.value |= PTE_A; }
  setDirty() { this.value |= PTE_D; }

  static create(ppn, flags) {
    return new PageTableEntry(((ppn & 0x3FFFFF) << 10) | (flags & 0x3FF));
  }
}

/**
 * Translation Lookaside Buffer (TLB)
 * Caches virtual→physical page translations
 */
class TLB {
  constructor(entries = 16) {
    this.maxEntries = entries;
    this.entries = []; // { vpn, ppn, flags, lastAccess }
    this.accessCounter = 0;
    
    // Stats
    this.hits = 0;
    this.misses = 0;
  }

  lookup(vpn) {
    this.accessCounter++;
    for (const entry of this.entries) {
      if (entry.vpn === vpn) {
        this.hits++;
        entry.lastAccess = this.accessCounter;
        return entry;
      }
    }
    this.misses++;
    return null;
  }

  insert(vpn, ppn, flags) {
    // Check if already present
    for (const entry of this.entries) {
      if (entry.vpn === vpn) {
        entry.ppn = ppn;
        entry.flags = flags;
        entry.lastAccess = this.accessCounter;
        return;
      }
    }

    // Evict LRU if full
    if (this.entries.length >= this.maxEntries) {
      let oldestIdx = 0;
      let oldestAccess = Infinity;
      for (let i = 0; i < this.entries.length; i++) {
        if (this.entries[i].lastAccess < oldestAccess) {
          oldestAccess = this.entries[i].lastAccess;
          oldestIdx = i;
        }
      }
      this.entries.splice(oldestIdx, 1);
    }

    this.entries.push({
      vpn, ppn, flags,
      lastAccess: this.accessCounter,
    });
  }

  flush() {
    this.entries = [];
  }

  flushVPN(vpn) {
    this.entries = this.entries.filter(e => e.vpn !== vpn);
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      total,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : 'N/A',
      entries: this.entries.length,
      capacity: this.maxEntries,
    };
  }
}

/**
 * Memory Management Unit (MMU)
 * Performs Sv32 page table walks and address translation
 */
class MMU {
  constructor(memory) {
    this.memory = memory;
    this.tlb = new TLB(32);
    this.enabled = false;
    this.satpPPN = 0;    // Root page table physical page number
    
    // Stats
    this.translations = 0;
    this.pageFaults = 0;
    this.pageWalks = 0;
    
    // Page fault handler (callback)
    this.onPageFault = null;
  }

  /**
   * Enable virtual memory
   * @param rootPageTableAddr Physical address of root page table
   */
  enable(rootPageTableAddr) {
    this.enabled = true;
    this.satpPPN = rootPageTableAddr >>> PAGE_OFFSET_BITS;
    this.tlb.flush();
  }

  disable() {
    this.enabled = false;
    this.tlb.flush();
  }

  /**
   * Translate virtual address to physical address
   * @param vaddr Virtual address
   * @param access 'R' | 'W' | 'X'
   * @returns Physical address
   * @throws On page fault
   */
  translate(vaddr, access = 'R') {
    if (!this.enabled) return vaddr; // Identity mapping when disabled

    this.translations++;
    vaddr = vaddr >>> 0;

    const vpn1 = (vaddr >>> 22) & VPN_MASK;
    const vpn0 = (vaddr >>> 12) & VPN_MASK;
    const offset = vaddr & OFFSET_MASK;
    const fullVPN = (vpn1 << VPN_BITS) | vpn0;

    // TLB lookup
    const tlbEntry = this.tlb.lookup(fullVPN);
    if (tlbEntry) {
      this._checkPermissions(tlbEntry.flags, access, vaddr);
      return ((tlbEntry.ppn << PAGE_OFFSET_BITS) | offset) >>> 0;
    }

    // Page table walk
    this.pageWalks++;
    const pte = this._walk(vpn1, vpn0, vaddr, access);
    
    // Insert into TLB
    this.tlb.insert(fullVPN, pte.ppn, pte.value & 0xFF);
    
    return ((pte.ppn << PAGE_OFFSET_BITS) | offset) >>> 0;
  }

  _walk(vpn1, vpn0, vaddr, access) {
    // Level 1
    const l1Addr = (this.satpPPN << PAGE_OFFSET_BITS) + vpn1 * 4;
    const l1PteVal = this.memory.loadWord(l1Addr);
    const l1Pte = new PageTableEntry(l1PteVal);

    if (!l1Pte.valid) {
      return this._handlePageFault(vaddr, 'invalid L1 PTE');
    }

    if (l1Pte.isLeaf) {
      // Superpage (4MB)
      this._checkPermissions(l1PteVal, access, vaddr);
      l1Pte.setAccessed();
      if (access === 'W') l1Pte.setDirty();
      this.memory.storeWord(l1Addr, l1Pte.value);
      // Superpage: ppn[1] from PTE, ppn[0] from VPN[0]
      const physPPN = (l1Pte.ppn1 << VPN_BITS) | vpn0;
      return PageTableEntry.create(physPPN, l1PteVal & 0xFF);
    }

    // Level 0
    const l0Base = l1Pte.ppn << PAGE_OFFSET_BITS;
    const l0Addr = l0Base + vpn0 * 4;
    const l0PteVal = this.memory.loadWord(l0Addr);
    const l0Pte = new PageTableEntry(l0PteVal);

    if (!l0Pte.valid) {
      return this._handlePageFault(vaddr, 'invalid L0 PTE');
    }

    if (!l0Pte.isLeaf) {
      return this._handlePageFault(vaddr, 'non-leaf L0 PTE');
    }

    this._checkPermissions(l0PteVal, access, vaddr);
    l0Pte.setAccessed();
    if (access === 'W') l0Pte.setDirty();
    this.memory.storeWord(l0Addr, l0Pte.value);

    return l0Pte;
  }

  _checkPermissions(flags, access, vaddr) {
    if (access === 'R' && !(flags & PTE_R)) {
      throw new Error(`Page fault: read permission denied at 0x${vaddr.toString(16)}`);
    }
    if (access === 'W' && !(flags & PTE_W)) {
      throw new Error(`Page fault: write permission denied at 0x${vaddr.toString(16)}`);
    }
    if (access === 'X' && !(flags & PTE_X)) {
      throw new Error(`Page fault: execute permission denied at 0x${vaddr.toString(16)}`);
    }
  }

  _handlePageFault(vaddr, reason) {
    this.pageFaults++;
    if (this.onPageFault) {
      return this.onPageFault(vaddr, reason);
    }
    throw new Error(`Page fault at 0x${vaddr.toString(16)}: ${reason}`);
  }

  getStats() {
    return {
      translations: this.translations,
      pageFaults: this.pageFaults,
      pageWalks: this.pageWalks,
      tlb: this.tlb.getStats(),
    };
  }
}

/**
 * Helper: set up a simple identity-mapped page table
 * Maps virtual addresses 0..size → physical addresses 0..size
 */
function setupIdentityPageTable(memory, baseAddr, sizeInPages, flags = PTE_V | PTE_R | PTE_W | PTE_X) {
  // Level-1 page table at baseAddr
  // Each L1 entry covers 4MB (1024 pages)
  const l1Entries = Math.ceil(sizeInPages / 1024);
  
  for (let i = 0; i < l1Entries; i++) {
    // Allocate L0 page table for this L1 entry
    const l0Addr = baseAddr + PAGE_SIZE + i * PAGE_SIZE;
    const l0PPN = l0Addr >>> PAGE_OFFSET_BITS;
    
    // Write L1 entry (pointer to L0 table)
    const l1PteAddr = baseAddr + i * 4;
    memory.storeWord(l1PteAddr, (l0PPN << 10) | PTE_V);
    
    // Fill L0 entries
    const pagesInThisEntry = Math.min(1024, sizeInPages - i * 1024);
    for (let j = 0; j < pagesInThisEntry; j++) {
      const physPage = i * 1024 + j;
      const l0PteAddr = l0Addr + j * 4;
      memory.storeWord(l0PteAddr, (physPage << 10) | flags);
    }
  }
  
  return baseAddr;
}

export {
  PageTableEntry, TLB, MMU,
  setupIdentityPageTable,
  PTE_V, PTE_R, PTE_W, PTE_X, PTE_U, PTE_G, PTE_A, PTE_D,
  PAGE_SIZE, PAGE_OFFSET_BITS
};
