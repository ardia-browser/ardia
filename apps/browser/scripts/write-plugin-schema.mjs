import { writeFileSync } from "node:fs";

const { PLUGIN_EVENTS } = await import("../src/state/automation/eventNames.ts");
const { pluginSchemaJson } = await import("../src/lib/pluginSchema.ts");
const { PLUGIN_RULES } = await import("../src/state/plugins/appChecks.ts");
const out = new URL("../../../docs/plugin.schema.json", import.meta.url);
writeFileSync(out, pluginSchemaJson(PLUGIN_EVENTS, PLUGIN_RULES));
console.log(`wrote ${out.pathname}`);
