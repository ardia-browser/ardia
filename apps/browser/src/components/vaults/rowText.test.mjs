import assert from "node:assert/strict";
import { test } from "node:test";
const { loginLines, rowLabel, twinLogins } = await import("./rowText.ts");

const login = (key, username, title, url = "https://127.0.0.1:8471/") => ({ key, kind: "login", item: { id: key, provider: "bitwarden", username, title, urls: [url] } });

test("two logins that would read the same show their item titles underneath, and other rows keep the host", () => {
  const rows = [login("a", "sam@example.com", "Local Test Page"), login("b", "sam@example.com", "Local Test Page (Work)"), login("c", "kim@example.com", "Local Test Page")];
  const twins = twinLogins(rows, "127.0.0.1");
  assert.deepEqual([...twins].sort(), ["a", "b"]);
  assert.deepEqual(loginLines(rows[0].item, "127.0.0.1", twins.has("a")), { title: "sam@example.com", detail: "Local Test Page" });
  assert.deepEqual(loginLines(rows[1].item, "127.0.0.1", twins.has("b")), { title: "sam@example.com", detail: "Local Test Page (Work)" });
  assert.deepEqual(loginLines(rows[2].item, "127.0.0.1", twins.has("c")), { title: "kim@example.com", detail: "127.0.0.1" });
  assert.match(rowLabel(rows[1], "127.0.0.1", true), /^sam@example\.com, Local Test Page \(Work\), /);
});

test("a twin with no item title keeps the host rather than an empty line", () => {
  assert.deepEqual(loginLines(login("a", "sam", "").item, "127.0.0.1", true), { title: "sam", detail: "127.0.0.1" });
});

test("Open Passwords opens Settings, so it ends with an ellipsis like the other footer rows that open something", () => {
  for (const kind of ["openPasswords", "allPasswords", "settings"]) assert.match(rowLabel({ key: kind, kind }, "x"), /…$/);
});
