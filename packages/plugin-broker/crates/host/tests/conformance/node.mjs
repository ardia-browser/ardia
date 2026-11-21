import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

const source = readFileSync(new URL("./conformance.js", import.meta.url), "utf8");
globalThis.__ardiaBridge = {
  send(line) {
    const { conformance } = JSON.parse(line);
    process.stdout.write(JSON.stringify({ url: conformance.url, base64: conformance.base64 }, null, 1) + "\n");
  },
  onLine() {},
};
runInThisContext(source);
