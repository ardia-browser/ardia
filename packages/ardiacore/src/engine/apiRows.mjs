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
  const literal = ts.isTypeLiteralNode(parts.at(-1)) ? parts.at(-1) : null;
  const operandNodes = literal ? parts.slice(0, -1) : parts;
  for (const node of operandNodes) {
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeArguments) {
      throw new Error(`${name} is generated domains and at most one row literal, last, as \`export type ${name} = HistoryCalls & { … };\`: got ${JSON.stringify(node.getText(file))}`);
    }
  }
  const kind = name.endsWith("Calls") ? "calls" : "events";
  const generated = new Map(Object.entries(manifest.domains).map(([domain, entry]) => [`${capitalized(domain)}${capitalized(kind)}`, { domain, entry }]));
  const importsOf = (local) => file.statements.filter((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings))
    .flatMap((statement) => statement.importClause.namedBindings.elements.filter((element) => element.name.text === local).map((element) => ({ from: statement.moduleSpecifier.text, imported: (element.propertyName ?? element.name).text })));
  const declaredHere = (local) => file.statements.some((statement) => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name?.text === local);
  const resolved = operandNodes.map((node) => {
    const local = node.typeName.text;
    const bindings = importsOf(local);
    if (bindings.length > 1) throw new Error(`${name} composes ${local}, which api.ts imports ${bindings.length} times; a generated domain's type is imported once`);
    const binding = bindings[0] ?? null;
    const typeName = generated.has(binding?.imported) ? binding.imported : local;
    const found = generated.get(typeName);
    if (!found) throw new Error(`${name} composes ${local}, which isn't a generated domain's ${kind}`);
    if (binding?.from !== `./generated/${found.domain}` || binding.imported !== typeName || declaredHere(local)) {
      throw new Error(`${name} composes ${local}, which must be imported from ./generated/${found.domain} as its ${typeName}, once, and not declared in api.ts`);
    }
    return { typeName, ...found };
  });
  const operands = resolved.map(({ typeName }) => typeName);
  const rows = [];
  for (const { domain, entry } of resolved) {
    const verbs = Object.keys(kind === "calls" ? entry.calls : entry.events);
    rows.push(...verbs.map((verb) => `${domain}.${verb}`));
  }
  const hand = literal ? literalRows(name, literal, file) : [];
  return { operands, hand, rows: new Set([...rows, ...hand]) };
}
