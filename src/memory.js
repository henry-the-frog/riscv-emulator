'use strict';

/**
 * RISC-V Memory — byte-addressable, little-endian
 * Supports 8/16/32-bit loads and stores
 */
class Memory {
  constructor(size = 1024 * 1024) { // 1MB default
    this.data = new Uint8Array(size);
    this.size = size;
  }

  _check(addr, width) {
    if (addr < 0 || addr + width > this.size) {
      throw new Error(`Memory access out of bounds: 0x${addr.toString(16)} (size=${width})`);
    }
  }

  // --- Load ---
  loadByte(addr) {
    this._check(addr, 1);
    return this.data[addr];
  }

  loadByteSigned(addr) {
    const v = this.loadByte(addr);
    return v & 0x80 ? v - 256 : v;
  }

  loadHalf(addr) {
    this._check(addr, 2);
    return this.data[addr] | (this.data[addr + 1] << 8);
  }

  loadHalfSigned(addr) {
    const v = this.loadHalf(addr);
    return v & 0x8000 ? v - 65536 : v;
  }

  loadWord(addr) {
    this._check(addr, 4);
    return (
      this.data[addr] |
      (this.data[addr + 1] << 8) |
      (this.data[addr + 2] << 16) |
      (this.data[addr + 3] << 24)
    ) >>> 0; // unsigned 32-bit
  }

  loadWordSigned(addr) {
    const v = this.loadWord(addr);
    return v | 0; // sign-extend to 32-bit signed
  }

  // --- Store ---
  storeByte(addr, val) {
    this._check(addr, 1);
    this.data[addr] = val & 0xFF;
  }

  storeHalf(addr, val) {
    this._check(addr, 2);
    this.data[addr] = val & 0xFF;
    this.data[addr + 1] = (val >> 8) & 0xFF;
  }

  storeWord(addr, val) {
    this._check(addr, 4);
    this.data[addr] = val & 0xFF;
    this.data[addr + 1] = (val >> 8) & 0xFF;
    this.data[addr + 2] = (val >> 16) & 0xFF;
    this.data[addr + 3] = (val >> 24) & 0xFF;
  }

  // --- Bulk ---
  loadBytes(addr, length) {
    this._check(addr, length);
    return new Uint8Array(this.data.buffer, addr, length);
  }

  storeBytes(addr, bytes) {
    this._check(addr, bytes.length);
    this.data.set(bytes, addr);
  }

  // Load a null-terminated string
  loadString(addr) {
    let s = '';
    let i = addr;
    while (i < this.size && this.data[i] !== 0) {
      s += String.fromCharCode(this.data[i]);
      i++;
    }
    return s;
  }

  // Store a null-terminated string
  storeString(addr, str) {
    const bytes = new Uint8Array(str.length + 1);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    bytes[str.length] = 0;
    this.storeBytes(addr, bytes);
  }
}

module.exports = { Memory };
