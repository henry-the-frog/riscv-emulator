// monkey-codegen.js — Monkey Language → RISC-V RV32I Code Generator
//
// Compiles monkey-lang AST to RISC-V assembly text.
// Assembly can then be fed to the Assembler to produce machine code
// for execution on the RISC-V CPU emulator.
//
// Approach: stack-based code generation
//   - All intermediate values are pushed/popped on the RISC-V stack
//   - Variables are stack-allocated with known offsets from frame pointer (s0/fp)
//   - Functions use standard RISC-V calling convention (a0-a7 for args)
//   - Result of expression evaluation ends up in a0
//
// Calling convention:
//   - a0-a7 (x10-x17): arguments and return values
//   - s0 (x8): frame pointer
//   - sp (x2): stack pointer
//   - ra (x1): return address
//
// Syscalls for I/O:
//   - ecall with a7=1: print integer in a0
//   - ecall with a7=10: exit
//   - ecall with a7=11: print char in a0

export class RiscVCodeGen {
  constructor(options = {}) {
    this.output = [];         // Assembly lines
    this.variables = new Map(); // name → { type: 'stack'|'reg', offset?, reg? }
    this.stackOffset = 8;    // Start at 8: reserve s0-4=ra, s0-8=old_s0
    this.labelCount = 0;     // For generating unique labels
    this.functions = [];      // Deferred function bodies
    this.currentScope = null; // Variable scope chain
    this.errors = [];
    this.frameSize = 256;    // Default frame size
    
    // Register allocation
    this.useRegisters = options.useRegisters || false;
    // Callee-saved registers available for locals: s1-s11
    this.availableRegs = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11'];
    this.nextRegIdx = 0;     // Next available register index
    this.usedRegs = new Set(); // Which s-registers are in use (for save/restore)
    
    // Heap allocation
    this.heapBase = options.heapBase || 0x10000;  // Heap starts at 64KB
    this.heapSize = options.heapSize || 0x10000;  // 64KB heap (32KB per semi-space for GC)
    this.needsHeap = false;   // Set true if any heap allocation needed
    this.needsAlloc = false;  // Set true if _alloc subroutine needed
    this.needsGC = false;     // Set true if GC subroutine needed
    
    // Object type tags for GC headers
    // Header format: [tag (4 bits) | totalSizeInBytes (28 bits)]
    // Header is stored at ptr-4, so the object pointer still points to first field
    this.OBJ_TAG_STRING = 0x1;
    this.OBJ_TAG_ARRAY = 0x2;
    this.OBJ_TAG_HASH = 0x3;
    this.OBJ_TAG_CLOSURE = 0x4;
    this.OBJ_TAG_FORWARD = 0xF; // Used by GC: forwarding pointer
    
    // Type tracking for type-directed compilation
    this.varTypes = new Map(); // name → 'int' | 'string' | 'array' | 'unknown'
    this._lastExprType = 'int'; // Type of last compiled expression
  }

  /** Generate a unique label */
  _label(prefix = 'L') {
    return `${prefix}_${this.labelCount++}`;
  }

  /** Emit a line of assembly */
  _emit(line) {
    this.output.push(line);
  }

  /** Emit a comment */
  _comment(text) {
    this._emit(`  # ${text}`);
  }

  /** Emit a label */
  _emitLabel(label) {
    this._emit(`${label}:`);
  }

  /** Emit object header before allocation. Header = (tag << 28) | totalSize.
   *  Header is stored at current gp, then gp bumps by 4.
   *  Returns the total allocation size (header + object). */
  _emitObjHeader(tag, objectSize) {
    const totalSize = objectSize + 4; // +4 for header word
    const headerVal = (tag << 28) | totalSize;
    this._emit(`  li t0, ${headerVal >>> 0}`);  // >>> 0 for unsigned
    this._emit(`  sw t0, 0(gp)`);
    this._emit(`  addi gp, gp, 4`);  // skip past header
    return totalSize;
  }

  /** Emit code to print string at a0 */
  _emitPrintString() {
    this._emit('  mv t1, a0');
    this._emit('  lw t2, 0(t1)');     // length
    this._emit('  li t3, 0');          // index
    const charLoop = this._label('puts_char');
    const charEnd = this._label('puts_char_end');
    this._emitLabel(charLoop);
    this._emit(`  bge t3, t2, ${charEnd}`);
    this._emit('  slli t4, t3, 2');
    this._emit('  add t4, t1, t4');
    this._emit('  lw a0, 4(t4)');
    this._emit('  li a7, 11');         // print_char
    this._emit('  ecall');
    this._emit('  addi t3, t3, 1');
    this._emit(`  j ${charLoop}`);
    this._emitLabel(charEnd);
  }

  /** Allocate storage for a variable — register if available, otherwise stack */
  _allocLocal(name) {
    if (this.useRegisters && this.nextRegIdx < this.availableRegs.length) {
      const reg = this.availableRegs[this.nextRegIdx++];
      this.usedRegs.add(reg);
      this.variables.set(name, { type: 'reg', reg });
      return { type: 'reg', reg };
    }
    // Fall back to stack
    this.stackOffset += 4;
    const offset = -this.stackOffset;
    this.variables.set(name, { type: 'stack', offset });
    return { type: 'stack', offset };
  }

  /** Look up variable location */
  _lookupVar(name) {
    if (this.variables.has(name)) {
      return this.variables.get(name);
    }
    this.errors.push(`Undefined variable: ${name}`);
    return { type: 'stack', offset: 0 };
  }

  /** Emit: load variable value into a0 */
  _emitLoadVar(name) {
    const loc = this._lookupVar(name);
    if (loc.type === 'reg') {
      this._emit(`  mv a0, ${loc.reg}`);
    } else {
      this._emit(`  lw a0, ${loc.offset}(s0)`);
    }
  }

  /** Emit: store a0 into variable */
  _emitStoreVar(name) {
    const loc = this._lookupVar(name);
    if (loc.type === 'reg') {
      this._emit(`  mv ${loc.reg}, a0`);
    } else {
      this._emit(`  sw a0, ${loc.offset}(s0)`);
    }
  }

  /** Emit function prologue — returns placeholder index for deferred save/restore */
  _emitPrologue() {
    this._emit(`  addi sp, sp, -${this.frameSize}`);
    this._emit(`  sw ra, ${this.frameSize - 4}(sp)`);
    this._emit(`  sw s0, ${this.frameSize - 8}(sp)`);
    // Placeholder for callee-saved register saves — will be filled in later
    this._prologueSaveIdx = this.output.length;
    this._emit(`  addi s0, sp, ${this.frameSize}`);
  }

  /** Emit function epilogue */
  _emitEpilogue() {
    // Restore callee-saved registers
    if (this.useRegisters) {
      let saveOffset = this.frameSize - 12; // After ra and s0
      for (const reg of this.usedRegs) {
        this._emit(`  lw ${reg}, ${saveOffset}(sp)`);
        saveOffset -= 4;
      }
    }
    this._emit(`  lw ra, ${this.frameSize - 4}(sp)`);
    this._emit(`  lw s0, ${this.frameSize - 8}(sp)`);
    this._emit(`  addi sp, sp, ${this.frameSize}`);
  }

  /** Patch prologue to save callee-saved registers (call after compilation) */
  _patchPrologueSaves() {
    if (!this.useRegisters || this.usedRegs.size === 0) return;
    const saves = [];
    let saveOffset = this.frameSize - 12;
    for (const reg of this.usedRegs) {
      saves.push(`  sw ${reg}, ${saveOffset}(sp)`);
      saveOffset -= 4;
    }
    // Insert saves at the placeholder position
    this.output.splice(this._prologueSaveIdx, 0, ...saves);
  }

  /**
   * Compile a monkey-lang program to RISC-V assembly.
   * @param {import('../../monkey-lang/src/ast.js').Program} program
   * @returns {string} Assembly text
   */
  compile(program, typeInfo = null, closureInfo = null) {
    this.output = [];
    this.variables = new Map();
    this.stackOffset = 8; // Reserve for ra + s0
    this.labelCount = 0;
    this.functions = [];
    this.errors = [];
    this.nextRegIdx = 0;
    this.usedRegs = new Set();
    this.varTypes = new Map();
    this._lastExprType = 'int';
    
    // Apply type info from inference pass
    this._typeInfo = typeInfo;
    this._closureInfo = closureInfo;
    this._closureLabels = [];
    this._varClosureLabels = new Map();
    if (typeInfo?.varTypes) {
      for (const [k, v] of typeInfo.varTypes) {
        this.varTypes.set(k, v);
      }
    }

    // Prologue: set up main frame
    this._emit('  # Monkey → RISC-V compiled program');
    this._emitLabel('_start');
    // Initialize heap pointer (gp = x3) — from-space starts at heapBase
    this._emit(`  li gp, ${this.heapBase}`);
    // Store semi-space boundaries in memory for GC
    // from_start = heapBase
    // from_end = heapBase + heapSize/2
    // to_start = heapBase + heapSize/2
    // to_end = heapBase + heapSize
    const halfHeap = this.heapSize / 2;
    this._emit(`  li tp, ${this.heapBase + halfHeap}`);  // tp = from-space limit (used for GC trigger)
    this._emitPrologue();

    // First pass: register all top-level function names (enables mutual recursion)
    for (const stmt of program.statements) {
      if (stmt.constructor.name === 'LetStatement' &&
          stmt.value?.constructor.name === 'FunctionLiteral') {
        const funcName = stmt.name.value;
        this.variables.set(funcName, { type: 'func', label: funcName });
      }
    }

    // Compile program body
    for (const stmt of program.statements) {
      this._compileStatement(stmt);
    }

    // Epilogue: exit
    this._comment('exit');
    this._emitEpilogue();
    this._emit('  li a7, 10');           // exit syscall
    this._emit('  ecall');

    // Patch prologue with callee-saved register saves
    this._patchPrologueSaves();

    // Append deferred function bodies
    for (const fn of this.functions) {
      this._emit('');
      this.output.push(...fn);
    }

    // Append _alloc subroutine if needed
    if (this.needsAlloc) {
      this._emit('');
      this._emit('# Bump allocator with GC header: a1 = size in bytes, a2 = type tag');
      this._emit('# Returns pointer in a0 (past the header)');
      this._emitLabel('_alloc');
      // Check if we need GC: gp + size + 4 > tp?
      this._emit('  add t0, gp, a1');
      this._emit('  addi t0, t0, 4');       // +4 for header
      this._emit('  blt t0, tp, _alloc_ok'); // if gp+size+4 < tp, proceed
      // GC trigger: call ecall 200 (gc_collect)
      // Save caller regs
      this._emit('  addi sp, sp, -16');
      this._emit('  sw a1, 0(sp)');
      this._emit('  sw a2, 4(sp)');
      this._emit('  sw ra, 8(sp)');
      const halfHeap = this.heapSize / 2;
      this._emit(`  li a0, ${this.heapBase}`);         // from_start
      this._emit(`  li a1, ${this.heapBase + halfHeap}`); // to_start
      this._emit(`  li a2, ${halfHeap}`);              // half_size
      this._emit('  li a7, 200');
      this._emit('  ecall');                            // GC collect!
      // After GC: gp and tp are updated by the collector
      // Swap from/to for next GC (the collector swaps the spaces)
      this._emit('  lw a1, 0(sp)');
      this._emit('  lw a2, 4(sp)');
      this._emit('  lw ra, 8(sp)');
      this._emit('  addi sp, sp, 16');
      this._emitLabel('_alloc_ok');
      // Write header: (tag << 28) | (size + 4)
      this._emit('  addi t0, a1, 4');      // total size = object + header
      this._emit('  slli t1, a2, 28');      // tag << 28
      this._emit('  or t0, t1, t0');        // header = tag | total_size
      this._emit('  sw t0, 0(gp)');         // store header
      this._emit('  addi gp, gp, 4');       // skip header
      this._emit('  mv a0, gp');            // Return ptr past header
      this._emit('  add gp, gp, a1');       // Bump by object size
      this._emit('  ret');
    }

    // Append _str_eq subroutine if needed
    if (this.needsStrEq) {
      this._emit('');
      this._emit('# String equality: a0=str1, a1=str2, returns a0=1 if equal, 0 otherwise');
      this._emitLabel('_str_eq');
      this._emit('  lw t0, 0(a0)');        // t0 = len1
      this._emit('  lw t1, 0(a1)');        // t1 = len2
      this._emit('  bne t0, t1, _str_eq_ne'); // different lengths → not equal
      this._emit('  li t2, 0');             // t2 = char index
      this._emitLabel('_str_eq_loop');
      this._emit('  bge t2, t0, _str_eq_eq'); // all chars compared → equal
      this._emit('  slli t3, t2, 2');       // index * 4
      this._emit('  add t4, a0, t3');       
      this._emit('  lw t4, 4(t4)');         // str1[i]
      this._emit('  add t5, a1, t3');
      this._emit('  lw t5, 4(t5)');         // str2[i]
      this._emit('  bne t4, t5, _str_eq_ne'); // chars differ → not equal
      this._emit('  addi t2, t2, 1');
      this._emit('  j _str_eq_loop');
      this._emitLabel('_str_eq_eq');
      this._emit('  li a0, 1');
      this._emit('  ret');
      this._emitLabel('_str_eq_ne');
      this._emit('  li a0, 0');
      this._emit('  ret');
    }

    // Append _closure_dispatch trampoline if needed
    if (this.needsClosureDispatch && this._closureLabels && this._closureLabels.length > 0) {
      this._emit('');
      this._emit('# Closure dispatch: a0=closure_ptr, a1+=args');
      this._emit('# Reads fn_id from closure[0], checks num_captured');
      this._emit('# If num_captured==-1 (function ref), shifts args down (a0=a1, a1=a2, ...)');
      this._emitLabel('_closure_dispatch');
      this._emit('  lw t0, 0(a0)');    // t0 = fn_id
      this._emit('  lw t2, 4(a0)');    // t2 = num_captured
      
      // If num_captured == -1, shift args down (this is a plain function ref, not a real closure)
      const noShift = this._label('_cd_noshift');
      this._emit('  li t3, -1');
      this._emit(`  bne t2, t3, ${noShift}`);
      // Shift: a0=a1, a1=a2, a2=a3, ...
      this._emit('  mv a0, a1');
      this._emit('  mv a1, a2');
      this._emit('  mv a2, a3');
      this._emit('  mv a3, a4');
      this._emit('  mv a4, a5');
      this._emit('  mv a5, a6');
      this._emit('  mv a6, a7');
      this._emitLabel(noShift);
      
      for (let i = 0; i < this._closureLabels.length; i++) {
        const skipLabel = this._label('_cd_skip');
        this._emit(`  li t1, ${i}`);
        this._emit(`  bne t0, t1, ${skipLabel}`);
        this._emit(`  j ${this._closureLabels[i]}`);  // tail call — ra already set by caller's jal
        this._emitLabel(skipLabel);
      }
      // Fallthrough: unknown closure id — halt
      this._emit('  li a7, 10');
      this._emit('  ecall');
    }

    if (this.errors.length > 0) {
      throw new Error(`Compilation errors:\n${this.errors.join('\n')}`);
    }

    return this.output.join('\n');
  }

  // --- Statement compilation ---

  _compileStatement(stmt) {
    const type = stmt.constructor.name;
    switch (type) {
      case 'LetStatement':
        return this._compileLet(stmt);
      case 'DestructureLetStatement':
        return this._compileDestructureLet(stmt);
      case 'SetStatement':
        return this._compileSet(stmt);
      case 'ReturnStatement':
        return this._compileReturn(stmt);
      case 'ExpressionStatement':
        return this._compileExpression(stmt.expression);
      default:
        this.errors.push(`Unsupported statement: ${type}`);
    }
  }

  _compileDestructureLet(stmt) {
    this._comment('destructure let');
    // Compile the value expression (should produce an array)
    this._compileExpression(stmt.value);
    // a0 = array pointer, save it
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');   // save array ptr
    
    // For each name, extract arr[i] and store
    for (let i = 0; i < stmt.names.length; i++) {
      const name = stmt.names[i].value;
      this._allocLocal(name);
      this._emit('  lw t0, 0(sp)');                   // reload array ptr
      this._emit(`  lw a0, ${(i + 1) * 4}(t0)`);     // arr[i]
      this._emitStoreVar(name);
    }
    
    this._emit('  addi sp, sp, 4');  // cleanup saved array ptr
  }

  _compileLet(stmt) {
    const name = stmt.name.value;
    this._comment(`let ${name}`);
    
    // Check if value is a function literal
    if (stmt.value && stmt.value.constructor.name === 'FunctionLiteral') {
      // Check if it has free variables (is a closure)
      const freeVars = this._closureInfo?.get(stmt.value);
      if (freeVars && freeVars.length > 0) {
        // Compile as closure expression, passing the binding name for self-reference
        this._compileFunctionLiteralExpr(stmt.value, name);
        this.varTypes.set(name, 'closure');
        // Record which closure label this variable maps to
        this._varClosureLabels = this._varClosureLabels || new Map();
        const lastLabel = this._closureLabels?.[this._closureLabels.length - 1];
        if (lastLabel) this._varClosureLabels.set(name, lastLabel);
        this._allocLocal(name);
        this._emitStoreVar(name);
        return;
      }
      this._compileFunctionDef(name, stmt.value);
      return;
    }
    
    // Compile the value expression (result in a0)
    this._compileExpression(stmt.value);
    
    // Track the type of this variable
    this.varTypes.set(name, this._lastExprType);
    
    // Allocate storage and store
    this._allocLocal(name);
    this._emitStoreVar(name);
  }

  _compileSet(stmt) {
    const name = stmt.name.value;
    this._comment(`set ${name}`);
    this._compileExpression(stmt.value);
    this._emitStoreVar(name);
  }

  _compileReturn(stmt) {
    // Tail call optimization: if returning a call to current function, jump back
    if (stmt.returnValue && 
        stmt.returnValue.constructor.name === 'CallExpression' &&
        this._currentFuncName) {
      
      const callee = stmt.returnValue.function.value || stmt.returnValue.function.toString();
      
      if (callee === this._currentFuncName) {
        // Self tail call: jump back to function entry
        this._comment(`tail call to ${this._currentFuncName}`);
        const args = stmt.returnValue.arguments;
        
        // Compile all arguments first, saving to stack to avoid clobbering
        for (let i = 0; i < args.length; i++) {
          this._compileExpression(args[i]);
          this._emit('  addi sp, sp, -4');
          this._emit('  sw a0, 0(sp)');
        }
        
        // Pop into argument registers (reverse order to match calling convention)
        for (let i = args.length - 1; i >= 0; i--) {
          this._emit(`  lw a${i}, ${(args.length - 1 - i) * 4}(sp)`);
        }
        this._emit(`  addi sp, sp, ${args.length * 4}`);
        
        // Jump back to function entry (after prologue)
        this._emit(`  j ${this._currentFuncName}_tco_entry`);
        return;
      }
      
      // General tail call optimization for named functions
      // If the callee is a known non-closure function, we can tail-call it
      const calleeType = this.varTypes.get(callee);
      const isBuiltin = ['puts', 'len', 'first', 'last', 'push', 'rest', 'type'].includes(callee);
      const isClosureCall = calleeType === 'closure';
      
      if (!isBuiltin && !isClosureCall) {
        // General tail call: tear down our frame and jump to target
        this._comment(`tail call to ${callee}`);
        const args = stmt.returnValue.arguments;
        
        // Compile all arguments first, saving to stack to avoid clobbering
        for (let i = 0; i < args.length; i++) {
          this._compileExpression(args[i]);
          this._emit('  addi sp, sp, -4');
          this._emit('  sw a0, 0(sp)');
        }
        
        // Pop into argument registers (reverse order to match calling convention)
        for (let i = args.length - 1; i >= 0; i--) {
          this._emit(`  lw a${i}, ${(args.length - 1 - i) * 4}(sp)`);
        }
        if (args.length > 0) {
          this._emit(`  addi sp, sp, ${args.length * 4}`);
        }
        
        // Tear down our stack frame (epilogue without ret)
        this._emitEpilogue();
        
        // Jump (not call) to the target function
        this._emit(`  j ${callee}`);
        return;
      }
      
      // Closure tail call optimization
      if (isClosureCall && !isBuiltin) {
        this._comment(`tail call to closure ${callee}`);
        const args = stmt.returnValue.arguments;
        
        // Compile all arguments and save to stack
        for (let i = 0; i < args.length; i++) {
          this._compileExpression(args[i]);
          this._emit('  addi sp, sp, -4');
          this._emit('  sw a0, 0(sp)');
        }
        
        // Load closure pointer and save to stack
        this._emitLoadVar(callee);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');
        
        // Pop closure ptr into a0, args into a1, a2, ...
        // Closure dispatch expects: a0=closure_ptr, a1=arg0, a2=arg1, ...
        this._emit('  lw a0, 0(sp)');  // closure ptr
        for (let i = 0; i < args.length; i++) {
          this._emit(`  lw a${i + 1}, ${(args.length - i) * 4}(sp)`);
        }
        this._emit(`  addi sp, sp, ${(args.length + 1) * 4}`);
        
        // Tear down our stack frame (epilogue without ret)
        this._emitEpilogue();
        
        // Jump to closure dispatch trampoline
        this._emit('  j _closure_dispatch');
        this.needsClosureDispatch = true;
        return;
      }
    }
    
    this._comment('return');
    if (stmt.returnValue) {
      this._compileExpression(stmt.returnValue);
    }
    // a0 already has the return value
    this._emitEpilogue();
    this._emit('  ret');
  }

  // --- Expression compilation ---
  // All expressions leave their result in a0

  _compileExpression(expr) {
    if (!expr) return;
    const type = expr.constructor.name;
    switch (type) {
      case 'IntegerLiteral':
        return this._compileIntegerLiteral(expr);
      case 'BooleanLiteral':
        return this._compileBooleanLiteral(expr);
      case 'Identifier':
        return this._compileIdentifier(expr);
      case 'PrefixExpression':
        return this._compilePrefixExpression(expr);
      case 'InfixExpression':
        return this._compileInfixExpression(expr);
      case 'IfExpression':
        return this._compileIfExpression(expr);
      case 'CallExpression':
        return this._compileCallExpression(expr);
      case 'BlockStatement':
        return this._compileBlock(expr);
      case 'WhileExpression':
        return this._compileWhile(expr);
      case 'ArrayLiteral':
        return this._compileArrayLiteral(expr);
      case 'StringLiteral':
        return this._compileStringLiteral(expr);
      case 'HashLiteral':
        return this._compileHashLiteral(expr);
      case 'IndexExpression':
        return this._compileIndexExpression(expr.left, expr.index);
      case 'ForInExpression':
        return this._compileForIn(expr);
      case 'FunctionLiteral':
        return this._compileFunctionLiteralExpr(expr);
      case 'SwitchExpression':
        return this._compileSwitchExpr(expr);
      case 'NullLiteral':
        this._emit('  li a0, 0');
        this._lastExprType = 'int';
        return;
      case 'TernaryExpression':
        return this._compileTernary(expr);
      case 'DoWhileExpression':
        return this._compileDoWhile(expr);
      case 'ForExpression':
        return this._compileForExpr(expr);
      case 'SliceExpression':
        return this._compileSlice(expr);
      default:
        this.errors.push(`Unsupported expression: ${type}`);
    }
  }

  _compileIntegerLiteral(expr) {
    const val = expr.value;
    this._emit(`  li a0, ${val}`);
    this._lastExprType = 'int';
  }

  _compileBooleanLiteral(expr) {
    this._emit(`  li a0, ${expr.value ? 1 : 0}`);
    this._lastExprType = 'int';
  }

  _compileIdentifier(expr) {
    const name = expr.value;
    const varInfo = this._lookupVar(name);
    
    // If it's a function reference used as a value (not called), 
    // create a closure wrapper for it
    if (varInfo && varInfo.type === 'func') {
      this._comment(`function ref → closure: ${name}`);
      this.needsClosureDispatch = true;
      this._closureLabels = this._closureLabels || [];
      
      // Find or create closure label for this function
      let closureId = this._closureLabels.indexOf(name);
      if (closureId === -1) {
        closureId = this._closureLabels.length;
        this._closureLabels.push(name);
      }
      
      // Allocate closure object: [HEADER][fn_id (4), num_captured=-1 (4)] — -1 means "plain function ref"
      this._emitObjHeader(this.OBJ_TAG_CLOSURE, 8);
      this._emit('  mv t1, gp');
      this._emit('  addi gp, gp, 8');
      this._emit(`  li t2, ${closureId}`);
      this._emit('  sw t2, 0(t1)');
      this._emit('  li t2, -1');       // -1 = plain function ref (needs arg shift)
      this._emit('  sw t2, 4(t1)');
      this._emit('  mv a0, t1');
      this._lastExprType = 'closure';
      return;
    }
    
    this._emitLoadVar(name);
    this._lastExprType = this.varTypes.get(name) || 'unknown';
  }

  _compilePrefixExpression(expr) {
    this._compileExpression(expr.right);
    switch (expr.operator) {
      case '-':
        this._emit('  neg a0, a0');  // pseudo: sub a0, zero, a0
        break;
      case '!':
        this._emit('  seqz a0, a0'); // a0 = (a0 == 0) ? 1 : 0
        break;
      default:
        this.errors.push(`Unsupported prefix operator: ${expr.operator}`);
    }
  }

  _compileInfixExpression(expr) {
    const op = expr.operator;
    
    // Check if this is string concatenation
    if (op === '+') {
      const leftType = this._inferExprType(expr.left);
      const rightType = this._inferExprType(expr.right);
      if (leftType === 'string' || rightType === 'string') {
        return this._compileStringConcat(expr.left, expr.right);
      }
    }
    
    // Check if this is string comparison
    if (op === '==' || op === '!=') {
      const leftType = this._inferExprType(expr.left);
      const rightType = this._inferExprType(expr.right);
      if (leftType === 'string' || rightType === 'string') {
        return this._compileStringCompare(expr.left, expr.right, op);
      }
    }
    
    // Range operator (..) — creates array [start, start+1, ..., end-1]
    if (op === '..') {
      this._comment('range');
      this.needsAlloc = true;
      
      // Compile start
      this._compileExpression(expr.left);
      this._emit('  addi sp, sp, -4');
      this._emit('  sw a0, 0(sp)');   // save start
      
      // Compile end
      this._compileExpression(expr.right);
      this._emit('  mv t2, a0');       // t2 = end
      this._emit('  lw t0, 0(sp)');    // t0 = start
      this._emit('  addi sp, sp, 4');
      
      // Calculate length
      this._emit('  sub t3, t2, t0');   // t3 = end - start = length
      
      // Allocate array: [length, elem0, elem1, ...]
      this._emit('  addi t4, t3, 1');
      this._emit('  slli t4, t4, 2');
      // Emit GC header for array (dynamic size)
      this._emit(`  addi t6, t4, 4`);        // total = object + header
      this._emit(`  li t5, ${this.OBJ_TAG_ARRAY << 28}`);
      this._emit(`  or t6, t5, t6`);
      this._emit(`  sw t6, 0(gp)`);
      this._emit(`  addi gp, gp, 4`);
      this._emit('  mv t5, gp');
      this._emit('  add gp, gp, t4');
      
      // Store length
      this._emit('  sw t3, 0(t5)');
      
      // Fill elements
      this._emit('  li t4, 0');         // i = 0
      const fillLoop = this._label('range_fill');
      const fillEnd = this._label('range_end');
      this._emitLabel(fillLoop);
      this._emit(`  bge t4, t3, ${fillEnd}`);
      this._emit('  add t6, t0, t4');   // value = start + i
      this._emit('  addi a0, t4, 1');
      this._emit('  slli a0, a0, 2');
      this._emit('  add a0, t5, a0');
      this._emit('  sw t6, 0(a0)');     // arr[i+1] = value
      this._emit('  addi t4, t4, 1');
      this._emit(`  j ${fillLoop}`);
      this._emitLabel(fillEnd);
      
      this._emit('  mv a0, t5');
      this._lastExprType = 'array';
      return;
    }
    
    // Logical AND with short-circuit
    if (op === '&&') {
      this._compileExpression(expr.left);
      const endLabel = this._label('and_end');
      this._emit(`  beqz a0, ${endLabel}`); // If left is false (0), skip right
      this._compileExpression(expr.right);
      this._emitLabel(endLabel);
      this._lastExprType = 'int';
      return;
    }
    
    // Logical OR with short-circuit
    if (op === '||') {
      this._compileExpression(expr.left);
      const endLabel = this._label('or_end');
      this._emit(`  bnez a0, ${endLabel}`); // If left is true (non-zero), skip right
      this._compileExpression(expr.right);
      this._emitLabel(endLabel);
      this._lastExprType = 'int';
      return;
    }
    
    // Compile left, push to stack
    this._compileExpression(expr.left);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Compile right (result in a0)
    this._compileExpression(expr.right);
    
    // Pop left into t0
    this._emit('  lw t0, 0(sp)');
    this._emit('  addi sp, sp, 4');
    
    // t0 = left, a0 = right
    switch (op) {
      case '+':
        this._emit('  add a0, t0, a0');
        break;
      case '-':
        this._emit('  sub a0, t0, a0');
        break;
      case '*':
        this._emit('  mul a0, t0, a0');
        break;
      case '/':
        this._emit('  div a0, t0, a0');
        break;
      case '%':
        this._emit('  rem a0, t0, a0');
        break;
      case '<':
        this._emit('  slt a0, t0, a0');
        break;
      case '>':
        this._emit('  slt a0, a0, t0');
        break;
      case '==':
        this._emit('  sub a0, t0, a0');
        this._emit('  seqz a0, a0');
        break;
      case '!=':
        this._emit('  sub a0, t0, a0');
        this._emit('  snez a0, a0');
        break;
      case '<=':
        this._emit('  slt a0, a0, t0');
        this._emit('  xori a0, a0, 1');
        break;
      case '>=':
        this._emit('  slt a0, t0, a0');
        this._emit('  xori a0, a0, 1');
        break;
      default:
        this.errors.push(`Unsupported infix operator: ${op}`);
    }
    this._lastExprType = 'int';
  }

  /** Infer the type of an expression from the AST (quick check, no deep analysis) */
  _inferExprType(expr) {
    if (!expr) return 'unknown';
    const name = expr.constructor.name;
    if (name === 'StringLiteral') return 'string';
    if (name === 'IntegerLiteral') return 'int';
    if (name === 'BooleanLiteral') return 'int';
    if (name === 'ArrayLiteral') return 'array';
    if (name === 'HashLiteral') return 'hash';
    if (name === 'Identifier') return this.varTypes.get(expr.value) || 'unknown';
    if (name === 'InfixExpression' && expr.operator === '+') {
      const lt = this._inferExprType(expr.left);
      const rt = this._inferExprType(expr.right);
      if (lt === 'string' || rt === 'string') return 'string';
    }
    return 'unknown';
  }

  /** Compile string concatenation: allocate new string, copy both */
  _compileStringConcat(left, right) {
    this._comment('string concat');
    
    // Compile left string, push pointer
    this._compileExpression(left);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Compile right string, push pointer
    this._compileExpression(right);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Pop both: t0 = right, t1 = left (reversed because stack is LIFO)
    this._emit('  lw t0, 0(sp)');    // t0 = right string ptr
    this._emit('  lw t1, 4(sp)');    // t1 = left string ptr
    this._emit('  addi sp, sp, 8');
    
    // Get lengths
    this._emit('  lw t2, 0(t1)');    // t2 = left length
    this._emit('  lw t3, 0(t0)');    // t3 = right length
    
    // New length = left + right
    this._emit('  add t4, t2, t3');   // t4 = total length
    
    // Allocate new string: [HEADER] + 4 + totalLen * 4
    this._emit('  addi t5, t4, 1');   // len + 1 (for length word)
    this._emit('  slli t5, t5, 2');   // * 4 = object size
    // Emit GC header for string (dynamic size)
    this._emit(`  addi t6, t5, 4`);        // total = object + header
    this._emit(`  li a0, ${this.OBJ_TAG_STRING << 28}`);
    this._emit(`  or t6, a0, t6`);
    this._emit(`  sw t6, 0(gp)`);
    this._emit(`  addi gp, gp, 4`);
    this._emit('  mv a0, gp');        // new string base (past header)
    this._emit('  add gp, gp, t5');   // bump allocator
    
    // Store new length
    this._emit('  sw t4, 0(a0)');
    
    // Copy left string chars
    this._emit('  li t5, 0');         // i = 0
    const copyLeft = this._label('concat_left');
    const copyLeftEnd = this._label('concat_left_end');
    this._emitLabel(copyLeft);
    this._emit(`  bge t5, t2, ${copyLeftEnd}`);
    this._emit('  slli t6, t5, 2');
    this._emit('  add t6, t1, t6');
    this._emit('  lw t6, 4(t6)');     // left[i]
    this._emit('  slli a1, t5, 2');   // use a1 as temp
    this._emit('  add a1, a0, a1');
    this._emit('  sw t6, 4(a1)');     // new[i] = left[i]
    this._emit('  addi t5, t5, 1');
    this._emit(`  j ${copyLeft}`);
    this._emitLabel(copyLeftEnd);
    
    // Copy right string chars (starting at offset = left length)
    this._emit('  li t5, 0');         // j = 0
    const copyRight = this._label('concat_right');
    const copyRightEnd = this._label('concat_right_end');
    this._emitLabel(copyRight);
    this._emit(`  bge t5, t3, ${copyRightEnd}`);
    this._emit('  slli t6, t5, 2');
    this._emit('  add t6, t0, t6');
    this._emit('  lw t6, 4(t6)');     // right[j]
    this._emit('  add a1, t2, t5');   // offset = leftLen + j
    this._emit('  slli a1, a1, 2');
    this._emit('  add a1, a0, a1');
    this._emit('  sw t6, 4(a1)');     // new[leftLen+j] = right[j]
    this._emit('  addi t5, t5, 1');
    this._emit(`  j ${copyRight}`);
    this._emitLabel(copyRightEnd);
    
    // a0 = new string pointer
    this._lastExprType = 'string';
  }

  _compileIfExpression(expr) {
    const elseLabel = this._label('else');
    const endLabel = this._label('endif');
    
    // Compile condition
    this._compileExpression(expr.condition);
    this._emit(`  beqz a0, ${elseLabel}`);
    
    // Compile consequence
    this._compileBlock(expr.consequence);
    
    if (expr.alternative) {
      this._emit(`  j ${endLabel}`);
      this._emitLabel(elseLabel);
      this._compileBlock(expr.alternative);
      this._emitLabel(endLabel);
    } else {
      this._emitLabel(elseLabel);
    }
  }

  _compileBlock(block) {
    if (!block || !block.statements) return;
    for (const stmt of block.statements) {
      this._compileStatement(stmt);
    }
  }

  _compileWhile(expr) {
    const loopLabel = this._label('while');
    const endLabel = this._label('endwhile');
    
    this._emitLabel(loopLabel);
    this._compileExpression(expr.condition);
    this._emit(`  beqz a0, ${endLabel}`);
    this._compileBlock(expr.body);
    this._emit(`  j ${loopLabel}`);
    this._emitLabel(endLabel);
  }

  _compileArrayLiteral(expr) {
    this._comment('array literal');
    this.needsAlloc = true;
    const elements = expr.elements || [];
    const numElements = elements.length;
    const objectSize = 4 + numElements * 4; // 4 bytes for length + 4 per element
    
    // Evaluate all elements first, push onto stack
    for (let i = 0; i < numElements; i++) {
      this._compileExpression(elements[i]);
      this._emit('  addi sp, sp, -4');
      this._emit('  sw a0, 0(sp)');
    }
    
    // Emit object header and allocate heap space
    this._emitObjHeader(this.OBJ_TAG_ARRAY, objectSize);
    this._emit(`  mv t1, gp`);            // t1 = array base pointer
    this._emit(`  addi gp, gp, ${objectSize}`); // bump allocator
    
    // Store length at [base+0]
    this._emit(`  li t2, ${numElements}`);
    this._emit(`  sw t2, 0(t1)`);          // [base] = length
    
    // Pop elements from stack and store in array (reverse order)
    for (let i = numElements - 1; i >= 0; i--) {
      this._emit(`  lw t2, 0(sp)`);
      this._emit(`  addi sp, sp, 4`);
      this._emit(`  sw t2, ${4 + i * 4}(t1)`); // [base + 4 + i*4] = element[i]
    }
    
    // Result: array pointer in a0
    this._emit(`  mv a0, t1`);
    this._lastExprType = 'array';
  }

  _compileStringLiteral(expr) {
    this._comment(`string "${expr.value.slice(0, 20)}${expr.value.length > 20 ? '...' : ''}"`);
    const chars = expr.value;
    const len = chars.length;
    // String layout: [HEADER][length (4 bytes)][char0 (4 bytes)][char1 (4 bytes)]...
    const objectSize = 4 + len * 4;
    
    // Emit object header and allocate on heap
    this._emitObjHeader(this.OBJ_TAG_STRING, objectSize);
    this._emit('  mv t1, gp');
    this._emit(`  addi gp, gp, ${objectSize}`);
    
    // Store length
    this._emit(`  li t2, ${len}`);
    this._emit('  sw t2, 0(t1)');
    
    // Store characters
    for (let i = 0; i < len; i++) {
      const code = chars.charCodeAt(i);
      this._emit(`  li t2, ${code}`);
      this._emit(`  sw t2, ${4 + i * 4}(t1)`);
    }
    
    // Result: string pointer in a0 (untagged — type tracked at compile time)
    this._emit('  mv a0, t1');
    this._lastExprType = 'string';
  }

  _compileHashLiteral(expr) {
    this._comment('hash literal');
    const pairs = [...expr.pairs]; // Convert Map to array of [key, value]
    const numPairs = pairs.length;
    // Hash layout: [HEADER][num_pairs (4)][key0 (4)][val0 (4)][key1 (4)][val1 (4)]...
    const objectSize = 4 + numPairs * 8;
    
    // Evaluate all keys and values, push to stack
    for (let i = 0; i < numPairs; i++) {
      const [key, value] = pairs[i];
      this._compileExpression(key);
      this._emit('  addi sp, sp, -4');
      this._emit('  sw a0, 0(sp)');
      this._compileExpression(value);
      this._emit('  addi sp, sp, -4');
      this._emit('  sw a0, 0(sp)');
    }
    
    // Emit object header and allocate on heap
    this._emitObjHeader(this.OBJ_TAG_HASH, objectSize);
    this._emit('  mv t1, gp');
    this._emit(`  addi gp, gp, ${objectSize}`);
    
    // Store num_pairs
    this._emit(`  li t2, ${numPairs}`);
    this._emit('  sw t2, 0(t1)');
    
    // Pop pairs from stack (in reverse order) and store
    for (let i = numPairs - 1; i >= 0; i--) {
      // Pop value
      this._emit('  lw t2, 0(sp)');
      this._emit('  addi sp, sp, 4');
      this._emit(`  sw t2, ${4 + i * 8 + 4}(t1)`); // value slot
      
      // Pop key
      this._emit('  lw t2, 0(sp)');
      this._emit('  addi sp, sp, 4');
      this._emit(`  sw t2, ${4 + i * 8}(t1)`); // key slot
    }
    
    // Result: hash pointer in a0
    this._emit('  mv a0, t1');
    this._lastExprType = 'hash';
  }

  /** Compile string equality/inequality comparison */
  _compileStringCompare(left, right, op) {
    this._comment(`string ${op}`);
    
    // Compile both strings
    this._compileExpression(left);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    this._compileExpression(right);
    this._emit('  lw t0, 0(sp)');     // t0 = left string ptr
    this._emit('  addi sp, sp, 4');
    this._emit('  mv t1, a0');        // t1 = right string ptr
    
    const equalLabel = this._label('streq');
    const notEqualLabel = this._label('strne');
    const endLabel = this._label('strcmp_end');
    
    // Compare lengths first
    this._emit('  lw t2, 0(t0)');     // t2 = left length
    this._emit('  lw t3, 0(t1)');     // t3 = right length
    this._emit(`  bne t2, t3, ${notEqualLabel}`);
    
    // Lengths match — compare chars
    this._emit('  li t4, 0');         // i = 0
    const charLoop = this._label('strcmp_loop');
    this._emitLabel(charLoop);
    this._emit(`  bge t4, t2, ${equalLabel}`);
    this._emit('  slli t5, t4, 2');
    this._emit('  add t5, t0, t5');
    this._emit('  lw t5, 4(t5)');     // left[i]
    this._emit('  slli t6, t4, 2');
    this._emit('  add t6, t1, t6');
    this._emit('  lw t6, 4(t6)');     // right[i]
    this._emit(`  bne t5, t6, ${notEqualLabel}`);
    this._emit('  addi t4, t4, 1');
    this._emit(`  j ${charLoop}`);
    
    // Equal
    this._emitLabel(equalLabel);
    this._emit(`  li a0, ${op === '==' ? 1 : 0}`);
    this._emit(`  j ${endLabel}`);
    
    // Not equal
    this._emitLabel(notEqualLabel);
    this._emit(`  li a0, ${op === '==' ? 0 : 1}`);
    
    this._emitLabel(endLabel);
    this._lastExprType = 'int';
  }

  _compileIndexExpression(left, index) {
    // Check if left is a hash
    const leftType = this._inferExprType(left);
    
    if (leftType === 'hash') {
      return this._compileHashAccess(left, index);
    }
    
    // Array/string indexing
    // Compile left (array/string pointer), push to stack
    this._compileExpression(left);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Compile index
    this._compileExpression(index);
    
    // Pop array pointer into t0
    this._emit('  lw t0, 0(sp)');
    this._emit('  addi sp, sp, 4');
    
    // Compute element address: base + 4 + index * 4
    this._emit('  slli a0, a0, 2');        // index * 4
    this._emit('  add a0, t0, a0');        // base + index * 4
    this._emit('  lw a0, 4(a0)');          // load [base + 4 + index * 4]
    this._lastExprType = 'unknown'; // Array elements can be any type (int, string, etc.)
  }

  _compileHashAccess(hashExpr, keyExpr) {
    this._comment('hash access');
    
    // Compile hash pointer
    this._compileExpression(hashExpr);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Compile key
    const keyType = this._inferExprType(keyExpr);
    this._compileExpression(keyExpr);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');
    
    // Pop key and hash pointer
    this._emit('  lw t0, 0(sp)');       // t0 = key
    this._emit('  lw t1, 4(sp)');       // t1 = hash pointer
    this._emit('  addi sp, sp, 8');
    
    // Linear scan: iterate through pairs
    this._emit('  lw t2, 0(t1)');       // t2 = num_pairs
    this._emit('  li t3, 0');           // t3 = i
    
    const scanLoop = this._label('hash_scan');
    const found = this._label('hash_found');
    const notFound = this._label('hash_notfound');
    
    this._emitLabel(scanLoop);
    this._emit(`  bge t3, t2, ${notFound}`);
    
    // Load key at index i
    this._emit('  slli t4, t3, 3');     // i * 8
    this._emit('  add t4, t1, t4');     // hash + i * 8
    this._emit('  lw t5, 4(t4)');       // key[i]
    
    if (keyType === 'string') {
      // String comparison via subroutine: a0=str1, a1=str2, returns a0=1 if equal
      this.needsStrEq = true;
      
      // Save loop context
      this._emit('  addi sp, sp, -20');
      this._emit('  sw t0, 0(sp)');   // search key
      this._emit('  sw t1, 4(sp)');   // hash ptr
      this._emit('  sw t2, 8(sp)');   // num_pairs
      this._emit('  sw t3, 12(sp)');  // loop index
      this._emit('  sw ra, 16(sp)');  // save ra for subroutine call
      
      // Call _str_eq(t0, t5) → result in a0
      this._emit('  mv a0, t0');      // a0 = search key
      this._emit('  mv a1, t5');      // a1 = candidate key
      this._emit('  jal _str_eq');
      
      // Restore loop context
      this._emit('  lw t0, 0(sp)');
      this._emit('  lw t1, 4(sp)');
      this._emit('  lw t2, 8(sp)');
      this._emit('  lw t3, 12(sp)');
      this._emit('  lw ra, 16(sp)');
      this._emit('  addi sp, sp, 20');
      
      // If a0 == 1, strings match → found
      this._emit(`  li t4, 1`);
      this._emit(`  beq a0, t4, ${found}`);
    } else {
      // Integer comparison
      this._emit(`  beq t0, t5, ${found}`);
    }
    
    this._emit('  addi t3, t3, 1');
    this._emit(`  j ${scanLoop}`);
    
    // Found: load value
    this._emitLabel(found);
    this._emit('  slli t4, t3, 3');
    this._emit('  add t4, t1, t4');
    this._emit('  lw a0, 8(t4)');       // value[i]
    const endLabel = this._label('hash_end');
    this._emit(`  j ${endLabel}`);
    
    // Not found: return 0 (null)
    this._emitLabel(notFound);
    this._emit('  li a0, 0');
    
    this._emitLabel(endLabel);
    this._lastExprType = 'unknown';
  }

  _compileTernary(expr) {
    this._comment('ternary');
    const falseLabel = this._label('ternary_false');
    const endLabel = this._label('ternary_end');
    this._compileExpression(expr.condition);
    this._emit(`  beqz a0, ${falseLabel}`);
    this._compileExpression(expr.consequence);
    this._emit(`  j ${endLabel}`);
    this._emitLabel(falseLabel);
    this._compileExpression(expr.alternative);
    this._emitLabel(endLabel);
  }

  _compileDoWhile(expr) {
    this._comment('do-while');
    const loopStart = this._label('dowhile_start');
    this._emitLabel(loopStart);
    if (expr.body?.statements) {
      for (const stmt of expr.body.statements) {
        this._compileStatement(stmt);
      }
    }
    this._compileExpression(expr.condition);
    this._emit(`  bnez a0, ${loopStart}`);
  }

  _compileSlice(expr) {
    this._comment('slice');
    this.needsAlloc = true;
    
    // Compile the array
    this._compileExpression(expr.left);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');   // save array ptr
    
    // Compile start index
    this._compileExpression(expr.start);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');   // save start
    
    // Compile end index
    this._compileExpression(expr.end);
    this._emit('  mv t2, a0');       // t2 = end
    this._emit('  lw t0, 0(sp)');    // t0 = start
    this._emit('  lw t1, 4(sp)');    // t1 = array ptr
    this._emit('  addi sp, sp, 8');
    
    // Calculate new length
    this._emit('  sub t3, t2, t0');   // t3 = end - start = new length
    
    // Allocate new array: [HEADER][length, elem0, elem1, ...]
    this._emit('  addi t4, t3, 1');   // t4 = length + 1 (for length field)
    this._emit('  slli t4, t4, 2');   // t4 *= 4 = object size
    // Emit GC header
    this._emit(`  addi t6, t4, 4`);
    this._emit(`  li t5, ${this.OBJ_TAG_ARRAY << 28}`);
    this._emit(`  or t6, t5, t6`);
    this._emit(`  sw t6, 0(gp)`);
    this._emit(`  addi gp, gp, 4`);
    this._emit('  mv t5, gp');        // t5 = new array ptr
    this._emit('  add gp, gp, t4');   // bump allocator
    
    // Store length
    this._emit('  sw t3, 0(t5)');
    
    // Copy elements
    this._emit('  li t4, 0');         // i = 0
    const copyLoop = this._label('slice_copy');
    const copyEnd = this._label('slice_end');
    this._emitLabel(copyLoop);
    this._emit(`  bge t4, t3, ${copyEnd}`);
    this._emit('  add t6, t0, t4');   // src index = start + i
    this._emit('  addi t6, t6, 1');   // +1 for length field
    this._emit('  slli t6, t6, 2');
    this._emit('  add t6, t1, t6');
    this._emit('  lw a0, 0(t6)');     // load src element
    this._emit('  addi a1, t4, 1');   // dst index = i + 1 (for length field)
    this._emit('  slli a1, a1, 2');
    this._emit('  add a1, t5, a1');
    this._emit('  sw a0, 0(a1)');     // store dst element
    this._emit('  addi t4, t4, 1');
    this._emit(`  j ${copyLoop}`);
    this._emitLabel(copyEnd);
    
    // Result: pointer to new array
    this._emit('  mv a0, t5');
    this._lastExprType = 'array';
  }

  _compileForExpr(expr) {
    this._comment('for');
    // Init
    if (expr.init) {
      this._compileStatement(expr.init);
    }
    const loopStart = this._label('for_start');
    const loopEnd = this._label('for_end');
    this._emitLabel(loopStart);
    // Condition
    if (expr.condition) {
      this._compileExpression(expr.condition);
      this._emit(`  beqz a0, ${loopEnd}`);
    }
    // Body
    if (expr.body?.statements) {
      for (const stmt of expr.body.statements) {
        this._compileStatement(stmt);
      }
    }
    // Update
    if (expr.update) {
      this._compileStatement(expr.update);
    }
    this._emit(`  j ${loopStart}`);
    this._emitLabel(loopEnd);
  }

  _compileSwitchExpr(expr) {
    this._comment('switch');
    const endLabel = this._label('switch_end');
    
    // Compile switch value
    this._compileExpression(expr.value);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');  // Save switch value
    
    // Generate case branches
    for (const c of expr.cases) {
      const nextCase = this._label('switch_next');
      
      // Load switch value
      this._emit('  lw t0, 0(sp)');
      // Compile case value
      this._compileExpression(c.value);
      // Compare
      this._emit(`  bne t0, a0, ${nextCase}`);
      
      // Match! Execute body
      this._compileExpression(c.body);
      this._emit(`  j ${endLabel}`);
      
      this._emitLabel(nextCase);
    }
    
    // Default case
    if (expr.defaultCase) {
      this._compileExpression(expr.defaultCase);
    }
    
    this._emitLabel(endLabel);
    this._emit('  addi sp, sp, 4');  // Restore stack
  }

  _compileForIn(expr) {
    this._comment(`for (${expr.variable} in ...)`);
    const uid = this.labelCount++;
    const loopLabel = this._label('forin');
    const endLabel = this._label('endforin');
    const arrName = `__forin_arr_${uid}`;
    const idxName = `__forin_idx_${uid}`;
    
    // Compile iterable (array pointer → a0)
    this._compileExpression(expr.iterable);
    
    // Save array pointer to a stack slot
    this._allocLocal(arrName);
    this._emitStoreVar(arrName);
    
    // Allocate loop counter
    this._allocLocal(idxName);
    this._emit('  li a0, 0');
    this._emitStoreVar(idxName);
    
    // Allocate loop variable
    this._allocLocal(expr.variable);
    
    // Loop start
    this._emitLabel(loopLabel);
    
    // Check: idx < len(arr)
    this._emitLoadVar(idxName);
    this._emit('  addi sp, sp, -4');
    this._emit('  sw a0, 0(sp)');       // push idx
    this._emitLoadVar(arrName);
    this._emit('  lw a0, 0(a0)');       // a0 = len(arr)
    this._emit('  lw t0, 0(sp)');       // t0 = idx
    this._emit('  addi sp, sp, 4');
    this._emit('  slt a0, t0, a0');     // a0 = (idx < len)
    this._emit(`  beqz a0, ${endLabel}`);
    
    // Load arr[idx] into loop variable
    this._emitLoadVar(arrName);
    this._emit('  mv t1, a0');          // t1 = arr pointer
    this._emitLoadVar(idxName);
    this._emit('  slli a0, a0, 2');     // idx * 4
    this._emit('  add a0, t1, a0');     // arr + idx * 4
    this._emit('  lw a0, 4(a0)');       // arr[idx]
    this._emitStoreVar(expr.variable);
    
    // Execute body
    this._compileBlock(expr.body);
    
    // Increment index
    this._emitLoadVar(idxName);
    this._emit('  addi a0, a0, 1');
    this._emitStoreVar(idxName);
    
    this._emit(`  j ${loopLabel}`);
    this._emitLabel(endLabel);
  }

  /** Compile a function literal as an expression (closure creation) */
  _compileFunctionLiteralExpr(funcLit, bindingName = null) {
    const closureLabel = this._label('closure_fn');
    this._comment(`closure ${closureLabel}`);
    
    // Identify free variables using closure analysis
    const freeVars = this._closureInfo?.get(funcLit) || [];
    
    // Allocate closure object on heap: [HEADER][fn_id (4)] [num_captured (4)] [var0 (4)] [var1 (4)] ...
    const closureSize = 8 + freeVars.length * 4;
    this._emitObjHeader(this.OBJ_TAG_CLOSURE, closureSize);
    this._emit('  mv t1, gp');
    this._emit(`  addi gp, gp, ${closureSize}`);
    
    // Store closure function ID (we'll use the label index for dispatch)
    this._closureLabels = this._closureLabels || [];
    const closureId = this._closureLabels.length;
    this._closureLabels.push(closureLabel);
    this._emit(`  li t2, ${closureId}`);
    this._emit('  sw t2, 0(t1)');
    
    // Store number of captured variables
    this._emit(`  li t2, ${freeVars.length}`);
    this._emit('  sw t2, 4(t1)');
    
    // Capture current values of free variables
    for (let i = 0; i < freeVars.length; i++) {
      this._emitLoadVar(freeVars[i]);
      this._emit(`  sw a0, ${8 + i * 4}(t1)`);
    }
    
    // Compile the function body as a deferred function
    const savedOutput = this.output;
    const savedVars = new Map(this.variables);
    const savedOffset = this.stackOffset;
    const savedNextReg = this.nextRegIdx;
    const savedUsedRegs = new Set(this.usedRegs);
    const savedVarTypes = new Map(this.varTypes);
    const savedPrologueSaveIdx = this._prologueSaveIdx;
    
    this.output = [];
    this.variables = new Map();
    this.stackOffset = 8;
    this.nextRegIdx = 0;
    this.usedRegs = new Set();
    this.varTypes = new Map();
    
    this._emitLabel(closureLabel);
    this._emitPrologue();
    
    // First implicit parameter: closure environment pointer (in a0)
    const envName = '__closure_env';
    this._allocLocal(envName);
    this._emitStoreVar(envName);
    
    // Map captured variables to environment offsets
    for (let i = 0; i < freeVars.length; i++) {
      // Create a "virtual" local that loads from the env object
      const capturedName = freeVars[i];
      this._allocLocal(capturedName);
      // Load from env: env_ptr + 8 + i * 4
      this._emitLoadVar(envName);
      this._emit(`  lw a0, ${8 + i * 4}(a0)`);
      this._emitStoreVar(capturedName);
      this.varTypes.set(capturedName, savedVarTypes.get(capturedName) || 'unknown');
    }
    
    // Map explicit parameters (shifted by 1 for env pointer)
    if (funcLit.parameters) {
      for (let i = 0; i < funcLit.parameters.length; i++) {
        const paramName = funcLit.parameters[i].value;
        this._allocLocal(paramName);
        const loc = this._lookupVar(paramName);
        if (loc.type === 'reg') {
          this._emit(`  mv ${loc.reg}, a${i + 1}`); // shifted by 1
        } else {
          this._emit(`  sw a${i + 1}, ${loc.offset}(s0)`);
        }

    // Add self-reference for recursive closures
    if (bindingName) {
      // Store the closure's environment pointer as a self-reference
      // So recursive calls go through closure dispatch (which handles env correctly)
      this._allocLocal(bindingName);
      this._emitLoadVar(envName);
      this._emitStoreVar(bindingName);
      this.varTypes.set(bindingName, 'closure');
    }
    
    // Copy function labels from outer scope
    for (const [varName, varInfo] of savedVars) {
      if (varInfo.type === 'func' && !this.variables.has(varName)) {
        this.variables.set(varName, varInfo);
      }
    }
      }
    }
    
    // Compile body
    let hasReturn = false;
    if (funcLit.body?.statements) {
      for (const stmt of funcLit.body.statements) {
        this._compileStatement(stmt);
        if (stmt.constructor.name === 'ReturnStatement') {
          hasReturn = true;
          break;
        }
      }
    }
    
    if (!hasReturn) {
      this._emitEpilogue();
      this._emit('  ret');
    }
    
    this._patchPrologueSaves();
    const funcBody = this.output;
    
    // Restore state
    this.output = savedOutput;
    this.variables = savedVars;
    this.stackOffset = savedOffset;
    this.nextRegIdx = savedNextReg;
    this.usedRegs = savedUsedRegs;
    this.varTypes = savedVarTypes;
    this._prologueSaveIdx = savedPrologueSaveIdx;
    
    this.functions.push(funcBody);
    
    // Result: closure pointer in a0
    this._emit('  mv a0, t1');
    this._lastExprType = 'closure';
  }

  _compileCallExpression(expr) {
    const funcName = expr.function.value || expr.function.toString();
    
    // Special case: puts() → print_int or print_string
    if (funcName === 'puts') {
      this._comment('puts()');
      if (expr.arguments.length > 0) {
        this._compileExpression(expr.arguments[0]);
        const exprType = this._lastExprType;
        
        if (exprType === 'string') {
          // String: a0 has heap pointer, print chars
          this._emitPrintString();
        } else if (exprType === 'unknown') {
          // Runtime type dispatch: check if a0 is a valid heap pointer
          // Valid heap: a0 >= heap_base (0x10000) AND a0 < gp (current heap top)
          const isStr = this._label('puts_is_str');
          const putsEnd = this._label('puts_end');
          this._emit('  li t0, 65536');  // heap_base = 0x10000
          this._emit(`  blt a0, t0, ${putsEnd}_int`);  // below heap → integer
          this._emit(`  bge a0, gp, ${putsEnd}_int`);   // above allocated heap → integer
          this._emit(`  j ${isStr}`);
          this._emitLabel(`${putsEnd}_int`);
          // Must be integer
          this._emit('  li a7, 1');
          this._emit('  ecall');
          this._emit(`  j ${putsEnd}`);
          this._emitLabel(isStr);
          this._emitPrintString();
          this._emitLabel(putsEnd);
        } else {
          // Integer (default): print as number
          this._emit('  li a7, 1');          // print_int
          this._emit('  ecall');
        }
      }
      return;
    }
    
    // Special case: len() → load length from header
    if (funcName === 'len') {
      this._comment('len()');
      if (expr.arguments.length > 0) {
        this._compileExpression(expr.arguments[0]);
        this._emit('  lw a0, 0(a0)');  // Load length from header
      }
      this._lastExprType = 'int'; // length is always an integer
      return;
    }
    
    // Special case: first() → arr[0]
    if (funcName === 'first') {
      this._comment('first()');
      if (expr.arguments.length > 0) {
        this._compileExpression(expr.arguments[0]);
        this._emit('  lw a0, 4(a0)');  // Load first element
      }
      this._lastExprType = 'int'; // element type unknown, assume int
      return;
    }
    
    // Special case: last() → arr[len-1]
    if (funcName === 'last') {
      this._comment('last()');
      if (expr.arguments.length > 0) {
        this._compileExpression(expr.arguments[0]);
        this._emit('  mv t0, a0');
        this._emit('  lw t1, 0(t0)');
        this._emit('  slli t1, t1, 2');
        this._emit('  add t0, t0, t1');
        this._emit('  lw a0, 0(t0)');
      }
      this._lastExprType = 'int';
      return;
    }
    
    // Special case: push() → create new array with element appended
    if (funcName === 'push') {
      this._comment('push()');
      this.needsAlloc = true;
      if (expr.arguments.length >= 2) {
        // Compile array arg
        this._compileExpression(expr.arguments[0]);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');     // push old array pointer
        
        // Compile element to push
        this._compileExpression(expr.arguments[1]);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');     // push new element
        
        // Pop element and old array
        this._emit('  lw t2, 0(sp)');     // t2 = new element
        this._emit('  lw t0, 4(sp)');     // t0 = old array
        this._emit('  addi sp, sp, 8');
        
        // Get old length
        this._emit('  lw t1, 0(t0)');     // t1 = old length
        
        // Allocate new array: [HEADER] + (length + 1 + 1) * 4 bytes (length word + old elements + new)
        this._emit('  addi t3, t1, 1');   // t3 = new length
        this._emit('  addi t4, t3, 1');   // t4 = new length + 1 (length word)
        this._emit('  slli t4, t4, 2');   // t4 * 4 = object size
        // Emit GC header
        this._emit(`  addi t6, t4, 4`);
        this._emit(`  li a0, ${this.OBJ_TAG_ARRAY << 28}`);
        this._emit(`  or t6, a0, t6`);
        this._emit(`  sw t6, 0(gp)`);
        this._emit(`  addi gp, gp, 4`);
        this._emit('  mv a0, gp');        // new array base (past header)
        this._emit('  add gp, gp, t4');   // bump allocator
        
        // Store new length
        this._emit('  sw t3, 0(a0)');     // [new_arr] = new_length
        
        // Copy old elements
        this._emit('  li t4, 0');         // i = 0
        const copyLoop = this._label('push_copy');
        const copyEnd = this._label('push_copy_end');
        this._emitLabel(copyLoop);
        this._emit('  bge t4, t1, ' + copyEnd);
        this._emit('  slli t5, t4, 2');   // i * 4
        this._emit('  add t5, t0, t5');   // old_arr + i * 4
        this._emit('  lw t6, 4(t5)');     // old_arr[i]
        this._emit('  slli t5, t4, 2');
        this._emit('  add t5, a0, t5');   // new_arr + i * 4
        this._emit('  sw t6, 4(t5)');     // new_arr[i] = old_arr[i]
        this._emit('  addi t4, t4, 1');
        this._emit('  j ' + copyLoop);
        this._emitLabel(copyEnd);
        
        // Store new element at end
        this._emit('  slli t5, t1, 2');   // old_length * 4
        this._emit('  add t5, a0, t5');   // new_arr + old_length * 4
        this._emit('  sw t2, 4(t5)');     // new_arr[old_length] = new_element
        
        // a0 already has new array pointer
      }
      return;
    }
    
    // General function call
    this._comment(`call ${funcName}`);
    
    // Check if this is a closure call (variable of type 'closure')
    const callerType = this.varTypes.get(funcName);
    const isClosure = callerType === 'closure';
    
    // Push current temp registers to save them
    // Compile arguments into a0-a7
    const args = expr.arguments;
    if (args.length > (isClosure ? 7 : 8)) {
      this.errors.push(`Too many arguments (max ${isClosure ? 7 : 8}): ${args.length}`);
      return;
    }
    
    if (isClosure) {
      // Closure call: first arg is the closure environment pointer
      // Evaluate all args first, save on stack
      for (let i = 0; i < args.length; i++) {
        this._compileExpression(args[i]);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');
      }
      
      // Load closure pointer
      this._emitLoadVar(funcName);
      this._emit('  addi sp, sp, -4');
      this._emit('  sw a0, 0(sp)');
      
      // Pop closure pointer into a0 (first arg = env)
      this._emit('  lw a0, 0(sp)');
      // Pop regular args into a1, a2, ...
      for (let i = args.length - 1; i >= 0; i--) {
        this._emit(`  lw a${i + 1}, ${(args.length - i) * 4}(sp)`);
      }
      this._emit(`  addi sp, sp, ${(args.length + 1) * 4}`);
      
      // Get the closure function label from the closure labels table
      // Use direct call if we know the label, otherwise use dispatch
      const closureLabel = this._varClosureLabels?.get(funcName);
      if (closureLabel) {
        this._emit(`  jal ${closureLabel}`);
      } else {
        // Use closure dispatch trampoline
        this.needsClosureDispatch = true;
        this._emit('  jal _closure_dispatch');
      }
    } else {
      // Check if this is a variable that might hold a closure
      const varInfo = this._lookupVar(funcName);
      const isVarClosure = varInfo && (varInfo.type === 'stack' || varInfo.type === 'reg');
      
      if (isVarClosure) {
        // Variable-based closure call: load closure ptr, call through dispatch
        this._comment(`indirect closure call via ${funcName}`);
        this.needsClosureDispatch = true;
        
        // Evaluate args first, save on stack
        for (let i = 0; i < args.length; i++) {
          this._compileExpression(args[i]);
          this._emit('  addi sp, sp, -4');
          this._emit('  sw a0, 0(sp)');
        }
        
        // Load closure pointer
        this._emitLoadVar(funcName);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');
        
        // Pop closure pointer into a0 (env)
        this._emit('  lw a0, 0(sp)');
        // Pop regular args into a1, a2, ...
        for (let i = args.length - 1; i >= 0; i--) {
          this._emit(`  lw a${i + 1}, ${(args.length - i) * 4}(sp)`);
        }
        this._emit(`  addi sp, sp, ${(args.length + 1) * 4}`);
        
        // Call the closure dispatch trampoline
        // a0 = closure pointer (env), a1+ = args
        this._emit('  jal _closure_dispatch');
      } else {
      // Regular function call
      // Evaluate args and save on stack
      for (let i = 0; i < args.length; i++) {
        this._compileExpression(args[i]);
        this._emit('  addi sp, sp, -4');
        this._emit('  sw a0, 0(sp)');
      }
      
      // Pop into argument registers (reverse order)
      for (let i = args.length - 1; i >= 0; i--) {
        this._emit(`  lw a${i}, ${(args.length - 1 - i) * 4}(sp)`);
      }
      this._emit(`  addi sp, sp, ${args.length * 4}`);
      
      // Call the function
      this._emit(`  jal ${funcName}`);
      }
    }
    // Result is in a0
    // Check if we know the return type
    if (this._typeInfo?.funcTypes?.has(funcName)) {
      this._lastExprType = this._typeInfo.funcTypes.get(funcName).returnType || 'unknown';
    } else {
      this._lastExprType = 'unknown';
    }
  }

  _compileFunctionDef(name, funcLit) {
    this._comment(`function ${name} (deferred)`);
    
    // Save function label for calls
    this.variables.set(name, { type: 'func', label: name });
    
    // Generate function body (deferred — appended after main)
    const savedOutput = this.output;
    const savedVars = new Map(this.variables);
    const savedOffset = this.stackOffset;
    const savedNextReg = this.nextRegIdx;
    const savedUsedRegs = new Set(this.usedRegs);
    const savedPrologueSaveIdx2 = this._prologueSaveIdx;
    
    this.output = [];
    this.variables = new Map();
    this.stackOffset = 8; // Reserve for ra + s0
    this.nextRegIdx = 0;
    this.usedRegs = new Set();
    
    // Add self-reference for recursive calls
    this.variables.set(name, { type: 'func', label: name });
    
    // Copy all function labels from outer scope (for cross-function calls)
    for (const [varName, varInfo] of savedVars) {
      if (varInfo.type === 'func') {
        this.variables.set(varName, varInfo);
      }
    }
    
    // Track current function for tail call optimization
    const savedCurrentFunc = this._currentFuncName;
    const savedCurrentFuncParams = this._currentFuncParams;
    this._currentFuncName = name;
    this._currentFuncParams = funcLit.parameters || [];
    
    this._emitLabel(name);
    this._emitPrologue();
    // TCO entry point: after prologue, before param setup
    this._emitLabel(`${name}_tco_entry`);
    
    // Map parameters to storage (registers or stack)
    if (funcLit.parameters) {
      for (let i = 0; i < funcLit.parameters.length; i++) {
        const paramName = funcLit.parameters[i].value;
        this._allocLocal(paramName);
        // Store from argument register to allocated location
        const loc = this._lookupVar(paramName);
        if (loc.type === 'reg') {
          this._emit(`  mv ${loc.reg}, a${i}`);
        } else {
          this._emit(`  sw a${i}, ${loc.offset}(s0)`);
        }
        // Apply inferred parameter type
        if (this._typeInfo?.funcTypes?.has(name)) {
          const funcInfo = this._typeInfo.funcTypes.get(name);
          const paramType = funcInfo.params.get(paramName);
          if (paramType) {
            this.varTypes.set(paramName, paramType);
          }
        }
      }
    }
    
    // Compile body
    let hasReturn = false;
    if (funcLit.body && funcLit.body.statements) {
      for (const stmt of funcLit.body.statements) {
        this._compileStatement(stmt);
        if (stmt.constructor.name === 'ReturnStatement') {
          hasReturn = true;
          break;
        }
      }
    }
    
    // Default epilogue (if no explicit return)
    if (!hasReturn) {
      this._emitEpilogue();
      this._emit('  ret');
    }
    
    // Patch prologue saves for this function
    this._patchPrologueSaves();
    
    const funcBody = this.output;
    
    // Restore state
    this.output = savedOutput;
    this.variables = savedVars;
    this.stackOffset = savedOffset;
    this.nextRegIdx = savedNextReg;
    this.usedRegs = savedUsedRegs;
    this._currentFuncName = savedCurrentFunc;
    this._currentFuncParams = savedCurrentFuncParams;
    this._prologueSaveIdx = savedPrologueSaveIdx2;
    
    this.functions.push(funcBody);
  }
}
