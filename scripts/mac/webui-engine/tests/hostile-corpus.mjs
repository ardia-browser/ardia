#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { HOSTILE_VALUES } from "../../../security/hostile-inputs.mjs";

const hex = (text) => Buffer.from(text, "utf8").toString("hex");
const lines = [];
for (const { id, value } of HOSTILE_VALUES) {
  if (typeof value === "string") lines.push(`s ${id} ${hex(value)}`);
  else if (typeof value === "number") lines.push(`n ${id} ${String(value)}`);
  else lines.push(`s ${id}.asJson ${hex(JSON.stringify(value) ?? typeof value)}`);
}
const out = process.argv[2];
if (!out) {
  console.error("usage: hostile-corpus.mjs <out file>");
  process.exit(64);
}
writeFileSync(out, lines.join("\n") + "\n");
