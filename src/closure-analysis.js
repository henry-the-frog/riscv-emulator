// closure-analysis.js — Free variable analysis for monkey-lang closures
//
// Walks the AST to identify which variables nested functions reference
// from their enclosing scope. These are "free variables" that need to
// be captured in a closure object.
//
// Example:
//   let x = 10
//   let add_x = fn(y) { x + y }
//   → add_x has free variable: x
//
//   let make_adder = fn(x) { fn(y) { x + y } }
//   → inner fn has free variable: x (from make_adder's parameter)

/**
 * Analyze a program for closures and free variables.
 * @param {Program} program
 * @returns {Map<FunctionLiteral, string[]>} Map from function nodes to their free variables
 */
export function analyzeFreeVars(program) {
  const result = new Map(); // FunctionLiteral → [free var names]
  
  // Walk program, tracking scope
  const globalScope = new Set();
  const globalFunctions = new Set(); // Track which globals are functions
  
  // First pass: collect global bindings
  for (const stmt of program.statements) {
    if (stmt.constructor.name === 'LetStatement') {
      globalScope.add(stmt.name.value);
      if (stmt.value?.constructor.name === 'FunctionLiteral') {
        globalFunctions.add(stmt.name.value);
      }
    }
  }
  
  // Second pass: analyze each function
  for (const stmt of program.statements) {
    if (stmt.constructor.name === 'LetStatement' && 
        stmt.value?.constructor.name === 'FunctionLiteral') {
      analyzeFunction(stmt.value, globalScope, result, stmt.name.value, globalFunctions);
    }
    // Also scan for anonymous FunctionLiterals in expression statements
    const anonFuncs = [];
    collectFunctionLiterals(stmt, anonFuncs);
    for (const funcLit of anonFuncs) {
      // Skip already-processed let-bound functions
      if (stmt.constructor.name === 'LetStatement' && stmt.value === funcLit) continue;
      // Skip named functions already in globalFunctions
      if (result.has(funcLit)) continue;
      analyzeFunction(funcLit, globalScope, result, null, globalFunctions);
    }
  }
  
  return result;
}

/**
 * Analyze a function for free variables, recursively handling nested functions.
 * @param {FunctionLiteral} funcLit
 * @param {Set<string>} outerScope - Variables available in the enclosing scope
 * @param {Map} result - Accumulator for results
 * @param {string} funcName - Name of this function (for self-reference)
 */
function analyzeFunction(funcLit, outerScope, result, funcName = null, globalFunctions = new Set()) {
  // Build this function's local scope
  const localScope = new Set();
  
  // Parameters are local
  for (const param of (funcLit.parameters || [])) {
    localScope.add(param.value);
  }
  
  // Walk body to find let statements and nested functions
  if (funcLit.body?.statements) {
    for (const stmt of funcLit.body.statements) {
      if (stmt.constructor.name === 'LetStatement') {
        // Check if it's a nested function
        if (stmt.value?.constructor.name === 'FunctionLiteral') {
          // Analyze nested function with combined scope
          const combinedScope = new Set([...outerScope, ...localScope]);
          if (funcName) combinedScope.add(funcName); // Self-reference
          analyzeFunction(stmt.value, combinedScope, result, stmt.name.value, globalFunctions);
        }
        localScope.add(stmt.name.value);
      }
      // Check for return statements or expression statements containing function literals
      const funcLits = [];
      collectFunctionLiterals(stmt, funcLits);
      for (const nestedFunc of funcLits) {
        // Skip already-processed let-bound functions
        if (stmt.constructor.name === 'LetStatement' && stmt.value === nestedFunc) continue;
        const combinedScope = new Set([...outerScope, ...localScope]);
        if (funcName) combinedScope.add(funcName);
        analyzeFunction(nestedFunc, combinedScope, result, null, globalFunctions);
      }
    }
  }
  
  // Now find all identifier references in this function's body
  const referenced = new Set();
  collectIdentifiers(funcLit.body, referenced);
  
  // Transitive propagation: if nested functions capture vars from beyond our scope,
  // we need to capture and pass those vars too
  const transitiveVars = new Set();
  // Check all nested function results
  const allFuncLits = [];
  collectFunctionLiterals(funcLit.body, allFuncLits);
  for (const nestedFunc of allFuncLits) {
    const nestedFree = result.get(nestedFunc);
    if (nestedFree) {
      for (const v of nestedFree) {
        if (!localScope.has(v) && outerScope.has(v)) {
          transitiveVars.add(v);
        }
      }
    }
  }
  
  // Free variables = referenced but not in local scope and not builtins
  const builtins = new Set(['puts', 'len', 'first', 'last', 'push', 'true', 'false']);
  const freeVars = [];
  
  for (const name of referenced) {
    if (!localScope.has(name) && !builtins.has(name) && name !== funcName && !globalFunctions.has(name)) {
      // It's a free variable if it's in the outer scope
      if (outerScope.has(name)) {
        freeVars.push(name);
      }
    }
  }
  
  // Add transitive vars
  for (const v of transitiveVars) {
    if (!freeVars.includes(v)) {
      freeVars.push(v);
    }
  }
  
  // Only record if there are actual free variables
  if (freeVars.length > 0) {
    result.set(funcLit, freeVars);
  }
  
  return freeVars;
}

/**
 * Collect all FunctionLiteral nodes in a subtree (but don't recurse into them).
 */
function collectFunctionLiterals(node, results) {
  if (!node) return;
  if (node.constructor.name === 'FunctionLiteral') {
    results.push(node);
    return; // Don't recurse into the function itself
  }
  if (node.statements) for (const s of node.statements) collectFunctionLiterals(s, results);
  if (node.expression) collectFunctionLiterals(node.expression, results);
  if (node.value) collectFunctionLiterals(node.value, results);
  if (node.left) collectFunctionLiterals(node.left, results);
  if (node.right) collectFunctionLiterals(node.right, results);
  if (node.consequence) collectFunctionLiterals(node.consequence, results);
  if (node.alternative) collectFunctionLiterals(node.alternative, results);
  if (node.body) collectFunctionLiterals(node.body, results);
  if (node.function) collectFunctionLiterals(node.function, results);
  if (node.arguments) for (const a of node.arguments) collectFunctionLiterals(a, results);
  if (node.returnValue) collectFunctionLiterals(node.returnValue, results);
}

/**
 * Collect all Identifier references in a subtree.
 */
function collectIdentifiers(node, identifiers) {
  if (!node) return;
  
  if (node.constructor.name === 'Identifier') {
    identifiers.add(node.value);
    return;
  }
  
  // Don't recurse into nested FunctionLiterals — they have their own scope
  if (node.constructor.name === 'FunctionLiteral') return;
  
  // Recurse into all child nodes
  if (node.statements) for (const s of node.statements) collectIdentifiers(s, identifiers);
  if (node.expression) collectIdentifiers(node.expression, identifiers);
  if (node.value && node.constructor.name !== 'LetStatement') collectIdentifiers(node.value, identifiers);
  if (node.value && node.constructor.name === 'LetStatement') collectIdentifiers(node.value, identifiers);
  if (node.left) collectIdentifiers(node.left, identifiers);
  if (node.right) collectIdentifiers(node.right, identifiers);
  if (node.condition) collectIdentifiers(node.condition, identifiers);
  if (node.consequence) collectIdentifiers(node.consequence, identifiers);
  if (node.alternative) collectIdentifiers(node.alternative, identifiers);
  if (node.body) collectIdentifiers(node.body, identifiers);
  if (node.function) collectIdentifiers(node.function, identifiers);
  if (node.arguments) for (const a of node.arguments) collectIdentifiers(a, identifiers);
  if (node.elements) for (const e of node.elements) collectIdentifiers(e, identifiers);
  if (node.iterable) collectIdentifiers(node.iterable, identifiers);
  if (node.index) collectIdentifiers(node.index, identifiers);
  if (node.returnValue) collectIdentifiers(node.returnValue, identifiers);
  if (node.name && node.constructor.name !== 'LetStatement' && node.constructor.name !== 'SetStatement') {
    // Skip name in let/set — that's a binding, not a reference
  }
}
