import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const site = fileURLToPath(new URL("..", import.meta.url));
const styles = join(site, "src/styles");
const out = join(site, "src/assets/fonts");

const BASE =
  "\u00A0\u00A9\u00AB\u00AE\u00B0\u00B7\u00BB\u00D7" +
  "\u2010\u2011\u2012\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2022\u2026\u2032\u2033\u2039\u203A\u2122\u2191\u2192\u2193\u2212";
const chars = new Set(Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i));
for (const c of BASE) chars.add(c.codePointAt(0));

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.(astro|ts|md|css)$/.test(name) && !path.endsWith("fonts.css")) files.push(path);
  }
  return files;
}
for (const file of [...walk(join(site, "src")), ...walk(join(site, "../../docs/release-notes"))])
  for (const c of readFileSync(file, "utf8")) chars.add(c.codePointAt(0));

function parseRange(range) {
  const set = new Set();
  for (const part of range.split(",")) {
    const [a, b = a] = part.trim().replace(/^U\+/i, "").split("-");
    for (let c = parseInt(a, 16); c <= parseInt(b, 16); c++) set.add(c);
  }
  return set;
}
function formatRange(set) {
  const sorted = [...set].sort((a, b) => a - b);
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `U+${hex(sorted[i])}` : `U+${hex(sorted[i])}-${hex(sorted[j])}`);
    i = j + 1;
  }
  return parts.join(",");
}

mkdirSync(out, { recursive: true });

const css = [];

const alloDir = join(site, "node_modules/allo-font/fonts/webfonts");
const alloFullPath = join(alloDir, "AlloVariableFriendly.woff2");
const alloFull = readFileSync(alloFullPath);
const alloCoreChars = new Set([...chars].filter((c) => c <= 0x27bf));
const alloSubset = await subsetFont(alloFull, String.fromCodePoint(...alloCoreChars), { targetFormat: "woff2" });
writeFileSync(join(out, "allo-core.woff2"), alloSubset);
console.log(`allo-core.woff2: ${alloCoreChars.size} characters, ${alloFull.length} -> ${alloSubset.length} bytes`);

css.push(
`@font-face {
  font-family: "Allo";
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(${relative(styles, alloFullPath)}) format("woff2");
  unicode-range: U+0000-02FF,U+1E00-27BF;
}`
);
css.push(
`@font-face {
  font-family: "Allo";
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(${relative(styles, join(out, "allo-core.woff2"))}) format("woff2");
  unicode-range: ${formatRange(alloCoreChars)};
}`
);

const OBLIQUES = [
  [400, "Allo-Oblique.woff2"],
  [500, "Allo-MediumOblique.woff2"],
  [600, "Allo-SemiBoldOblique.woff2"],
  [700, "Allo-BoldOblique.woff2"],
];
for (const [weight, file] of OBLIQUES) {
  css.push(
`@font-face {
  font-family: "Allo";
  font-style: italic;
  font-display: swap;
  font-weight: ${weight};
  src: url(${relative(styles, join(alloDir, file))}) format("woff2");
}`
  );
}

const monoPkgDir = join(site, "node_modules/@fontsource-variable/martian-mono");
const monoSource = readFileSync(join(monoPkgDir, "wdth.css"), "utf8");
for (const [, comment, body] of monoSource.matchAll(/\/\* (\S+) \*\/\s*@font-face \{([\s\S]*?)\}/g)) {
  const file = body.match(/url\(\.\/files\/([^)]+)\)/)[1];
  const url = relative(styles, join(monoPkgDir, "files", file));
  const rule = (src, range) =>
    `@font-face {${body.replace(/url\([^)]+\)/, `url(${src})`).replace(/unicode-range: [^;]+;/, `unicode-range: ${range};`)}}`;
  if (!/-latin-wdth-normal$/.test(comment)) {
    css.push(rule(url, body.match(/unicode-range: ([^;]+);/)[1]));
    continue;
  }
  const latin = parseRange(body.match(/unicode-range: ([^;]+);/)[1]);
  const core = new Set([...chars].filter((c) => latin.has(c)));
  const rest = new Set([...latin].filter((c) => !core.has(c)));
  const full = readFileSync(join(monoPkgDir, "files", file));
  const subset = await subsetFont(full, String.fromCodePoint(...core), { targetFormat: "woff2" });
  writeFileSync(join(out, "martian-mono-core.woff2"), subset);
  css.push(rule(url, formatRange(rest)));
  css.push(rule(relative(styles, join(out, "martian-mono-core.woff2")), formatRange(core)));
  console.log(`martian-mono-core.woff2: ${core.size} characters, ${full.length} -> ${subset.length} bytes`);
}

writeFileSync(join(styles, "fonts.css"), `${css.join("\n\n")}\n`);
console.log(`wrote ${relative(site, join(styles, "fonts.css"))}`);
