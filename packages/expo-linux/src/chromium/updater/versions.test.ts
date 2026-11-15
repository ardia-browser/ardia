import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, newestOf } from "./versions";

test("versions compare by number, a nightly sorts below its stable", () => {
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("v1.2.0", "linux-v1.2.0"), 0);
  assert.equal(compareVersions("1.2.0-nightly.3", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0-nightly.10", "1.2.0-nightly.9"), 1);
});

test("the newest release with a Linux build on the channel wins", () => {
  const linux = [{ name: "Ardia.AppImage" }];
  const releases = [
    { tag_name: "v1.3.0", html_url: "a", prerelease: false, draft: false, assets: [{ name: "Ardia.dmg" }] },
    { tag_name: "v1.2.5", html_url: "b", prerelease: false, draft: false, assets: linux },
    { tag_name: "v1.4.0-nightly.1", html_url: "c", prerelease: true, draft: false, assets: linux },
    { tag_name: "v9.0.0", html_url: "d", prerelease: false, draft: true, assets: linux },
  ];
  assert.equal(newestOf(releases, "stable")?.html_url, "b");
  assert.equal(newestOf(releases, "nightly")?.html_url, "c");
});
