import assert from "node:assert/strict";
import { test } from "node:test";
import { officialCredentialProviders } from "../plugins/officialCredentials.ts";
import { catalogueEntryOf, managerOffers } from "./managerCatalogue.ts";

const HASH = "b".repeat(64);
const manifest = (title) => ({ title, description: "", icon: null, contributes: { credentialProvider: { title, symbol: "shield.lefthalf.filled", accent: "#175DDC" } } });
const listing = (name) => ({ name, manifest: manifest(name), problems: [], hash: HASH, folderId: `official-${"a".repeat(64)}`, official: true });
const pinned = ["1password", "bitwarden", "protonpass"].map((name) => ({ name, version: "1.0.0", folderId: "official-x", credentialPrograms: ["x"], title: name }));
const catalogue = (s) => officialCredentialProviders({ pinned, candidates: {}, ...s }, true).map(catalogueEntryOf);

test("Add Password Manager offers only what isn't installed; installed but off becomes an Off row; on or registered shows neither", () => {
  const entries = catalogue({
    listings: { bitwarden: listing("bitwarden"), protonpass: listing("protonpass") },
    order: ["bitwarden", "protonpass"],
    records: { bitwarden: { enabled: false, approved: HASH, values: {}, applied: {} }, protonpass: { enabled: true, approved: HASH, values: {}, applied: {} } },
  });
  const { add, off } = managerOffers(entries, new Set(["protonpass"]));
  assert.deepEqual(add.map((e) => e.name), ["1password"]);
  assert.deepEqual(off.map((e) => [e.name, e.icon, e.accent]), [["bitwarden", "shield.lefthalf.filled", "#175DDC"]]);
  assert.deepEqual(managerOffers(entries, new Set(["bitwarden", "protonpass"])).off, [], "a provider native still lists keeps its own row");
});
