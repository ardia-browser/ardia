import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

const kindOf = (path) => (/\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
export const parse = (path, text) => ts.createSourceFile(`/${path}`, text, ts.ScriptTarget.Latest, true, kindOf(path));

function unwrap(node) {
  let e = node;
  while (e && (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e) || ts.isExpressionWithTypeArguments(e))) e = e.expression;
  return e;
}

const literalText = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

function memberName(node) {
  const e = unwrap(node);
  if (!e) return null;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return literalText(unwrap(e.argumentExpression));
  return null;
}

function each(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => each(child, visit));
}

const propertyKey = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null);

function sources(node, out = []) {
  const e = unwrap(node);
  if (!e) return out;
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
    sources(e.left, out);
    sources(e.right, out);
  } else if (ts.isConditionalExpression(e)) {
    sources(e.whenTrue, out);
    sources(e.whenFalse, out);
  } else out.push(e);
  return out;
}

function binder(file) {
  const host = {
    getSourceFile: (name) => (name === file.fileName ? file : undefined),
    writeFile() {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    fileExists: (name) => name === file.fileName,
    readFile: () => undefined,
  };
  const checker = ts.createProgram([file.fileName], { noLib: true, noResolve: true, allowJs: true, types: [] }, host).getTypeChecker();
  return (node) => (ts.isShorthandPropertyAssignment(node) ? checker.getShorthandAssignmentValueSymbol(node) : checker.getSymbolAtLocation(node)) ?? null;
}

function resolver(file, member, seedNames) {
  const symbolOf = binder(file);
  const aliases = new Set();
  const holders = new Map();
  const passedKeys = new Set();
  const holderHas = (expression, key) => {
    const e = unwrap(expression);
    return !!e && ts.isIdentifier(e) && !!holders.get(symbolOf(e))?.has(key);
  };
  const isGlobalMember = (e) => e.text === member && symbolOf(e) === null;
  const isAlias = (e) => ts.isIdentifier(e) && (seedNames.includes(e.text) || isGlobalMember(e) || aliases.has(symbolOf(e)));
  const refersTo = (node) =>
    sources(node).some((e) => memberName(e) === member || isAlias(e) || (ts.isPropertyAccessExpression(e) && holderHas(e.expression, e.name.text)));
  const holdingKeys = (object) =>
    object.properties.flatMap((p) => {
      if (ts.isPropertyAssignment(p) && refersTo(p.initializer)) return [propertyKey(p.name)].filter(Boolean);
      if (ts.isShorthandPropertyAssignment(p) && (seedNames.includes(p.name.text) || aliases.has(symbolOf(p)))) return [p.name.text];
      return [];
    });
  const add = (set, value) => value && !set.has(value) && (set.add(value), true);
  for (let changed = true, rounds = 0; changed && rounds < 6; rounds++) {
    changed = false;
    each(file, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        if (refersTo(node.initializer)) changed = add(aliases, symbolOf(node.name)) || changed;
        else if (init && ts.isObjectLiteralExpression(init)) {
          const keys = holdingKeys(init);
          if (keys.length) {
            const symbol = symbolOf(node.name);
            if (!holders.has(symbol)) holders.set(symbol, new Set());
            for (const key of keys) changed = add(holders.get(symbol), key) || changed;
          }
        }
      }
      if (ts.isObjectLiteralExpression(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node))
        for (const key of holdingKeys(node)) changed = add(passedKeys, key) || changed;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && refersTo(node.right))
        changed = add(aliases, symbolOf(node.left)) || changed;
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const key = propertyKey(node.propertyName) ?? node.name.text;
        const declaration = node.parent.parent;
        const from = ts.isVariableDeclaration(declaration) ? declaration.initializer : null;
        if (key === member || passedKeys.has(key) || (from && holderHas(from, key))) changed = add(aliases, symbolOf(node.name)) || changed;
      }
    });
  }
  return (node, { members }) => {
    const e = unwrap(node);
    if (!e) return false;
    if (members && memberName(e) === member) return true;
    if (isAlias(e)) return true;
    return ts.isPropertyAccessExpression(e) && holderHas(e.expression, e.name.text);
  };
}

function calls(file, member, { seedNames = [], members = true } = {}) {
  const targets = resolver(file, member, seedNames);
  const isTarget = (node) => targets(node, { members });
  const applies = resolver(file, "apply", ["apply"]);
  const found = [];
  each(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const args = node.arguments;
    if (isTarget(callee)) return void found.push(args);
    const viaName = memberName(callee);
    if ((viaName === "call" || viaName === "apply") && isTarget(callee.expression)) {
      const rest = viaName === "call" ? args.slice(1) : args[1] && ts.isArrayLiteralExpression(unwrap(args[1])) ? unwrap(args[1]).elements : [];
      return void found.push(rest);
    }
    if (applies(callee, { members: true }) && args.length >= 3 && isTarget(args[0])) {
      const list = unwrap(args[2]);
      return void found.push(ts.isArrayLiteralExpression(list) ? list.elements : []);
    }
  });
  return found.map((list) => {
    const name = literalText(list[0] && unwrap(list[0]));
    return { name, computed: name === null };
  });
}

const remembered = new Map();
const memo = (kind, path, text, compute) => {
  const key = `${kind}\0${path}\0${text}`;
  if (!remembered.has(key)) remembered.set(key, compute());
  return remembered.get(key);
};

export const evaluateCalls = (path, text) => (text.includes("evaluate") ? memo("evaluate", path, text, () => calls(parse(path, text), "evaluate").length) : 0);

export const listenerCalls = (path, text) => memo("listener", path, text, () => calls(parse(path, text), "addEventListener"));

export const messageCalls = (path, text) =>
  memo("message", path, text, () => {
    const file = parse(path, text);
    return [...calls(file, "send", { seedNames: ["send"], members: false }), ...calls(file, "post", { seedNames: ["post"], members: false })];
  });
