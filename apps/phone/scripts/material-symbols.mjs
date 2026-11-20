import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../assets/material-symbols.json", import.meta.url), "utf8"));
const missing = Object.entries(manifest.javascript).filter(([, icon]) => !manifest.icons[icon]?.paths.length);
if (missing.length) throw new Error(`Missing Material artwork: ${missing.map(([name, icon]) => `${name} → ${icon}`).join(", ")}`);
const unused = Object.keys(manifest.icons).filter((icon) => !Object.values(manifest.javascript).includes(icon));
if (unused.length) throw new Error(`Material artwork nothing maps to: ${unused.join(", ")}`);
console.log(`${Object.keys(manifest.javascript).length} symbols map to ${Object.keys(manifest.icons).length} pinned Material artworks`);
