import { readFileSync } from "node:fs";
import ts from "typescript";

export const readApi = () => readFileSync(new URL("./api.ts", import.meta.url), "utf8");
export const readManifest = () => JSON.parse(readFileSync(new URL("./generated/manifest.json", import.meta.url), "utf8"));

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const ROW_NAME = /^[a-zA-Z]+\.[a-zA-Z]+$/;

function literalRows(name, literal, file) {
  const hand = [];
  for (const member of literal.members) {
    const key = ts.isPropertySignature(member) && member.name && ts.isStringLiteral(member.name) ? member.name.text : null;
    if (key === null || !ROW_NAME.test(key) || member.questionToken || !member.type) {
      throw new Error(`${name}'s row literal holds only rows, each a quoted "domain.verb" key with a type: ${JSON.stringify(member.getText(file))}`);
    }
    if (hand.includes(key)) throw new Error(`${name}'s row literal lists ${key} twice`);
    hand.push(key);
  }
  return hand;
}

export function typeRows(source, manifest, name) {
  const syntax = ts.transpileModule(source, { fileName: "api.ts", reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest } }).diagnostics ?? [];
  if (syntax.length) {
    throw new Error(`api.ts must parse as TypeScript; ${name}'s row literal holds only rows: ${ts.flattenDiagnosticMessageText(syntax[0].messageText, " ")}`);
  }
  const file = ts.createSourceFile("api.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = file.statements.filter((statement) => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name);
  const reexported = file.statements.some((statement) => ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) => element.name.text === name));
  if (declared.length !== 1 || reexported) throw new Error(`api.ts declares ${name} ${declared.length + (reexported ? 1 : 0)} times`);
  const alias = declared[0];
  if (!ts.isTypeAliasDeclaration(alias) || !alias.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) || alias.typeParameters) {
    throw new Error(`${name} is an exported, non-generic type alias: \`export type ${name} = HistoryCalls & {\``);
  }
  const parts = ts.isIntersectionTypeNode(alias.type) ? [...alias.type.types] : [alias.type];
  const literal = parts.at(-1);
  if (!literal || !ts.isTypeLiteralNode(literal)) {
    throw new Error(`${name}'s row literal ends its type: \`};\` with nothing after it, as \`export type ${name} = HistoryCalls & { … };\``);
  }
  const operandNodes = parts.slice(0, -1);
  for (const node of operandNodes) {
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeArguments) {
      throw new Error(`${name} is generated domains and one row literal, as \`export type ${name} = HistoryCalls & {\`: got ${JSON.stringify(node.getText(file))}`);
    }
  }
  const kind = name.endsWith("Calls") ? "calls" : "events";
  const generated = new Map(Object.entries(manifest.domains).map(([domain, entry]) => [`${capitalized(domain)}${capitalized(kind)}`, { domain, entry }]));
  const operands = operandNodes.map((node) => node.typeName.text);
  for (const operand of operands) {
    const found = generated.get(operand);
    if (!found) continue;
    const imported = file.statements.some((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === `./generated/${found.domain}` && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some((element) => element.name.text === operand && (element.propertyName ?? element.name).text === operand));
    const shadowed = file.statements.some((statement) => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name?.text === operand);
    if (!imported || shadowed) throw new Error(`${name} composes ${operand}, which must be imported as is from ./generated/${found.domain} and not declared in api.ts`);
  }
  const rows = [];
  for (const operand of operands) {
    const found = generated.get(operand);
    if (!found) throw new Error(`${name} composes ${operand}, which isn't a generated domain's ${kind}`);
    const verbs = kind === "calls" ? Object.keys(found.entry.calls) : found.entry.events;
    rows.push(...verbs.map((verb) => `${found.domain}.${verb}`));
  }
  const hand = literalRows(name, literal, file);
  return { operands, hand, rows: new Set([...rows, ...hand]) };
}
