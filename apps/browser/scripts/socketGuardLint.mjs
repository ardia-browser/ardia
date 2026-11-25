import { dirname, join, relative, resolve } from "node:path";
import { readdirSync } from "node:fs";
import ts from "typescript";

const GUARDS = new Set(["stillOn", "mayWrite", "mayDelete", "mayAct", "mayClose", "allowed", "serving", "stillServing"]);
const CALL_GUARDS = new Set(["serving", "stillServing"]);
const PROMISE_CALLBACKS = new Set(["then", "catch", "finally"]);
const MAX_DEPTH = 5;
const DEFERRED = /^(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback|addEventListener|addListener|subscribe|listen|on[A-Z]\w*)$/;
const FOREIGN_HOOKS = new Set(["foreignWriteHooks", "syncWriteHooks"]);

export function loadProgram(appDir, extraFiles = {}) {
  const configPath = ts.findConfigFile(appDir, ts.sys.fileExists, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const names = [...config.fileNames, ...Object.keys(extraFiles)];
  const host = ts.createCompilerHost(config.options, true);
  const read = host.readFile.bind(host);
  host.readFile = (file) => extraFiles[resolve(file)] ?? read(file);
  const exists = host.fileExists.bind(host);
  host.fileExists = (file) => resolve(file) in extraFiles || exists(file);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, ...rest) => (resolve(file) in extraFiles ? ts.createSourceFile(file, extraFiles[resolve(file)], lang, true) : getSource(file, lang, ...rest));
  return ts.createProgram(names, config.options, host);
}

const CHOKE_POINT = "socketSharedChokePoint.ts";

export function socketRootFiles(appDir) {
  const automation = join(appDir, "src", "state", "automation");
  return [...readdirSync(automation).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== CHOKE_POINT).map((f) => join(automation, f)), join(appDir, "src", "state", "commands", "commands.ts")];
}

const isFunction = (n) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

function nameOf(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  return `<anonymous:${fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1}>`;
}

export function findUnguardedWrites(program, rootFiles) {
  const checker = program.getTypeChecker();
  const roots = new Set(rootFiles.map((f) => resolve(f)));
  const memo = new Map();
  const problems = new Map();

  const storeHook = (type) => {
    const getState = type && checker.getPropertyOfType(checker.getApparentType(type), "getState");
    if (!getState || !checker.getPropertyOfType(checker.getApparentType(type), "setState")) return false;
    const signature = checker.getTypeOfSymbol(getState).getCallSignatures()[0];
    return !!signature && storeLike(signature.getReturnType());
  };
  const storeLike = (type) => !!type && ["tabs", "groups", "activate", "closeTabs"].every((p) => checker.getPropertyOfType(checker.getApparentType(type), p));
  const projectFile = (sf) => !sf.isDeclarationFile && !sf.fileName.includes("node_modules");

  function declarationOf(expr) {
    let symbol = checker.getSymbolAtLocation(expr);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl || !projectFile(decl.getSourceFile()) || decl.getSourceFile().fileName.endsWith(CHOKE_POINT)) return { decl: null, symbol };
    if (isFunction(decl)) return { decl, symbol };
    if (ts.isVariableDeclaration(decl) && decl.initializer && isFunction(decl.initializer)) return { decl: decl.initializer, symbol };
    return { decl: null, symbol, raw: decl };
  }

  function isStoreWrite(call) {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === "setState" && storeHook(checker.getTypeAtLocation(callee.expression))) return true;
      const owner = checker.getTypeAtLocation(callee.expression);
      return storeLike(owner) && checker.getTypeAtLocation(callee).getCallSignatures().length > 0;
    }
    if (ts.isIdentifier(callee)) {
      const { raw } = declarationOf(callee);
      if (raw && ts.isVariableDeclaration(raw) && raw.initializer && ts.isPropertyAccessExpression(raw.initializer) && raw.initializer.name.text === "setState") return storeHook(checker.getTypeAtLocation(raw.initializer.expression));
      if (raw && ts.isBindingElement(raw)) {
        let node = raw.parent;
        while (node && !ts.isVariableDeclaration(node) && !ts.isParameter(node)) node = node.parent;
        const init = node && ts.isVariableDeclaration(node) ? node.initializer : null;
        return !!init && storeLike(checker.getTypeAtLocation(init));
      }
    }
    return false;
  }

  function guardOf(fn, inherited) {
    const own = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null)).filter((n) => n && (GUARDS.has(n) || n === "call"));
    if (own.length) return own;
    const destructured = fn.parameters.flatMap((p) => (ts.isObjectBindingPattern(p.name) ? p.name.elements.map((e) => e.name.getText()) : [])).filter((n) => GUARDS.has(n));
    return destructured.length ? destructured : inherited;
  }

  function isGuardCall(call, guards) {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return guards.includes(callee.text);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return (guards.includes(callee.expression.text) && CALL_GUARDS.has(callee.name.text)) || GUARDS.has(callee.name.text);
    return false;
  }

  const passesGuard = (call, guards) => call.arguments.some((a) => ts.isIdentifier(a) && guards.includes(a.text));
  const terminates = (stmt) => !!stmt && (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || (ts.isBlock(stmt) && terminates(stmt.statements.at(-1))));

  function report(fn, what, full = false) {
    const sf = fn.getSourceFile();
    const key = `${relative(dirname(dirname(sf.fileName)), sf.fileName)}: ${nameOf(fn)}`;
    if (!problems.has(key)) problems.set(key, full ? `${key} ${what}` : `${key} ${what} after an await without calling its guard`);
  }

  function analyze(fn, depth, inheritedGuards = []) {
    const byDepth = memo.get(fn) ?? new Map();
    memo.set(fn, byDepth);
    if (byDepth.has(depth)) return byDepth.get(depth);
    const result = { writesSync: false, guardsFirst: false, hooksSync: false };
    byDepth.set(depth, result);
    const guards = guardOf(fn, inheritedGuards);
    let touched = false;
    const write = (ctx, what) => {
      touched = true;
      if (ctx.afterAwait && !ctx.guarded) report(fn, what);
      else if (!ctx.afterAwait && !ctx.guarded) result.writesSync = true;
    };
    const guardNow = (ctx) => {
      if (!ctx.afterAwait && !touched) result.guardsFirst = true;
      ctx.guarded = true;
    };
    function visit(node, ctx) {
      if (ts.isAwaitExpression(node)) {
        visit(node.expression, ctx);
        ctx.afterAwait = true;
        ctx.guarded = false;
        return;
      }
      if (isFunction(node)) {
        if (node.body) visit(node.body, { ...ctx });
        return;
      }
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
        visit(node.expression ?? node.condition, ctx);
        const yes = { ...ctx };
        const no = { ...ctx };
        visit(node.thenStatement ?? node.whenTrue, yes);
        const otherwise = node.elseStatement ?? node.whenFalse;
        if (otherwise) visit(otherwise, no);
        const flows = [terminates(node.thenStatement) ? null : yes, otherwise && terminates(node.elseStatement) ? null : no].filter(Boolean);
        if (!flows.length) return;
        ctx.afterAwait = flows.some((f) => f.afterAwait);
        ctx.guarded = flows.filter((f) => f.afterAwait).every((f) => f.guarded) && (ctx.afterAwait || flows.every((f) => f.guarded));
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && PROMISE_CALLBACKS.has(callee.name.text)) {
          visit(callee.expression, ctx);
          for (const arg of node.arguments) {
            if (isFunction(arg) && arg.body) visit(arg.body, { afterAwait: true, guarded: false });
            else visit(arg, ctx);
          }
          return;
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "around" && ts.isIdentifier(callee.expression) && FOREIGN_HOOKS.has(callee.expression.text)) {
          if (!ctx.afterAwait) {
            result.hooksSync = true;
            report(fn, `calls ${callee.expression.text}.around in the socket's own stretch, which would close its open check before the socket's write`, true);
          }
          return;
        }
        const deferred = DEFERRED.test(ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "");
        visit(callee, ctx);
        for (const arg of node.arguments) {
          if (isFunction(arg) && arg.body) visit(arg.body, deferred ? { afterAwait: true, guarded: false } : { ...ctx });
          else visit(arg, ctx);
        }
        if (isGuardCall(node, guards)) return guardNow(ctx);
        if (isStoreWrite(node)) return write(ctx, `writes the store (${callee.getText().slice(0, 60)})`);
        if (depth >= MAX_DEPTH) return;
        const { decl } = declarationOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
        if (!decl || decl === fn) return;
        const inner = analyze(decl, depth + 1);
        if (inner.guardsFirst && passesGuard(node, guards)) return guardNow(ctx);
        if (inner.hooksSync && !ctx.afterAwait) report(fn, `reaches a foreign write hook through ${nameOf(decl)} in the socket's own stretch`, true);
        if (inner.writesSync) write(ctx, `writes the store through ${nameOf(decl)}`);
        return;
      }
      ts.forEachChild(node, (child) => visit(child, ctx));
    }
    if (fn.body) visit(fn.body, { afterAwait: false, guarded: false });
    return result;
  }

  for (const sf of program.getSourceFiles()) {
    if (!roots.has(resolve(sf.fileName))) continue;
    const callbackOfLater = (node) => {
      const call = node.parent;
      if (!call || !ts.isCallExpression(call) || !call.arguments.includes(node)) return false;
      const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : "";
      return PROMISE_CALLBACKS.has(name) || DEFERRED.test(name);
    };
    const walk = (node, guards) => {
      if (isFunction(node)) {
        const own = guardOf(node, guards);
        if (!callbackOfLater(node)) analyze(node, 0, guards);
        ts.forEachChild(node, (child) => walk(child, own));
        return;
      }
      ts.forEachChild(node, (child) => walk(child, guards));
    };
    walk(sf, []);
  }
  return [...problems.values()].sort();
}
