import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { mergeFirefoxFavicons, pngSize } from "../../../../../packages/expo-windows/src/import/firefoxFavicons.ts";
import { zenFavicons } from "../../../../../packages/expo-windows/src/import/zenSidebar.ts";

const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, Buffer.from(body), Buffer.alloc(4)]);
};
const handMade = (width, height = width, { chunks = ["IHDR", "IDAT", "IEND"], ihdrLength = 13, trailing = [] } = {}) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = chunks.map((name) => (name === "IHDR" ? chunk("IHDR", ihdr.subarray(0, ihdrLength)) : name === "IDAT" ? chunk("IDAT", [1, 2, 3, 4]) : name === "IEND" ? chunk("IEND", []) : chunk(name, [9])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...parts, Buffer.from(trailing)]);
};
const png = (width, height = width) => handMade(width, height);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

const cell = (value) => (value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : typeof value === "bigint" ? Number(value) : value);

function host() {
  const open = new Map();
  let next = 0;
  const run = (db, queries) => ({
    results: queries.map(({ sql, args = [], limit }) => {
      const statement = db.prepare(sql);
      const columns = statement.columns().map((c) => c.name);
      return { columns, rows: statement.all(...args).slice(0, limit ?? Infinity).map((row) => columns.map((c) => cell(row[c]))) };
    }),
  });
  return {
    open,
    async openSnapshot(path) {
      try {
        const db = new DatabaseSync(path.replaceAll("\\", "/"), { readOnly: true });
        const id = String(next++);
        open.set(id, db);
        return { id };
      } catch {
        return { failure: "missing" };
      }
    },
    async querySnapshot(id, queries) {
      return run(open.get(id), queries);
    },
    closeSnapshot(id) {
      open.get(id)?.close();
      open.delete(id);
    },
  };
}

function profile(rows, visits = []) {
  const dir = mkdtempSync(join(tmpdir(), "windows-firefox-favicons-"));
  folders.push(dir);
  const icons = new DatabaseSync(join(dir, "favicons.sqlite"));
  icons.exec(`CREATE TABLE moz_icons (id INTEGER PRIMARY KEY, icon_url TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, root INTEGER NOT NULL DEFAULT 0, data BLOB);
    CREATE TABLE moz_pages_w_icons (id INTEGER PRIMARY KEY, page_url TEXT NOT NULL);
    CREATE TABLE moz_icons_to_pages (page_id INTEGER NOT NULL, icon_id INTEGER NOT NULL, PRIMARY KEY (page_id, icon_id)) WITHOUT ROWID;`);
  const pages = new Map();
  rows.forEach((row, i) => {
    icons.prepare("INSERT INTO moz_icons (id, icon_url, width, root, data) VALUES (?, ?, ?, ?, ?)").run(i + 1, row.icon, row.width ?? 16, row.root ? 1 : 0, row.asText ? row.data.toString("latin1") : row.data);
    if (!row.page) return;
    if (!pages.has(row.page)) {
      pages.set(row.page, pages.size + 1);
      icons.prepare("INSERT INTO moz_pages_w_icons (id, page_url) VALUES (?, ?)").run(pages.get(row.page), row.page);
    }
    icons.prepare("INSERT INTO moz_icons_to_pages (page_id, icon_id) VALUES (?, ?)").run(pages.get(row.page), i + 1);
  });
  icons.close();
  const places = new DatabaseSync(join(dir, "places.sqlite"));
  places.exec("CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, rev_host TEXT, last_visit_date INTEGER); CREATE INDEX moz_places_hostindex ON moz_places (rev_host);");
  for (const [url, at] of visits) places.prepare("INSERT INTO moz_places (url, rev_host, last_visit_date) VALUES (?, ?, ?)").run(url, `${[...new URL(url).hostname.replace(/^\[|\]$/g, "")].reverse().join("")}.`, at);
  places.close();
  return dir;
}

const read = (dir, pages, known = [], cancelled) => mergeFirefoxFavicons(host(), dir, pages, known, cancelled);

test("the real PNG header decides, not the width column, and only PNGs up to 64 px come over", async () => {
  const dir = profile([
    { page: "https://a.test/", icon: "https://a.test/lies-small.png", width: 16, data: png(128) },
    { page: "https://a.test/", icon: "https://a.test/lies-big.png", width: 512, data: png(32) },
    { page: "https://a.test/", icon: "https://a.test/16.png", width: 16, data: png(16) },
    { page: "https://a.test/", icon: "https://a.test/tall.png", width: 32, data: png(32, 96) },
    { page: "https://big.test/", icon: "https://big.test/96.png", width: 32, data: png(96) },
    { page: "https://jpeg.test/", icon: "https://jpeg.test/i.jpg", width: 32, data: jpeg },
    { page: "https://svg.test/", icon: "https://svg.test/i.svg", width: 65535, data: svg },
    { page: "https://text.test/", icon: "https://text.test/i.png", width: 32, data: png(32), asText: true },
    { page: "https://short.test/", icon: "https://short.test/i.png", width: 32, data: png(32).subarray(0, 8) },
    { page: "https://huge.test/", icon: "https://huge.test/i.png", width: 32, data: Buffer.concat([png(32), Buffer.alloc(16 * 1024)]) },
  ]);
  const icons = await read(dir, ["https://a.test/", "https://big.test/", "https://jpeg.test/", "https://svg.test/", "https://text.test/", "https://short.test/", "https://huge.test/"]);
  assert.deepEqual(icons.map((f) => f.icon), ["https://a.test/lies-big.png"]);
  assert.deepEqual(pngSize(Buffer.from(icons[0].png, "base64")), { width: 32, height: 32 });
});

test("own page, then a valid root icon, then the home page, then the most recently visited pages", async () => {
  const dir = profile(
    [
      { page: "https://own.test/a", icon: "https://own.test/a.png", data: png(16) },
      { icon: "https://own.test/favicon.ico", data: png(32), root: true },
      { icon: "http://www.alias.test/favicon.ico", data: png(16), root: true },
      { icon: "https://query.test/favicon.ico?v=2", data: png(16), root: true },
      { icon: "https://path.test/icon.png", data: png(16), root: true },
      { icon: "ftp://ftp.test/favicon.ico", data: png(16), root: true },
      { icon: "https://port.test:8443/favicon.ico", data: png(16), root: true },
      { icon: "https://default-port.test:443/favicon.ico", data: png(16), root: true },
      { icon: "https://xn--bcher-kva.test/favicon.ico", data: png(16), root: true },
      { icon: "https://flag.test/favicon.ico", data: png(16), root: false },
      { icon: "https://user@userinfo.test/favicon.ico", data: png(16), root: true },
      { icon: "https://fragment.test/favicon.ico#x", data: png(16), root: true },
      { page: "https://home.test/", icon: "https://home.test/home.png", data: png(16) },
      { page: "https://home.test/recent", icon: "https://home.test/recent.png", data: png(16) },
      { page: "https://recent.test/old", icon: "https://recent.test/old.png", data: png(16) },
      { page: "https://recent.test/new", icon: "https://recent.test/new.png", data: png(16) },
      { page: "https://recent.test/unvisited", icon: "https://recent.test/unvisited.png", data: png(16) },
      { page: "http://recent.test/other-scheme", icon: "http://recent.test/other-scheme.png", data: png(16) },
      { page: "https://recent.test.evil/", icon: "https://recent.test.evil/x.png", data: png(16) },
    ],
    [
      ["https://home.test/recent", 900],
      ["https://recent.test/old", 100],
      ["https://recent.test/new", 200],
      ["http://recent.test/other-scheme", 999],
      ["https://recent.test.evil/", 999],
    ],
  );
  const icons = await read(dir, [
    "https://own.test/a", "https://own.test/b", "https://alias.test/page", "https://query.test/", "https://path.test/",
    "https://ftp.test/", "https://port.test/", "https://default-port.test/", "https://xn--bcher-kva.test/x", "https://Bücher.test/y", "https://flag.test/",
    "https://userinfo.test/", "https://fragment.test/", "https://home.test/deep", "https://recent.test/deep",
  ]);
  assert.deepEqual(Object.fromEntries(icons.map((f) => [f.page, f.icon])), {
    "https://own.test/a": "https://own.test/a.png",
    "https://own.test/b": "https://own.test/favicon.ico",
    "https://alias.test/page": "http://www.alias.test/favicon.ico",
    "https://default-port.test/": "https://default-port.test:443/favicon.ico",
    "https://xn--bcher-kva.test/x": "https://xn--bcher-kva.test/favicon.ico",
    "https://home.test/deep": "https://home.test/home.png",
    "https://recent.test/deep": "https://recent.test/new.png",
  });
});

test("Zen's icons are kept, pages count once per fragment-free address, and the cap and budget span both", async () => {
  const dir = profile([
    { page: "https://kept.test/", icon: "https://kept.test/db.png", data: png(16) },
    { page: "https://frag.test/x", icon: "https://frag.test/x.png", data: png(16) },
    { page: "https://a.test/", icon: "https://a.test/i.png", data: png(16) },
    { page: "https://b.test/", icon: "https://b.test/i.png", data: png(16) },
  ]);
  const zen = [
    { page: "https://kept.test/#zen", icon: "https://kept.test/favicon.ico", png: "AAAA" },
    { page: "https://kept.test/", icon: "dup", png: "BBBB" },
  ];
  const icons = await read(dir, ["https://kept.test/", "https://frag.test/x#1", "https://frag.test/x#2"], zen);
  assert.deepEqual(icons.map((f) => f.page), ["https://kept.test/#zen", "https://frag.test/x#1"]);
  const many = Array.from({ length: 999 }, (_, i) => ({ page: `https://zen${i}.test/`, icon: "z", png: "AAAA" }));
  const capped = await read(dir, ["https://a.test/", "https://b.test/"], many);
  assert.equal(capped.length, 1000);
  assert.equal(capped.at(-1).page, "https://a.test/");
  const full = [{ page: "https://zen.test/", icon: "z", png: "A".repeat(6 * 1024 * 1024) }];
  assert.deepEqual((await read(dir, ["https://a.test/"], full)).map((f) => f.page), ["https://zen.test/"]);
});

test("only a complete PNG chunk structure counts, and the next candidate is tried", async () => {
  const dir = profile([
    { page: "https://cut.test/", icon: "https://cut.test/64-cut.png", width: 64, data: png(64).subarray(0, 40) },
    { page: "https://cut.test/", icon: "https://cut.test/16.png", width: 16, data: png(16) },
    { page: "https://no-end.test/", icon: "https://no-end.test/i.png", data: handMade(32, 32, { chunks: ["IHDR", "IDAT"] }) },
    { page: "https://no-data.test/", icon: "https://no-data.test/i.png", data: handMade(32, 32, { chunks: ["IHDR", "IEND"] }) },
    { page: "https://trailing.test/", icon: "https://trailing.test/i.png", data: handMade(32, 32, { trailing: [0] }) },
    { page: "https://short-ihdr.test/", icon: "https://short-ihdr.test/i.png", data: handMade(32, 32, { ihdrLength: 12 }) },
    { page: "https://two-ihdr.test/", icon: "https://two-ihdr.test/i.png", data: handMade(32, 32, { chunks: ["IHDR", "IHDR", "IDAT", "IEND"] }) },
    { page: "https://overrun.test/", icon: "https://overrun.test/i.png", data: Buffer.concat([handMade(32, 32, { chunks: ["IHDR", "IDAT"] }), Buffer.from([0, 0, 1, 0]), Buffer.from("IEND")]) },
    { page: "https://extra.test/", icon: "https://extra.test/i.png", data: handMade(32, 32, { chunks: ["IHDR", "tEXt", "IDAT", "IEND"] }) },
  ]);
  const icons = await read(dir, ["https://cut.test/", "https://no-end.test/", "https://no-data.test/", "https://trailing.test/", "https://short-ihdr.test/", "https://two-ihdr.test/", "https://overrun.test/", "https://extra.test/"]);
  assert.deepEqual(icons.map((f) => f.icon), ["https://cut.test/16.png", "https://extra.test/i.png"]);
});

test("Zen session icons match by fragment-free address and count once", () => {
  const big = "A".repeat(6 * 1024 * 1024 - 6);
  const icons = [
    { page: "https://a.test/#tab", icon: "a", png: "AAAA" },
    { page: "https://a.test/", icon: "a-again", png: big },
    { page: "https://b.test/", icon: "b", png: big },
    { page: "https://c.test/", icon: "c", png: "AAAA" },
    { page: "https://other.test/", icon: "x", png: "AAAA" },
  ];
  assert.deepEqual(zenFavicons({ favicons: icons }, ["https://a.test/", "https://b.test/#x", "https://c.test/"]).map((f) => f.icon), ["a", "b"]);
  const many = Array.from({ length: 1005 }, (_, i) => ({ page: `https://p${i}.test/`, icon: String(i), png: "AAAA" }));
  assert.equal(zenFavicons({ favicons: many }, many.map((f) => f.page)).length, 1000);
});

test("hosts and ports must be ASCII before they are normalised", async () => {
  const dir = profile([
    { icon: "https://Kelvin.test/favicon.ico", data: png(16), root: true },
    { icon: "https://plus.test:+8443/favicon.ico", data: png(16), root: true },
    { icon: "https://wide.test:８443/favicon.ico", data: png(16), root: true },
    { icon: "https://port.test:8443/favicon.ico", data: png(16), root: true },
  ]);
  const icons = await read(dir, ["https://kelvin.test/", "https://plus.test:8443/", "https://wide.test:8443/", "https://port.test:8443/x"]);
  assert.deepEqual(icons.map((f) => f.icon), ["https://port.test:8443/favicon.ico"]);
});

test("IPv6 and unparsed pages still get their own icons", async () => {
  const dir = profile(
    [
      { page: "http://[::1]/a", icon: "http://[::1]/a.png", data: png(16) },
      { page: "http://[::1]/", icon: "http://[::1]/home.png", data: png(16) },
      { icon: "http://[::1]:8080/favicon.ico", data: png(16), root: true },
      { page: "https://odd host.test/x", icon: "https://odd host.test/x.png", data: png(16) },
      { page: "http://[fe80::1]/old", icon: "http://[fe80::1]/old.png", data: png(16) },
    ],
    [["http://[fe80::1]/old", 5]],
  );
  const icons = await read(dir, ["http://[::1]/a", "http://[::1]/b", "http://[::1]:8080/c", "https://odd host.test/x", "http://[fe80::1]/new"]);
  assert.deepEqual(Object.fromEntries(icons.map((f) => [f.page, f.icon])), {
    "http://[::1]/a": "http://[::1]/a.png",
    "http://[::1]/b": "http://[::1]/home.png",
    "http://[::1]:8080/c": "http://[::1]:8080/favicon.ico",
    "https://odd host.test/x": "https://odd host.test/x.png",
    "http://[fe80::1]/new": "http://[fe80::1]/old.png",
  });
});

test("every exact address of a fragment-free page is tried before the site", async () => {
  const dir = profile([
    { page: "https://docs.test/report#second", icon: "https://docs.test/second.png", data: png(16) },
    { page: "https://cut.test/page#x", icon: "https://cut.test/cut.png", data: png(64).subarray(0, 40) },
    { page: "https://cut.test/page", icon: "https://cut.test/page.png", data: png(16) },
    { page: "https://cut.test/", icon: "https://cut.test/home.png", data: png(32) },
  ]);
  const icons = await read(dir, ["https://docs.test/report#first", "https://docs.test/report#second", "https://cut.test/page#x"]);
  assert.deepEqual(icons.map((f) => [f.page, f.icon]), [
    ["https://docs.test/report#first", "https://docs.test/second.png"],
    ["https://cut.test/page#x", "https://cut.test/page.png"],
  ]);
});

test("bound addresses, a missing database and cancellation", async () => {
  const quoted = "https://quote.test/it's?q='); DROP TABLE moz_icons; --";
  const dir = profile([{ page: quoted, icon: "https://quote.test/i.png", data: png(16) }]);
  assert.deepEqual((await read(dir, [quoted, "file:///tmp/a.html"])).map((f) => f.page), [quoted]);
  assert.deepEqual(await read(join(dir, "missing"), [quoted]), []);
  await assert.rejects(read(dir, [quoted], [], () => true), (error) => error.code === "cancelled");
});
