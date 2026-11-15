#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { transformSync } from "esbuild";

const HELP = `Usage: node apps/browser/scripts/readability-source.mjs <Readability.js> <Readability-readerable.js> <version>

Writes apps/browser/src/state/reader/readabilitySource.ts, the article extractor Reading mode runs in a page:
Mozilla's Readability and isProbablyReaderable, each minified into one expression that evaluates to the function,
with nothing left on the page's globals. Both files come from the @mozilla/readability package on npm
(Apache-2.0, https://github.com/mozilla/readability):

  npm pack @mozilla/readability@<version> && tar -xzf mozilla-readability-<version>.tgz`;

const [readabilityPath, readerablePath, version] = process.argv.slice(2);
if (!readabilityPath || !readerablePath || !version || process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(readabilityPath === "--help" ? 0 : 1);
}

const LICENSE = `/*
 * Mozilla Readability ${version} (https://github.com/mozilla/readability), minified.
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */`;

function expression(path, exported) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(`function ${exported}(`)) throw new Error(`${path} doesn't define ${exported}`);
  const wrapped = `(() => { var module; ${source}\nreturn ${exported}; })()`;
  const { code } = transformSync(wrapped, { minify: true, legalComments: "none", target: "es2020", loader: "js" });
  return code.trim().replace(/;$/, "");
}

const out = new URL("../src/state/reader/readabilitySource.ts", import.meta.url);
const readability = expression(readabilityPath, "Readability");
const readerable = expression(readerablePath, "isProbablyReaderable");
writeFileSync(
  out,
  `${LICENSE}\nexport const READABILITY_VERSION = ${JSON.stringify(version)};\nexport const READABILITY = ${JSON.stringify(readability)};\nexport const READERABLE = ${JSON.stringify(readerable)};\n`,
);
console.log(`wrote ${out.pathname} (${readability.length + readerable.length} chars)`);
