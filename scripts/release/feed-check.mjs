#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { feedFacts } from "./preflight.mjs";

const [path, version] = process.argv.slice(2);
if (!path || !version) {
  console.error("usage: scripts/release/feed-check.mjs <appcast.xml> <version>  (exits 1 unless it's a whole Sparkle appcast with items)");
  process.exit(64);
}
let xml;
try {
  xml = readFileSync(path, "utf8");
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
const facts = feedFacts(xml, version);
if (!facts) {
  console.error(`${path} isn't a whole Sparkle appcast with items`);
  process.exit(1);
}
console.log(`${path}: ${facts.items} items, newest build ${facts.newest}`);
