import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the sidebar's text scope provides without a component of its own where nothing sits between it and its theme", () => {
  const scope = read("./SidebarTextScope.tsx");
  assert.match(scope, /export function SidebarInk\(\{ children \}: \{ children: ReactNode \}\) \{\n  return sidebarText\(tintTheme\(useTheme\(\)\), useSidebarHighContrast\(\), children\);/);
  assert.match(read("./SidebarPage.tsx"), /<SidebarInk>/);
  assert.doesNotMatch(read("./SidebarPage.tsx"), /<TintInk>|<SidebarTextScope>/);
  const sidebar = read("./Sidebar.tsx");
  assert.match(sidebar, /const theme = useTheme\(\);\n  const strongText = useSidebarHighContrast\(\);/);
  assert.match(sidebar, /\{sidebarText\(\n\s*theme,\n\s*strongText,/);
});
