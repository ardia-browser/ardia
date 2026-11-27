import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function reactNativeUrl() {
  const file = require.resolve("react-native/Libraries/Blob/URL.js");
  const babel = require("@babel/core");
  const source = readFileSync(file, "utf8")
    .replace(/^import type .*$/gm, "")
    .replace(/^import NativeBlobModule from .*$/m, "const NativeBlobModule = null;")
    .replace(/^export \{URLSearchParams\} from .*$/m, "");
  const { code } = babel.transformSync(source, { babelrc: false, configFile: false, filename: file, plugins: [require.resolve("@babel/plugin-transform-flow-strip-types")] });
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.URL;
}

export async function withAppUrl(run) {
  const AppUrl = await reactNativeUrl();
  assert.equal(new AppUrl("http://127.0.0.1:18800/page.html").href, "http://127.0.0.1:18800/page.html/");
  const original = globalThis.URL;
  globalThis.URL = AppUrl;
  try {
    return await run();
  } finally {
    globalThis.URL = original;
  }
}
