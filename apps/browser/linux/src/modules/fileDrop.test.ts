import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const folder = mkdtempSync(join(tmpdir(), "ardia-file-drop-"));
after(() => rmSync(folder, { recursive: true, force: true }));

const { droppedFiles, linkTarget } = await import("./fileDrop.ts");

const write = (name: string, text: string) => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};

test("files open as file URLs, link files as their web address, missing files not at all", () => {
  const page = write("page.html", "<h1>hi</h1>");
  const shortcut = write("site.url", "[InternetShortcut]\r\nURL=https://example.com/a?b=1\r\n");
  const webloc = write("site.webloc", '<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>https://example.org/x?a=1&amp;b=2</string></dict></plist>');
  const items = droppedFiles([page, shortcut, webloc, join(folder, "gone.html"), "relative.html"], "links");
  assert.deepEqual(items, [
    { kind: "file", url: pathToFileURL(page).href },
    { kind: "url", url: "https://example.com/a?b=1" },
    { kind: "url", url: "https://example.org/x?a=1&b=2" },
  ]);
});

test("a link file pointing anywhere but the web opens nothing", () => {
  assert.equal(linkTarget(write("local.url", "[InternetShortcut]\nURL=file:///etc/passwd\n")), null);
  assert.equal(linkTarget(write("huge.url", `URL=https://example.com/\n${"x".repeat(70 * 1024)}`)), null);
});

test("an extension drop takes only CRX packages, all or nothing", () => {
  const crx = write("one.crx", "Cr24");
  const other = write("two.zip", "PK");
  assert.deepEqual(droppedFiles([crx], "extensionPackages"), [{ kind: "file", url: pathToFileURL(crx).href }]);
  assert.deepEqual(droppedFiles([crx, other], "extensionPackages"), []);
});
