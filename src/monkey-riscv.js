#!/usr/bin/env node
// monkey-riscv.js — Monkey-lang → RISC-V Compilation CLI
//
// Usage:
//   node monkey-riscv.js <file.monkey>           # Compile and run
//   node monkey-riscv.js --dump <file.monkey>     # Show assembly listing
//   node monkey-riscv.js --disasm <file.monkey>   # Show disassembly
//   node monkey-riscv.js --run <file.monkey>      # Compile, assemble, and execute
//   node monkey-riscv.js --opt <file.monkey>      # Compile with register allocation + peephole
//   node monkey-riscv.js -e "puts(42)"            # Compile expression

import { readFileSync } from 'fs';
import { Lexer } from '/Users/henry/repos/monkey-lang/src/lexer.js';
import { Parser } from '/Users/henry/repos/monkey-lang/src/parser.js';
import { RiscVCodeGen } from './monkey-codegen.js';
import { inferTypes } from './type-infer.js';
import { analyzeFreeVars } from './closure-analysis.js';
import { peepholeOptimize } from './riscv-peephole.js';
import { Assembler } from './assembler.js';
import { CPU } from './cpu.js';
import { disassemble, disassembleWord } from './disassembler.js';

function compilePipeline(source, { useRegisters = false, optimize = false } = {}) {
  // Parse
  const lexer = new Lexer(source);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) {
    console.error('Parse errors:');
    parser.errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }

  // Type inference
  const typeInfo = inferTypes(program);
  const closureInfo = analyzeFreeVars(program);

  // Code generation
  const codegen = new RiscVCodeGen({ useRegisters });
  let asm = codegen.compile(program, typeInfo, closureInfo);
  if (codegen.errors.length > 0) {
    console.error('Codegen errors:');
    codegen.errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }

  // Peephole optimization
  let peepholeStats = null;
  if (optimize) {
    const result = peepholeOptimize(asm);
    asm = result.optimized;
    peepholeStats = result.stats;
  }

  // Assemble
  const assembler = new Assembler();
  const assembled = assembler.assemble(asm);
  if (assembled.errors.length > 0) {
    console.error('Assembly errors:');
    assembled.errors.forEach(e => console.error('  ' + (e.message || e)));
    process.exit(1);
  }

  return { asm, words: assembled.words, labels: assembled.labels, typeInfo, closureInfo, peepholeStats };
}

// Parse args
const args = process.argv.slice(2);
let mode = 'run';
let source = null;
let optimize = false;
let useStdlib = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dump': mode = 'dump'; break;
    case '--disasm': mode = 'disasm'; break;
    case '--run': mode = 'run'; break;
    case '--opt': optimize = true; break;
    case '--stdlib': useStdlib = true; break;
    case '--repl':
    case '-i': break; // handled later
    case '-e': source = args[++i]; break;
    default:
      if (!args[i].startsWith('-')) {
        source = readFileSync(args[i], 'utf-8');
      }
  }
}

// Load stdlib if requested
if (useStdlib && source) {
  const stdlibPath = new URL('./stdlib.monkey', import.meta.url).pathname;
  const stdlib = readFileSync(stdlibPath, 'utf-8');
  source = stdlib + '\n' + source;
}

if (!source) {
  // Check if REPL mode
  if (args.includes('--repl') || args.includes('-i')) {
    startREPL(optimize);
  } else {
    console.log('Usage: node monkey-riscv.js [--dump|--disasm|--run|--opt|--repl] [-e expr | file.monkey]');
    console.log('  --repl / -i  Interactive REPL mode');
    process.exit(0);
  }
} else {

const { asm, words, labels, typeInfo, closureInfo, peepholeStats } = compilePipeline(source, { 
  useRegisters: optimize, 
  optimize 
});

switch (mode) {
  case 'dump':
    console.log('=== Monkey → RISC-V Assembly ===');
    console.log(asm);
    if (peepholeStats) {
      console.log('\n=== Peephole Stats ===');
      console.log(`  Removed: ${peepholeStats.removed} instructions`);
      console.log(`  Patterns: ${JSON.stringify(peepholeStats.patterns)}`);
    }
    console.log(`\n${words.length} words (${words.length * 4} bytes)`);
    break;

  case 'disasm':
    console.log('=== RISC-V Machine Code Disassembly ===');
    console.log(disassemble(words));
    console.log(`\n${words.length} words (${words.length * 4} bytes)`);
    break;

  case 'run':
  default:
    const cpu = new CPU();
    cpu.loadProgram(words);
    cpu.regs.set(2, 0x100000 - 4);
    const start = performance.now();
    cpu.run(10000000);
    const elapsed = performance.now() - start;
    
    if (cpu.output.length > 0) {
      process.stdout.write(cpu.output.join(''));
      if (!cpu.output[cpu.output.length - 1].endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
    
    console.error(`[${cpu.cycles} cycles, ${elapsed.toFixed(1)}ms, ${words.length} instructions]`);
    break;
}
}

// --- REPL Mode ---

async function startREPL(optimize) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'monkey-rv> ',
  });

  console.log('🐒 Monkey → RISC-V REPL');
  console.log('Type monkey-lang code and press Enter to compile and run.');
  console.log('Commands: .dump .stdlib .bench .clear .help .quit\n');

  let buffer = '';
  let braceCount = 0;
  let showAsm = false;
  let useStdlib = false;
  // Accumulated definitions for persistent context
  let definitions = '';
  
  // Load stdlib
  try {
    const stdlibPath = new URL('./stdlib.monkey', import.meta.url).pathname;
    const stdlibContent = readFileSync(stdlibPath, 'utf-8');
    definitions = stdlibContent + '\n';
    useStdlib = true;
    console.log('📚 Standard library loaded (30+ functions available)');
    console.log('   Try: puts(sum(range(1, 11)))  →  55\n');
  } catch(e) {
    console.log('⚠️  stdlib.monkey not found — .stdlib to retry\n');
  }

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();

    // Commands
    if (trimmed === '.quit' || trimmed === '.exit') {
      console.log('Goodbye! 🦀');
      rl.close();
      process.exit(0);
    }
    if (trimmed === '.dump') {
      showAsm = !showAsm;
      console.log(`Assembly display: ${showAsm ? 'ON' : 'OFF'}`);
      rl.prompt();
      return;
    }
    if (trimmed === '.clear') {
      definitions = '';
      console.log('Context cleared.');
      rl.prompt();
      return;
    }
    if (trimmed === '.help') {
      console.log('Commands:');
      console.log('  .dump    Toggle assembly display');
      console.log('  .bench   Run quick benchmark (fib(20))');
      console.log('  .clear   Clear accumulated definitions');
      console.log('  .quit    Exit REPL');
      rl.prompt();
      return;
    }

    if (trimmed === '.bench') {
      const benchCode = definitions + 'let fib = fn(n) { if (n <= 1) { return n }; return fib(n-1) + fib(n-2) }; puts(fib(20))';
      try {
        const result = compilePipeline(benchCode, { useRegisters: optimize, optimize });
        const cpu = new CPU();
        cpu.loadProgram(result.words);
        cpu.regs.set(2, 0x100000 - 4);
        const start = performance.now();
        cpu.run(10000000);
        const elapsed = performance.now() - start;
        console.log(`\x1b[32mfib(20) = ${cpu.output.join('')}\x1b[0m`);
        console.log(`\x1b[90m[${cpu.cycles.toLocaleString()} cycles, ${elapsed.toFixed(1)}ms, ${result.words.length} instrs]\x1b[0m`);
      } catch(e) {
        console.log(`\x1b[31mBenchmark error: ${e.message}\x1b[0m`);
      }
      rl.prompt();
      return;
    }

    // Multi-line support
    buffer += line + '\n';
    braceCount += (line.match(/{/g) || []).length;
    braceCount -= (line.match(/}/g) || []).length;

    if (braceCount > 0) {
      // Waiting for closing braces
      process.stdout.write('...       ');
      return;
    }

    // Complete expression — compile and run
    const code = buffer.trim();
    buffer = '';
    braceCount = 0;

    if (!code) {
      rl.prompt();
      return;
    }

    try {
      // Prepend accumulated definitions
      const fullCode = definitions + code;
      
      const result = compilePipeline(fullCode, { useRegisters: optimize, optimize });

      if (showAsm) {
        console.log('\x1b[90m--- Assembly ---\x1b[0m');
        console.log('\x1b[90m' + result.asm + '\x1b[0m');
      }

      // Run
      const cpu = new CPU();
      cpu.loadProgram(result.words);
      cpu.regs.set(2, 0x100000 - 4);
      const start = performance.now();
      cpu.run(10000000);
      const elapsed = performance.now() - start;

      if (cpu.output.length > 0) {
        console.log('\x1b[32m' + cpu.output.join('') + '\x1b[0m');
      }

      console.log(`\x1b[90m[${cpu.cycles} cycles, ${elapsed.toFixed(1)}ms, ${result.words.length} instrs]\x1b[0m`);

      // If the code defines functions or variables, accumulate it
      if (code.includes('let ')) {
        definitions += code + '\n';
      }
    } catch (e) {
      console.log(`\x1b[31mError: ${e.message}\x1b[0m`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
