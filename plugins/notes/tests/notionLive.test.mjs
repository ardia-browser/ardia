import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, until } from "./support/build.mjs";

const M = await load();

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SOURCE = readFileSync(fileURLToPath(new URL("../src/main/import/sources/notionLive.ts", import.meta.url)), "utf8");
const SPACES = JSON.parse(readFileSync(join(FIX, "notion-live/getSpaces.json"), "utf8"));
const ACME = "0b1d2c3e-4f50-4617-8899-aabbccddeeff";
const GUEST = "9e8d7c6b-5a49-4382-9170-605f4e3d2c1b";
const LOCKED = "11111111-2222-4333-8444-555555555555";
const USER = "5f1c8a7e-2b1d-4c6e-9a10-0c2f3d4e5f60";
const UNAUTHORIZED = JSON.stringify({ isNotionError: true, name: "UnauthorizedError", message: "Something went wrong. (401)" });
const WRITES = ["saveTransactions", "saveTransactionsFanout", "submitTransaction", "enqueueTask", "markNotificationsRead", "getTasks", "deleteBlocks", "setPageNotificationsAsRead", "createSpace", "inviteGuestsToSpace"];

const id = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROOT_A = "a0000000-0000-4000-8000-000000000001";
const ROOT_B = "a0000000-0000-4000-8000-000000000002";
const PRIVATE = "a0000000-0000-4000-8000-000000000003";
const HOME = "a0000000-0000-4000-8000-0000000000aa";
const MY_TASKS = "a0000000-0000-4000-8000-0000000000ab";
const TEAM = "7e000000-0000-4000-8000-000000000001";
const TEAM_PAGE = "a0000000-0000-4000-8000-000000000004";
const ORPHAN = "a0000000-0000-4000-8000-000000000005";
const CHILD = "a0000000-0000-4000-8000-000000000006";
const SHARED = "a0000000-0000-4000-8000-000000000007";
const DB_BLOCK = "b0000000-0000-4000-8000-000000000001";
const IMAGE = "b0000000-0000-4000-8000-000000000002";
const TEXT = "b0000000-0000-4000-8000-000000000003";
const COLL = "c0000000-0000-4000-8000-000000000001";
const VIEW = "d0000000-0000-4000-8000-000000000001";
const OTHER = "e0000000-0000-4000-8000-000000000001";
const ATTACHMENT = "attachment:28250a91-5ffc-4892-ae0f-aef44820998d:flow.jpg";
const S3_FILE = "https://prod-files-secure.s3.us-west-2.amazonaws.com/630feb2f/d1459a3f/notes.pdf";
const UNSPLASH = "https://images.unsplash.com/photo-1?ixlib=rb-4.0.3&w=3600";
const ICON = "/icons/checkmark_green.svg";
const COVER = "/images/page-cover/woodcuts_1.jpg";
const DB_ICON = "/icons/user-circle_gray.svg";
const VIEW_ICON = "/icons/target_gray.svg";

function workspace({ rows = 30 } = {}) {
  const base = { space_id: ACME, alive: true, version: 1, created_by_id: USER, last_edited_by_id: USER };
  const blocks = {};
  const put = (b) => (blocks[b.id] = { ...base, ...b });
  const rowIds = Array.from({ length: rows }, (_, i) => id("f", i + 1));
  put({ id: ROOT_A, type: "page", parent_table: "space", parent_id: ACME, properties: { title: [["Home"]] }, content: [TEXT, IMAGE, DB_BLOCK, CHILD] });
  put({ id: ROOT_B, type: "page", parent_table: "space", parent_id: ACME, properties: { title: [["Projects"]] }, format: { page_icon: ICON, page_cover: COVER }, content: [] });
  put({ id: PRIVATE, type: "page", parent_table: "space", parent_id: ACME, properties: { title: [["Private"]] }, content: [] });
  put({ id: HOME, type: "personal_home_page", parent_table: "space", parent_id: ACME, content: [MY_TASKS] });
  put({ id: MY_TASKS, type: "collection_view_page", parent_table: "block", parent_id: HOME, view_ids: [], content: [] });
  put({ id: TEAM_PAGE, type: "page", parent_table: "team", parent_id: TEAM, properties: { title: [["Team wiki"]] }, content: [] });
  put({ id: ORPHAN, type: "page", parent_table: "block", parent_id: "a0000000-0000-4000-8000-0000000000ff", properties: { title: [["Reading list"]] }, content: [] });
  put({ id: SHARED, type: "page", parent_table: "block", parent_id: "a0000000-0000-4000-8000-0000000000fe", properties: { title: [["Shared notes"]] }, content: [] });
  put({ id: CHILD, type: "page", parent_table: "block", parent_id: ROOT_A, properties: { title: [["Child"]] }, format: { alias_pointer: { id: ROOT_B, table: "block", spaceId: ACME } }, content: [] });
  put({ id: TEXT, type: "text", parent_table: "block", parent_id: ROOT_A, properties: { title: [["See "], ["‣", [["p", PRIVATE]]], ["‣", [["u", OTHER]]]] } });
  put({ id: IMAGE, type: "image", parent_table: "block", parent_id: ROOT_A, properties: { source: [[ATTACHMENT]], title: [["flow.jpg"]] }, format: { display_source: ATTACHMENT } });
  put({ id: DB_BLOCK, type: "collection_view", parent_table: "block", parent_id: ROOT_A, collection_id: COLL, view_ids: [VIEW] });
  rowIds.forEach((r, i) => put({ id: r, type: "page", parent_table: "collection", parent_id: COLL, properties: { title: [[`Row ${i + 1}`]], ...(i === 0 ? { "a:b": [["notes.pdf", [["a", S3_FILE]]]] } : {}) }, content: [] }));
  const collections = { [COLL]: { id: COLL, version: 1, alive: true, space_id: ACME, parent_id: DB_BLOCK, parent_table: "block", name: [["Leads"]], icon: DB_ICON, cover: UNSPLASH, schema: { title: { name: "Name", type: "title" }, "a:b": { name: "Files", type: "file" } } } };
  const views = { [VIEW]: { id: VIEW, version: 1, alive: true, space_id: ACME, type: "table", name: "All", format: { collection_view_icon: VIEW_ICON } } };
  const users = { [USER]: { id: USER, version: 1, name: "Ada Lovelace" }, [OTHER]: { id: OTHER, version: 1, name: "Grace" } };
  const teams = { [TEAM]: { id: TEAM, version: 1, space_id: ACME, name: "Team", team_pages: [TEAM_PAGE] } };
  return { blocks, collections, views, users, teams, rows: { [COLL]: rowIds }, search: [ORPHAN, ROOT_A] };
}

const TABLES = { block: "blocks", collection: "collections", collection_view: "views", notion_user: "users", team: "teams" };

function fakeNotion(files, options = {}) {
  const ws = options.workspace ?? workspace(options);
  const state = { signedIn: true, origins: { "https://app.notion.com": true, "https://www.notion.so": true }, calls: [], writes: [], downloads: [], active: 0, maxActive: 0, throttled: 0, sessions: 0, ...options };
  const wrap = (v) => ({ value: { value: v, role: "editor" }, spaceId: ACME });
  const json = (status, value, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { "content-type": "application/json", ...headers }, body: typeof value === "string" ? value : JSON.stringify(value) });
  const tooLarge = () => Object.assign(new Error("The response is too large."), { code: "too_large" });
  const answer = async (origin, endpoint, body) => {
    if (!state.origins[origin]) return json(404, "Not found");
    if (!state.signedIn) return json(401, UNAUTHORIZED);
    if (!M.NOTION_READ_ENDPOINTS.includes(endpoint)) {
      state.writes.push(endpoint);
      return json(200, {});
    }
    if (endpoint === "getSpaces") return json(200, SPACES);
    if (state.throttle && state.throttled < state.throttle && endpoint === "syncRecordValuesMain") {
      state.throttled++;
      return json(429, { message: "Slow down" }, { "retry-after": String(state.retryAfter ?? 2) });
    }
    if (state.hold && endpoint === state.holdOn) await state.hold;
    if (endpoint === "syncRecordValuesMain") {
      if (state.maxPerSync && body.requests.length > state.maxPerSync) throw tooLarge();
      const recordMap = {};
      for (const { pointer } of body.requests) {
        assert.equal(pointer.spaceId, ACME);
        const v = ws[TABLES[pointer.table]]?.[pointer.id];
        if (v) (recordMap[pointer.table] ??= {})[pointer.id] = wrap(v);
      }
      return json(200, { recordMap });
    }
    if (endpoint === "queryCollection") {
      const collectionId = body.source?.id ?? body.collection?.id;
      const limit = body.loader.reducers.collection_group_results.limit;
      state.queries = [...(state.queries ?? []), limit];
      if (state.queryTooLargeOver && limit > state.queryTooLargeOver) throw tooLarge();
      const all = ws.rows[collectionId] ?? [];
      const page = all.slice(0, limit);
      const block = Object.fromEntries(page.slice(0, 5).map((r) => [r, wrap(ws.blocks[r])]));
      return json(200, { result: { type: "reducer", reducerResults: { collection_group_results: { type: "results", blockIds: page, hasMore: all.length > limit } } }, recordMap: { block } });
    }
    if (endpoint === "getSignedFileUrls") {
      return json(200, { signedUrls: body.urls.map((u) => (u.url.includes("unsigned") ? null : `https://file.notion.com/f/f/${ACME}/${encodeURIComponent(u.url.split(/[/:]/).pop())}?table=${u.permissionRecord.table}&id=${u.permissionRecord.id}&signature=x`)) });
    }
    if (endpoint === "search") return json(200, { results: ws.search.map((r) => ({ id: r })), recordMap: {} });
    return json(404, "Not found");
  };
  const sites = {
    async available() {
      return state.available ?? true;
    },
    async session() {
      state.sessions++;
      return `s${state.sessions}`;
    },
    async fetch(url, init) {
      if (state.fetchError) throw state.fetchError;
      const found = /^(https:\/\/[^/]+)\/api\/v3\/(\w+)$/.exec(url);
      assert.ok(found, url);
      const [, origin, endpoint] = found;
      state.calls.push({ origin, endpoint, session: init.session });
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/json");
      assert.ok(!Object.keys(init.headers).some((h) => /cookie|authorization/i.test(h)), "Notes never sends credentials itself");
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await new Promise((r) => setTimeout(r, 0));
        return await answer(origin, endpoint, JSON.parse(init.body));
      } finally {
        state.active--;
      }
    },
    async download(url, options) {
      const host = new URL(url).host;
      assert.ok(["file.notion.com", "app.notion.com", "www.notion.so", "images.unsplash.com"].includes(host), url);
      state.downloads.push({ url, to: options.to, session: options.session });
      let cancelled = false;
      const bytes = new TextEncoder().encode(`bytes of ${url}`);
      const done = (async () => {
        if (state.holdDownload) await state.holdDownload;
        if (cancelled) throw Object.assign(new Error("The download was cancelled."), { code: "cancelled" });
        if (state.refuseDownload && url.includes(state.refuseDownload)) throw Object.assign(new Error("redirect"), { code: "refused" });
        await files.write(options.to, Buffer.from(bytes).toString("base64"));
        return { size: bytes.length };
      })();
      return { id: `d${state.downloads.length}`, done, cancel: async () => void (cancelled = true) };
    },
  };
  return { state, sites, ws };
}

const scratch = () => mkdtempSync(join(tmpdir(), "notes-notion-live-"));
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function dataFiles() {
  const dir = scratch();
  mkdirSync(join(dir, "data"), { recursive: true });
  const files = M.nodeFiles({ data: join(dir, "data") });
  cleanups.push(() => files.detach());
  return { dir, files };
}

function live(sites, files, limits = {}) {
  let clock = 1_800_000_000_000;
  const sleeps = [];
  const notion = new M.NotionLive({
    sites,
    removeFile: async (path) => (files ? files.remove(path) : true),
    listFiles: files ? (dir) => files.list(dir, { recursive: true }) : undefined,
    now: () => (clock += 10),
    sleep: (ms) => (sleeps.push(ms), new Promise((resolve) => setTimeout(resolve, 1))),
    log: () => {},
    limits: { minGapMs: 0, ...limits },
  });
  return { notion, sleeps };
}

const finished = (notion) => until(() => (["ready", "failed", "cancelled"].includes(notion.status()?.stage) ? notion.status() : null), 10_000, "the crawl to end");
const leftIn = (dir) => (existsSync(join(dir, "data", "notion-live")) ? readdirSync(join(dir, "data", "notion-live"), { recursive: true }) : []);

test("the recorded getSpaces shape becomes the account and its workspaces; guests and locked ones can't be imported", () => {
  const found = M.spacesFrom(SPACES);
  assert.deepEqual(found.user, { id: USER, name: "Ada Lovelace", email: "ada@example.com" });
  assert.deepEqual(
    found.spaces.map((s) => [s.name, s.role, s.canImport, s.icon]),
    [
      ["Acme Inc", "owner", true, "🚀"],
      ["Client wiki", "guest", false, ""],
      ["Locked down", "member", false, ""],
    ],
  );
  for (const s of found.spaces) assert.doesNotMatch(s.reason ?? "", /export|email/i);
  assert.deepEqual(M.rootsFrom(SPACES, ACME), { pages: [ROOT_A, ROOT_B, HOME, PRIVATE], seeds: [SHARED], teamIds: [TEAM], teams: {} });
});

test("only read endpoints: the allowlist refuses every write, a whole crawl calls only reads, and the source names no write", async () => {
  for (const endpoint of WRITES) {
    assert.equal(M.isReadEndpoint(endpoint), false, endpoint);
    assert.throws(() => M.notionReadUrl("https://app.notion.com", endpoint), /only reads/);
    assert.doesNotMatch(SOURCE, new RegExp(`\\b${endpoint}\\b`), `${endpoint} appears in notionLive.ts`);
  }
  assert.deepEqual([...M.NOTION_READ_ENDPOINTS].sort(), ["getSignedFileUrls", "getSpaces", "queryCollection", "search", "syncRecordValuesMain"]);
  assert.throws(() => M.notionReadUrl("https://evil.example", "getSpaces"), /Notion's own site/);
  const { files } = dataFiles();
  const n = fakeNotion(files);
  const { notion } = live(n.sites, files);
  await notion.start(ACME);
  assert.equal((await finished(notion)).stage, "ready");
  assert.deepEqual(n.state.writes, []);
  assert.ok(n.state.calls.every((c) => M.NOTION_READ_ENDPOINTS.includes(c.endpoint)));
  assert.ok(n.state.calls.every((c) => c.session === "s1"), "every request keeps the run's session");
});

test("a crawl reads every root, descendant, database, view, row, user and file, unwrapped, at most 4 requests at once", async () => {
  const { dir, files } = dataFiles();
  const n = fakeNotion(files, { maxPerSync: 7 });
  const { notion } = live(n.sites, files, { recordsPerSync: 20 });
  const started = await notion.start(ACME);
  assert.equal(started.stage, "reading");
  assert.equal(started.spaceName, "Acme Inc");
  const done = await finished(notion);
  assert.equal(done.stage, "ready", done.error);
  assert.ok(n.state.maxActive <= 4, `max in flight ${n.state.maxActive}`);
  assert.ok(n.state.maxActive >= 2, "requests run in parallel");
  const handoff = notion.takeRecords();
  assert.ok(handoff);
  assert.equal(notion.takeRecords(), null, "handed over once");
  assert.equal(notion.status().stage, "idle");
  const r = handoff.records;
  assert.equal(r.spaceId, ACME);
  for (const want of Object.keys(n.ws.blocks).filter((b) => b !== MY_TASKS)) assert.ok(r.blocks[want], `block ${want}`);
  assert.equal(r.blocks[MY_TASKS], undefined, "the personal home's system pages aren't crawled");
  assert.equal(r.blocks[ROOT_A].properties.title[0][0], "Home", "values are unwrapped");
  assert.ok(r.collections[COLL] && r.views[VIEW]);
  assert.deepEqual(Object.keys(r.users).sort(), [USER, OTHER].sort());
  assert.deepEqual(r.rows[COLL], n.ws.rows[COLL]);
  assert.deepEqual(r.rootIds.slice(0, 4), [ROOT_A, ROOT_B, PRIVATE, TEAM_PAGE], "listed roots first, in sidebar order, without the personal home");
  assert.deepEqual(r.rootIds.slice(4).sort(), [ORPHAN, SHARED].sort(), "then pages whose parent Notes couldn't read");
  assert.equal(done.pagesRead, done.pagesFound);
  assert.equal(done.databases, 1);
  assert.equal(done.rows, 30);
  const keys = Object.keys(r.files).sort();
  assert.deepEqual(keys, [ATTACHMENT, S3_FILE, UNSPLASH, ICON, COVER, DB_ICON, VIEW_ICON].sort());
  assert.equal(done.filesDone, 7);
  for (const [key, f] of Object.entries(r.files)) {
    assert.match(f.path, /^notion-live\/[0-9a-f-]+-\d+\/files\/\d+-/);
    assert.equal(readFileSync(join(dir, "data", f.path), "utf8").length, f.size, key);
  }
  assert.equal(r.files[ATTACHMENT].name, "flow.jpg");
  assert.equal(r.files[ICON].name, "checkmark_green.svg");
  const byUrl = n.state.downloads.map((d) => d.url);
  assert.ok(byUrl.includes(`https://app.notion.com${ICON}`), "built-in icons come from the crawl's origin");
  assert.ok(byUrl.includes(`https://app.notion.com${COVER}`));
  assert.ok(byUrl.includes(UNSPLASH));
  assert.ok(byUrl.some((u) => u.startsWith("https://file.notion.com/") && u.includes("table=collection") === false && u.includes("flow.jpg")));
  assert.equal(n.state.downloads.filter((d) => d.url.endsWith(ICON)).length, 1, "one download per distinct asset");
  await handoff.release();
  assert.deepEqual(leftIn(dir), [], "release removes the files and folders");
});

test("rows page through queryCollection with a growing limit; an answer too large shrinks it and says some rows stayed", async () => {
  const { files } = dataFiles();
  const n = fakeNotion(files, { rows: 2500 });
  const { notion } = live(n.sites, files);
  await notion.start(ACME);
  assert.equal((await finished(notion)).stage, "ready");
  assert.deepEqual(n.state.queries, [1000, 4000]);
  const whole = notion.takeRecords().records;
  assert.equal(whole.rows[COLL].length, 2500);
  assert.equal(whole.incomplete, undefined, "a database read to its end isn't marked incomplete");

  const capped = fakeNotion(files, { rows: 800, queryTooLargeOver: 300 });
  const c = live(capped.sites, files);
  await c.notion.start(ACME);
  const done = await finished(c.notion);
  assert.equal(done.stage, "ready", done.error);
  assert.deepEqual(capped.state.queries, [1000, 500, 250, 1000]);
  const cut = c.notion.takeRecords().records;
  assert.equal(cut.rows[COLL].length, 250);
  assert.deepEqual(cut.incomplete?.collections, [COLL], "a database cut short is marked so its missing rows aren't trashed");
  assert.match(done.note, /first 250/);
});

test("429 waits for Retry-After before trying again, and 401 midway ends with a plain sign-in reason", async () => {
  const { files } = dataFiles();
  const n = fakeNotion(files, { throttle: 3, retryAfter: 7 });
  const { notion, sleeps } = live(n.sites, files);
  await notion.start(ACME);
  assert.equal((await finished(notion)).stage, "ready");
  assert.equal(n.state.throttled, 3);
  assert.ok(sleeps.filter((ms) => ms >= 7000).length >= 3, `sleeps ${sleeps}`);

  const out = fakeNotion(files, { holdOn: "queryCollection" });
  let release;
  out.state.hold = new Promise((r) => (release = r));
  const o = live(out.sites, files);
  await o.notion.start(ACME);
  await until(() => out.state.calls.some((c) => c.endpoint === "queryCollection"), 5000, "the query");
  out.state.signedIn = false;
  release();
  const failed = await finished(o.notion);
  assert.equal(failed.stage, "failed");
  assert.match(failed.error, /sign-in ended/);
  assert.equal(o.notion.takeRecords(), null);
});

test("cancel stops at once mid-read and mid-download, makes no more requests and leaves no files", async () => {
  const { dir, files } = dataFiles();
  const n = fakeNotion(files, { holdOn: "queryCollection" });
  let release;
  n.state.hold = new Promise((r) => (release = r));
  const { notion } = live(n.sites, files);
  await notion.start(ACME);
  await until(() => n.state.calls.some((c) => c.endpoint === "queryCollection"), 5000, "the query");
  await notion.cancel();
  assert.equal((await finished(notion)).stage, "cancelled");
  const calls = n.state.calls.length;
  release();
  for (let tick = 0; tick < 20; tick++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(n.state.calls.length, calls, "nothing runs after cancel");
  assert.equal(notion.takeRecords(), null);

  const d = fakeNotion(files);
  let go;
  d.state.holdDownload = new Promise((r) => (go = r));
  const dl = live(d.sites, files);
  await dl.notion.start(ACME);
  await until(() => d.state.downloads.length > 0, 5000, "a download");
  await dl.notion.cancel();
  go();
  assert.equal((await finished(dl.notion)).stage, "cancelled");
  assert.deepEqual(leftIn(dir), []);
});

test("a time budget ends a crawl that runs too long with a clear reason, and removes what it fetched", async () => {
  const { dir, files } = dataFiles();
  const n = fakeNotion(files, { throttle: 100, retryAfter: 120 });
  const { notion } = live(n.sites, files, { budgetMs: 60_000 });
  await notion.start(ACME);
  const done = await finished(notion);
  assert.equal(done.stage, "failed");
  assert.match(done.error, /took more than 1 minute/);
  assert.deepEqual(leftIn(dir), []);
});

test("both origins: signed out on app.notion.com falls through to www.notion.so, which then serves every read and asset", async () => {
  const { files } = dataFiles();
  const n = fakeNotion(files);
  const { notion } = live(n.sites, files);
  n.state.signedIn = false;
  assert.deepEqual(await notion.account(true), { state: "signedOut" });
  n.state.signedIn = true;
  n.state.origins["https://app.notion.com"] = false;
  assert.equal((await notion.account(true)).state, "signedIn");
  n.state.calls.length = 0;
  await notion.start(ACME);
  assert.equal((await finished(notion)).stage, "ready");
  const crawlCalls = n.state.calls.filter((c) => c.endpoint !== "getSpaces");
  assert.ok(crawlCalls.length > 3);
  assert.ok(crawlCalls.every((c) => c.origin === "https://www.notion.so"));
  assert.equal(n.state.calls[0].origin, "https://app.notion.com", "app.notion.com is tried first");
  assert.ok(n.state.downloads.some((d) => d.url === `https://www.notion.so${ICON}`));
});

test("a guest or locked workspace, one the account can't see, or no sites at all never starts a crawl", async () => {
  const { files } = dataFiles();
  const n = fakeNotion(files);
  const { notion } = live(n.sites, files);
  await assert.rejects(notion.start(GUEST), /guest/);
  await assert.rejects(notion.start(LOCKED), /admins/);
  await assert.rejects(notion.start("22222222-2222-4222-8222-222222222222"), /isn't one/);
  assert.ok(!n.state.calls.some((c) => c.endpoint !== "getSpaces"));
  const none = live(null, files).notion;
  assert.deepEqual(await none.account(true), { state: "unsupported" });
  n.state.available = false;
  assert.deepEqual(await notion.account(true), { state: "unsupported" });
  const refused = fakeNotion(files, { fetchError: Object.assign(new Error("Open a regular (not private) Ardia window to use your sign-in."), { code: "no_window" }) });
  assert.deepEqual(await live(refused.sites, files).notion.account(true), { state: "unavailable", reason: "Open a regular (not private) Ardia window to use your sign-in." });
});

test("file refs: attachments, Notion's S3 and built-in assets are fetched; other hosts and paths that climb out are not", () => {
  assert.equal(M.needsSigning(ATTACHMENT), true);
  assert.equal(M.needsSigning(S3_FILE), true);
  assert.equal(M.needsSigning("https://example.com/a.png"), false);
  assert.equal(M.assetUrl(ICON, "https://app.notion.com"), `https://app.notion.com${ICON}`);
  assert.equal(M.assetUrl("/icons/../api/v3/getSpaces", "https://app.notion.com"), null);
  assert.equal(M.assetUrl("/api/v3/getSpaces", "https://app.notion.com"), null);
  assert.equal(M.assetUrl("//evil.example/x.png", "https://app.notion.com"), null);
  assert.equal(M.assetUrl(UNSPLASH, "https://app.notion.com"), UNSPLASH);
  assert.equal(M.assetUrl("https://images.unsplash.com.evil.example/x", "https://app.notion.com"), null);
  assert.equal(M.fileName("attachment:28250a91-5ffc-4892-ae0f-aef44820998d:../../a‮.png", "x"), "-..-a.png");
  assert.equal(M.fileName("https://prod-files-secure.s3.amazonaws.com/a/b/My%20File.pdf", "x"), "My File.pdf");
  assert.equal(M.crawlUnwrapRecord({ value: { value: { id: "__proto__", polluted: true } } }), null);
  assert.equal(M.crawlUnwrapRecord({ value: { value: [ROOT_A] } }), null);
  assert.deepEqual(M.crawlUnwrapRecord({ value: { value: { id: ROOT_A } } }), { id: ROOT_A });
  assert.deepEqual(M.crawlUnwrapRecord({ value: { id: ROOT_A, type: "page" } }), { id: ROOT_A, type: "page" });
  const refs = M.fileRefsOf({ id: IMAGE, type: "image", properties: { source: [["https://example.com/x.png"]] }, format: { page_icon: "🚀", page_cover: "https://example.com/c.png" } });
  assert.deepEqual(refs, []);
});

test("Notes wires notionImport, notionImportStatus and notionImportCancel to the crawler", async () => {
  const { files } = dataFiles();
  const storage = new Map();
  const n = fakeNotion(files);
  const notes = new M.Notes({
    files,
    storage: { get: async (k) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined), set: async (k, v) => void storage.set(k, structuredClone(v)) },
    setting: () => "",
    post: () => {},
    openPage: async () => {},
    openUrl: async () => {},
    store: { debounceMs: 5, rescanMs: 200 },
    sites: n.sites,
  });
  cleanups.push(() => notes.stop());
  await notes.start();
  assert.equal((await notes.call("notionAccount", { fresh: true })).state, "signedIn");
  await assert.rejects(notes.call("notionImport", { space: "nope" }));
  const started = await notes.call("notionImport", { space: ACME });
  assert.equal(started.stage, "reading");
  const ready = await until(async () => {
    const s = await notes.call("notionImportStatus", {});
    return ["ready", "failed"].includes(s.stage) ? s : null;
  }, 15_000, "the crawl");
  assert.equal(ready.stage, "ready", ready.error);
  assert.equal(await notes.call("notionImportCancel", {}), null);
  const handoff = notes.notion.takeRecords();
  assert.ok(handoff.records.blocks[ROOT_A]);
  await handoff.release();
});

test("roots follow the sidebar: workspace pages, then private pages in their own order", () => {
  const S = "b0000000-0000-4000-8000-000000000001";
  const [A, B, C] = ["b0000000-0000-4000-8000-00000000000a", "b0000000-0000-4000-8000-00000000000b", "b0000000-0000-4000-8000-00000000000c"];
  const answer = { u: { space: { [S]: { value: { value: { id: S, pages: [A, B, C] } } } }, space_view: { v: { value: { value: { id: "v", space_id: S, private_pages: [C, B] } } } } } };
  assert.deepEqual(M.rootsFrom(answer, S).pages, [A, C, B]);
});

test("a page whose ancestor sits in Notion's trash is not a root, while one under a page Notes can't read still is", async () => {
  const { files } = dataFiles();
  const ws = workspace();
  ws.blocks["a0000000-0000-4000-8000-0000000000ff"] = { id: "a0000000-0000-4000-8000-0000000000ff", type: "page", alive: false, version: 3, space_id: ACME, parent_table: "space", parent_id: ACME, properties: { title: [["Poke"]] }, content: [ORPHAN] };
  const n = fakeNotion(files, { workspace: ws });
  const { notion } = live(n.sites, files);
  await notion.start(ACME);
  const done = await finished(notion);
  assert.equal(done.stage, "ready", done.error);
  const r = notion.takeRecords().records;
  assert.ok(!r.rootIds.includes(ORPHAN), "the trashed hub is left out");
  assert.ok(r.rootIds.includes(SHARED), "a page under an unreadable parent is kept");
  assert.equal(r.blocks["a0000000-0000-4000-8000-0000000000ff"]?.alive, false, "the trashed ancestor travels along so the importer can tell");
});

test("when Ardia reports sites unsupported, Notion live import says so once, never calls Notion and never retries", async () => {
  const calls = [];
  const unsupported = () => Object.assign(new Error("Sites aren't available to plugins in this version of Ardia."), { code: "unsupported" });
  const sites = {
    available: async () => {
      calls.push("available");
      throw unsupported();
    },
    session: async () => {
      calls.push("session");
      throw unsupported();
    },
    fetch: async () => {
      calls.push("fetch");
      throw unsupported();
    },
    download: async () => {
      calls.push("download");
      throw unsupported();
    },
  };
  const { notion, sleeps } = live(sites, null);
  assert.deepEqual(await notion.account(true), { state: "unsupported" });
  assert.deepEqual(await notion.account(), { state: "unsupported" }, "the answer is cached");
  await assert.rejects(notion.start("11111111-1111-4111-8111-111111111111"), /Choose a file instead/);
  assert.deepEqual(calls.filter((c) => c !== "available"), [], "nothing past the availability check is called");
  assert.ok(calls.length <= 2, `availability was asked ${calls.length} times`);
  assert.deepEqual(sleeps, [], "no retry waits");
  assert.equal(notion.busy(), false);

  const answers = { available: async () => true, session: async () => "s1", fetch: async () => Promise.reject(unsupported()), download: async () => Promise.reject(unsupported()) };
  assert.deepEqual(await live(answers, null).notion.account(true), { state: "unsupported" }, "a fetch refused as unsupported reads the same");
});
