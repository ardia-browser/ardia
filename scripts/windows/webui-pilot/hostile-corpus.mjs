#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { HOSTILE_VALUES } from "../../security/hostile-inputs.mjs";

const UNLISTED_SCHEMES = [
  "steam://run/1",
  "vscode://file/c:/x",
  "customapp://open",
  "ms-msdt:/id PCWDiagnostic",
  "search-ms:query=calc",
  "ms-settings:privacy",
  "shell:startup",
  "ms-officecmd:x",
  "ms-appinstaller:?source=https://ardia-fixture.invalid/x.appinstaller",
  "file:///C:/Windows/System32/calc.exe",
  "\\\\ardia-fixture.invalid\\share\\x.exe",
  "C:\\Windows\\System32\\calc.exe",
  "https://ardia-fixture.invalid/a b",
  "https://ardia-fixture.invalid/'x",
  'https://ardia-fixture.invalid/"x',
  "https://user:pass@ardia-fixture.invalid/",
  "mailto:a@ardia-fixture.invalid?body=%0d%0a" + "\t",
  "https:///ardia-fixture.invalid",
  "https://@ardia-fixture.invalid/",
  "https://ardia-fixture.invalid/" + "\ud800",
  "https://ardia-fixture.invalid/" + "\udfff" + "x",
  "https://ardia-fixture.invalid/" + "\ufffd",
  "https://ardia-fixture.invalid@ardia-other.invalid/",
  "https://ardia-fixture.invalid/" + "\u061c",
  "https://ardia-fixture.invalid/" + String.fromCodePoint(0xe0001),
  "https://ardia-fixture.invalid/" + String.fromCodePoint(0xf0000),
  "https://ardia-fixture.invalid/" + "\u00a0",
  "https:ardia-fixture.invalid",
  "HTTPS://ardia-fixture.invalid/" + "\u0000",
];

const literal = (value) => {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Map) return `new Map(${JSON.stringify([...value])})`;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return `new Date(${value.getTime()})`;
  if (Array.isArray(value) && value.length !== Object.keys(value).length) return `[${Array.from(value, (item, index) => (index in value ? literal(item) : "")).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === null) return "Object.create(null)";
  if (value && typeof value === "object" && typeof value.toString === "function" && Object.hasOwn(value, "toString")) return `({ toString: () => ${JSON.stringify(String(value))} })`;
  if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  return JSON.stringify(value);
};

const WINDOWS_DOCUMENT_NAME_LIMIT = 200;
const RESERVED_WINDOWS_DOCUMENTS = [
  "session.json",
  "live.json",
  "live.canonical.json",
  "rnw-migration.json",
  "rnw-migration.lock",
  "launch-starts.txt",
  "launch-starts.txt.tmp",
];
const windowsDeviceName = (name) => {
  const stem = name.split(".")[0].replace(/ +$/, "").toLowerCase();
  return ["con", "prn", "aux", "nul", "conin$", "conout$"].includes(stem) || /^(com|lpt)[0-9]$/.test(stem);
};
const windowsDocumentOutcome = (value) => {
  if (typeof value !== "string") return "request";
  const valid =
    value.length > 0 &&
    value.length <= WINDOWS_DOCUMENT_NAME_LIMIT &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !windowsDeviceName(value);
  return valid && !RESERVED_WINDOWS_DOCUMENTS.includes(value.toLowerCase()) ? "accepted" : "name";
};
const corpusCase = (id, value) => {
  const document = windowsDocumentOutcome(value);
  return { id, expression: literal(value), document, ...(document === "accepted" ? { name: value } : {}) };
};

const cases = [
  ...HOSTILE_VALUES.map(({ id, value }) => corpusCase(id, value)),
  ...UNLISTED_SCHEMES.map((value, index) => corpusCase(`windows.unlisted${index}`, value)),
];
const shapes = [
  { id: "shape.noArgs", expression: "[]" },
  { id: "shape.twoArgs", expression: '["https://ardia-fixture.invalid/", "x"]' },
  { id: "shape.argsNotList", expression: '"https://ardia-fixture.invalid/"' },
  { id: "shape.argsObject", expression: '{ "0": "https://ardia-fixture.invalid/" }' },
];
const out = process.argv[2];
const corpus = JSON.stringify({
  cases,
  shapes,
  control: "https://ardia-fixture.invalid/ardia-open-external",
  mailto: "mailto:ardia@ardia-fixture.invalid?body=https://user@ardia-fixture.invalid/x",
});
if (out) writeFileSync(out, corpus);
else process.stdout.write(corpus);
