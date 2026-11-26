import { writeFileSync } from "node:fs";

await import("../src/test-native/index.ts");
const { vaultMethodsJson } = await import("../src/state/automation/socketVault.ts");
const out = new URL("../../../docs/vault-methods.json", import.meta.url);
writeFileSync(out, vaultMethodsJson());
console.log(`wrote ${out.pathname}`);
process.exit(0);
