'use strict';

/**
 * Minimal ELF32 Parser for RISC-V
 * 
 * Parses ELF32 headers and program headers to load
 * executable segments into CPU memory.
 * 
 * ELF32 format:
 *   - ELF header (52 bytes)
 *   - Program headers (32 bytes each)
 *   - Section headers (optional, 40 bytes each)
 */

// ELF magic
const ELF_MAGIC = [0x7F, 0x45, 0x4C, 0x46]; // \x7FELF

// ELF classes
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;

// Data encoding
const ELFDATA2LSB = 1; // Little-endian

// Machine types
const EM_RISCV = 243;

// ELF types
const ET_EXEC = 2;
const ET_DYN = 3;

// Program header types
const PT_LOAD = 1;
const PT_NULL = 0;

// Program header flags
const PF_X = 1; // Execute
const PF_W = 2; // Write
const PF_R = 4; // Read

class ELFLoader {
  constructor(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      buffer = new Uint8Array(buffer);
    }
    this.data = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  // Read little-endian values
  u8(offset) { return this.data[offset]; }
  u16(offset) { return this.view.getUint16(offset, true); }
  u32(offset) { return this.view.getUint32(offset, true); }
  i32(offset) { return this.view.getInt32(offset, true); }

  /**
   * Parse ELF header
   */
  parseHeader() {
    // Check magic
    for (let i = 0; i < 4; i++) {
      if (this.data[i] !== ELF_MAGIC[i]) {
        throw new Error('Not an ELF file (bad magic)');
      }
    }

    const elfClass = this.u8(4);
    if (elfClass !== ELFCLASS32) {
      throw new Error(`Expected ELF32 (class=1), got class=${elfClass}`);
    }

    const encoding = this.u8(5);
    if (encoding !== ELFDATA2LSB) {
      throw new Error(`Expected little-endian (encoding=1), got encoding=${encoding}`);
    }

    const machine = this.u16(18);
    if (machine !== EM_RISCV) {
      throw new Error(`Expected RISC-V (machine=243), got machine=${machine}`);
    }

    return {
      class: elfClass,
      encoding,
      type: this.u16(16),
      machine,
      version: this.u32(20),
      entry: this.u32(24),
      phoff: this.u32(28),    // Program header offset
      shoff: this.u32(32),    // Section header offset
      flags: this.u32(36),
      ehsize: this.u16(40),
      phentsize: this.u16(42),
      phnum: this.u16(44),
      shentsize: this.u16(46),
      shnum: this.u16(48),
      shstrndx: this.u16(50),
    };
  }

  /**
   * Parse program headers
   */
  parseProgramHeaders(header) {
    const segments = [];
    for (let i = 0; i < header.phnum; i++) {
      const off = header.phoff + i * header.phentsize;
      segments.push({
        type: this.u32(off),
        offset: this.u32(off + 4),
        vaddr: this.u32(off + 8),
        paddr: this.u32(off + 12),
        filesz: this.u32(off + 16),
        memsz: this.u32(off + 20),
        flags: this.u32(off + 24),
        align: this.u32(off + 28),
      });
    }
    return segments;
  }

  /**
   * Parse section headers (for symbol table, string table, etc.)
   */
  parseSectionHeaders(header) {
    if (!header.shoff || !header.shnum) return [];
    const sections = [];
    for (let i = 0; i < header.shnum; i++) {
      const off = header.shoff + i * header.shentsize;
      sections.push({
        name: this.u32(off),      // index into string table
        type: this.u32(off + 4),
        flags: this.u32(off + 8),
        addr: this.u32(off + 12),
        offset: this.u32(off + 16),
        size: this.u32(off + 20),
        link: this.u32(off + 24),
        info: this.u32(off + 28),
        addralign: this.u32(off + 32),
        entsize: this.u32(off + 36),
      });
    }
    return sections;
  }

  /**
   * Load ELF into CPU memory
   * Returns { entry, segments: [...] }
   */
  loadInto(cpu) {
    const header = this.parseHeader();
    const segments = this.parseProgramHeaders(header);
    
    const loaded = [];
    for (const seg of segments) {
      if (seg.type !== PT_LOAD) continue;
      
      // Copy file data into memory
      if (seg.filesz > 0) {
        const fileData = this.data.slice(seg.offset, seg.offset + seg.filesz);
        cpu.mem.storeBytes(seg.vaddr, fileData);
      }
      
      // Zero-fill BSS (memsz > filesz)
      if (seg.memsz > seg.filesz) {
        for (let i = seg.vaddr + seg.filesz; i < seg.vaddr + seg.memsz; i++) {
          cpu.mem.storeByte(i, 0);
        }
      }
      
      loaded.push({
        vaddr: seg.vaddr,
        memsz: seg.memsz,
        filesz: seg.filesz,
        flags: seg.flags,
        readable: !!(seg.flags & PF_R),
        writable: !!(seg.flags & PF_W),
        executable: !!(seg.flags & PF_X),
      });
    }
    
    // Set entry point
    cpu.regs.pc = header.entry;
    
    return {
      entry: header.entry,
      segments: loaded,
      header,
    };
  }

  /**
   * Parse — return full info without loading
   */
  parse() {
    const header = this.parseHeader();
    const segments = this.parseProgramHeaders(header);
    const sections = this.parseSectionHeaders(header);
    return { header, segments, sections };
  }

  /**
   * Build a minimal ELF32 binary from assembled words
   * Useful for testing — creates a loadable ELF from raw instructions
   */
  static buildMinimalELF(words, entryAddr = 0x10000) {
    const codeBytes = words.length * 4;
    const ehdrSize = 52;
    const phdrSize = 32;
    const totalSize = ehdrSize + phdrSize + codeBytes;
    
    const buf = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);
    
    // ELF header
    buf[0] = 0x7F; buf[1] = 0x45; buf[2] = 0x4C; buf[3] = 0x46;
    buf[4] = ELFCLASS32;     // 32-bit
    buf[5] = ELFDATA2LSB;    // Little-endian
    buf[6] = 1;              // ELF version
    view.setUint16(16, ET_EXEC, true);   // e_type
    view.setUint16(18, EM_RISCV, true);  // e_machine
    view.setUint32(20, 1, true);         // e_version
    view.setUint32(24, entryAddr, true); // e_entry
    view.setUint32(28, ehdrSize, true);  // e_phoff (program headers right after ELF header)
    view.setUint16(40, ehdrSize, true);  // e_ehsize
    view.setUint16(42, phdrSize, true);  // e_phentsize
    view.setUint16(44, 1, true);         // e_phnum (1 segment)
    
    // Program header (one PT_LOAD segment)
    const phOff = ehdrSize;
    view.setUint32(phOff, PT_LOAD, true);              // p_type
    view.setUint32(phOff + 4, ehdrSize + phdrSize, true); // p_offset (file offset of code)
    view.setUint32(phOff + 8, entryAddr, true);        // p_vaddr
    view.setUint32(phOff + 12, entryAddr, true);       // p_paddr
    view.setUint32(phOff + 16, codeBytes, true);       // p_filesz
    view.setUint32(phOff + 20, codeBytes, true);       // p_memsz
    view.setUint32(phOff + 24, PF_R | PF_X, true);    // p_flags
    view.setUint32(phOff + 28, 4, true);               // p_align
    
    // Code
    const codeOff = ehdrSize + phdrSize;
    for (let i = 0; i < words.length; i++) {
      view.setUint32(codeOff + i * 4, words[i], true);
    }
    
    return buf;
  }
}

module.exports = { ELFLoader, ELF_MAGIC, EM_RISCV, PT_LOAD, PF_R, PF_W, PF_X };
