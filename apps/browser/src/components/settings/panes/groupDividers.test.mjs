import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../../lib/platformFeatures.ts");
const ui = await import("../../ui/index.ts");
const { useControlApprovals } = await import("../../../state/automation/controlApprovals.ts");
const { useExtensions } = await import("../../../state/extensions/store.ts");
const { currentEngineProfile } = await import("../../../state/browser/current.ts");
const { AdvancedPane } = await import("./Advanced.tsx");
const { ExtensionPage } = await import("./ProfileExtensions.tsx");

function groups(element) {
  const found = [];
  const walk = (node, into) => {
    if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) return node.forEach((child) => walk(child, into));
    if (!React.isValidElement(node)) return;
    if (node.type === ui.Group) {
      const rows = [];
      found.push(rows);
      return walk(mount(() => node.type(node.props)).value, rows);
    }
    if (node.type === ui.Divider) return into?.push("divider");
    if (node.type === ui.Row) return into?.push(node.props.title ?? null);
    if (typeof node.type === "function") return walk(mount(() => node.type(node.props)).value, into);
    if (typeof node.type === "object" && node.type?.$$typeof === Symbol.for("react.memo")) return walk(React.createElement(node.type.type, node.props), into);
    if (typeof node.type === "object" && node.type?.render) return walk(mount(() => node.type.render(node.props, null)).value, into);
    walk(node.props?.children, into);
  };
  walk(element, null);
  return found;
}

const titled = (rows) => rows.filter((r) => r !== "divider");
const missingDividers = (rows) => rows.flatMap((r, i) => (i > 0 && r !== "divider" && rows[i - 1] !== "divider" ? [r] : []));

test("Advanced › Command line and automation has a divider above every row, the rows Programs adds included", { skip: !PLATFORM_FEATURES.plugins }, () => {
  useControlApprovals.setState({
    approvals: [
      { key: "a", name: "Script One", signedBy: "Signed by Test", until: undefined },
      { key: "b", name: "Script Two", signedBy: "Signed by Test", until: undefined },
    ],
    problem: null,
    doorbell: true,
    loaded: true,
  });
  const commandLine = groups(React.createElement(AdvancedPane, {})).find((rows) => rows.includes("Let programs control Ardia"));
  assert.ok(commandLine, "the Command line group renders");
  assert.ok(titled(commandLine).includes("Programs on your PATH"));
  if (PLATFORM_FEATURES.controlDoorbell) assert.ok(titled(commandLine).includes("Script Two"));
  assert.deepEqual(missingDividers(commandLine), [], commandLine.join(" | "));
});

test("an extension's Site access row and its site rows each have a divider", () => {
  const profileId = "default";
  useExtensions.setState((e) => ({
    lists: {
      ...e.lists,
      [currentEngineProfile(profileId)]: [
        {
          id: "abcdefghijklmnopabcdefghijklmnop",
          name: "Test Extension",
          version: "1.0",
          description: "",
          enabled: true,
          state: "ENABLED",
          icon: "",
          permissions: ["Read your browsing history"],
          siteAccess: "ON_SPECIFIC_SITES",
          sites: ["https://one.test/*", "https://two.test/*"],
          optionsUrl: null,
          pinned: false,
          incognito: false,
          fileAccess: false,
          mayModify: true,
          errors: [],
          location: "INTERNAL",
          path: null,
          fromWebStore: true,
          webStoreUrl: null,
          homepageUrl: null,
        },
      ],
    },
  }));
  const permissions = groups(React.createElement(ExtensionPage, { profileId, extensionId: "abcdefghijklmnopabcdefghijklmnop" })).find((rows) =>
    rows.includes("Site access"),
  );
  assert.ok(permissions, "the Permissions group renders");
  assert.equal(titled(permissions).length, 5, permissions.join(" | "));
  assert.deepEqual(missingDividers(permissions), [], permissions.join(" | "));
});
