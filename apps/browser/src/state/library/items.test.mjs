import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TZ = "America/New_York";
const items = await import("./items.ts");
const { mediaItems, downloadItems, searchItems, dayGroups, folderItemPath } = items;

const download = (id, extra = {}) => ({
  id, url: `https://dl.example/${id}`, filename: id, path: `/Users/me/Downloads/${id}`, state: "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "", profile: "", startTime: 1, ...extra,
});
const visit = (url, title, lastVisit) => ({ url, title, favicon: null, visits: 1, lastVisit });
const ids = (items) => items.map((i) => i.id);
const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const titles = (groups) => groups.map((g) => g.title);
const urlsByGroup = (groups) => groups.map((g) => g.items.map((i) => i.url));

const DOWNLOADS = [
  download("photo.png", { mimeType: "image/png" }),
  download("clip", { mimeType: "video/mp4" }),
  download("song", { mimeType: "audio/mpeg" }),
  download("holiday.JPG"),
  download("talk.mp4"),
  download("podcast.mp3"),
  download("report.pdf", { mimeType: "application/pdf" }),
  download("notes.txt"),
  download("half.png", { mimeType: "image/png", state: "downloading" }),
  download("broken.mov", { mimeType: "video/quicktime", state: "failed" }),
  download("stopped.wav", { mimeType: "audio/wav", state: "cancelled" }),
  download("named-like-audio.mp3", { mimeType: "image/png" }),
];

test("Media shows finished images, videos and audio, by MIME type or by extension when the type is missing", () => {
  assert.deepEqual(new Set(ids(mediaItems(DOWNLOADS, "image"))), new Set(["photo.png", "holiday.JPG", "named-like-audio.mp3"]));
  assert.deepEqual(new Set(ids(mediaItems(DOWNLOADS, "video"))), new Set(["clip", "talk.mp4"]));
  assert.deepEqual(new Set(ids(mediaItems(DOWNLOADS, "audio"))), new Set(["song", "podcast.mp3"]));
  const all = mediaItems(DOWNLOADS, "all");
  assert.deepEqual(new Set(ids(all)), new Set(["photo.png", "holiday.JPG", "named-like-audio.mp3", "clip", "talk.mp4", "song", "podcast.mp3"]),
    "All is the three kinds together; documents, unfinished, failed and cancelled downloads stay out");
  for (const item of all) assert.ok(["image", "video", "audio"].includes(item.media));
  assert.equal(all.find((i) => i.id === "song").media, "audio");
  assert.deepEqual(mediaItems([], "all"), []);
});

const file = (name, kind, added, extra = {}) => ({ path: `/Users/me/Downloads/${name}`, name, size: 10, added, modified: added, kind, ...extra });

test("Media merges the Downloads folder's own files with browser downloads, newest first and each file once", () => {
  const downloads = [
    download("photo.png", { mimeType: "image/png", startTime: 300 }),
    download("talk.mp4", { startTime: 100 }),
  ];
  const files = [
    file("screenshot.png", "image", 400),
    file("photo.png", "image", 299),
    file("voice.m4a", "audio", 200),
    file("movie.mov", "video", 50),
  ];
  const all = mediaItems(downloads, "all", files);
  assert.deepEqual(all.map((i) => i.download.filename), ["screenshot.png", "photo.png", "voice.m4a", "talk.mp4", "movie.mov"]);
  assert.equal(all.find((i) => i.download.filename === "photo.png").id, "photo.png", "a file the browser downloaded stays its download");
  const screenshot = all[0];
  assert.equal(folderItemPath(screenshot.id), "/Users/me/Downloads/screenshot.png");
  assert.equal(folderItemPath("photo.png"), null);
  assert.equal(screenshot.media, "image");
  assert.equal(screenshot.download.state, "finished");
  assert.deepEqual(mediaItems(downloads, "audio", files).map((i) => i.download.filename), ["voice.m4a"]);
  assert.deepEqual(mediaItems(downloads, "video", files).map((i) => i.download.filename), ["talk.mp4", "movie.mov"]);
  assert.deepEqual(ids(searchItems(all, "screenshot")), [screenshot.id], "folder files are searchable by name");
});

test("Downloads lists every kind of file, including ones still running or failed", () => {
  const items = downloadItems(DOWNLOADS);
  const listed = new Set(ids(items));
  for (const id of ids(DOWNLOADS.filter((d) => d.state !== "cancelled"))) assert.ok(listed.has(id), id);
  assert.equal(items.find((i) => i.id === "half.png").download.state, "downloading");
});

const HISTORY = [
  visit("https://github.com/ardia/ardia", "Ardia Browser Repository", local(2026, 11, 15, 10)),
  visit("https://news.example.org/a", "Morning Headlines", local(2026, 11, 15, 9)),
  visit("https://cooking.example/pasta", "Fresh Pasta Recipes", local(2026, 11, 14, 20)),
];

test("search matches titles and hosts, ignoring case and extra spaces, and can come back empty", () => {
  const items = HISTORY;
  const urls = (query) => searchItems(items, query).map((i) => i.url);
  assert.deepEqual(urls("PASTA"), ["https://cooking.example/pasta"]);
  assert.deepEqual(urls("  fresh   recipes "), ["https://cooking.example/pasta"], "words match in any spacing");
  assert.deepEqual(urls("recipes fresh"), ["https://cooking.example/pasta"], "word order doesn't matter");
  assert.deepEqual(urls("github"), ["https://github.com/ardia/ardia"], "host");
  assert.deepEqual(urls("news.example"), ["https://news.example.org/a"]);
  assert.deepEqual(urls("pasta headlines"), [], "every word has to match");
  assert.deepEqual(urls("zzzz"), []);
  assert.deepEqual(urls(""), HISTORY.map((h) => h.url), "an empty query keeps everything");
  assert.deepEqual(urls("   "), HISTORY.map((h) => h.url), "a blank query keeps everything");
  assert.deepEqual(ids(searchItems(mediaItems(DOWNLOADS, "all"), "HOLIDAY")), ["holiday.JPG"], "media by file name");
  assert.deepEqual(ids(searchItems(downloadItems(DOWNLOADS), "report")), ["report.pdf"], "downloads by file name");
});

test("days split at local midnight, with Today and Yesterday named and older days dated", () => {
  const now = local(2026, 11, 15, 0, 5);
  const groups = dayGroups([
    visit("https://a/1", "", local(2026, 11, 15, 0, 1)),
    visit("https://a/2", "", local(2026, 11, 14, 23, 59)),
    visit("https://a/3", "", local(2026, 11, 14, 0, 0)),
    visit("https://a/4", "", local(2026, 11, 13, 23, 59)),
    visit("https://a/5", "", local(2026, 11, 2)),
  ], now);
  assert.deepEqual(urlsByGroup(groups), [["https://a/1"], ["https://a/2", "https://a/3"], ["https://a/4"], ["https://a/5"]]);
  assert.equal(groups[0].title, "Today");
  assert.equal(groups[1].title, "Yesterday");
  assert.match(groups[2].title, /13/);
  assert.match(groups[3].title, /\b2\b/);
  assert.equal(new Set(groups.map((g) => g.key)).size, groups.length, "every day has its own key");
  assert.equal(new Set(titles(groups)).size, groups.length);
  for (const t of titles(groups)) assert.doesNotMatch(t, /–|—/, "titles come from formatters, not joined sentences");
  assert.deepEqual(dayGroups([], now), []);
});

test("days and the items in each come newest first whatever order they arrive in", () => {
  const now = local(2026, 11, 15, 18);
  const shuffled = [
    visit("https://a/older", "", local(2026, 11, 12, 9)),
    visit("https://a/today-early", "", local(2026, 11, 15, 8)),
    visit("https://a/yesterday", "", local(2026, 11, 14, 12)),
    visit("https://a/today-late", "", local(2026, 11, 15, 17)),
    visit("https://a/older-late", "", local(2026, 11, 12, 21)),
  ];
  const groups = dayGroups(shuffled, now);
  assert.deepEqual(titles(groups).slice(0, 2), ["Today", "Yesterday"]);
  assert.deepEqual(urlsByGroup(groups), [["https://a/today-late", "https://a/today-early"], ["https://a/yesterday"], ["https://a/older-late", "https://a/older"]]);
});

test("a download with no path yet is listed, and a record repeated by id is listed once", () => {
  const held = download("held", { path: "", state: "downloading", dangerous: true });
  const items = downloadItems([held, download("a.zip"), download("a.zip")]);
  assert.deepEqual(ids(items), ["held", "a.zip"]);
});

test("Yesterday crosses month and year ends, and older years show the year", () => {
  const now = local(2027, 1, 1, 0, 5);
  const groups = dayGroups([
    visit("https://a/new-year", "", local(2027, 1, 1, 0, 0)),
    visit("https://a/eve", "", local(2026, 12, 31, 23, 59)),
    visit("https://a/before", "", local(2026, 12, 30, 12)),
    visit("https://a/leap", "", local(2024, 2, 29, 12)),
  ], now);
  assert.deepEqual(titles(groups).slice(0, 2), ["Today", "Yesterday"]);
  assert.match(groups[2].title, /30/);
  assert.match(groups[3].title, /29/);
  assert.match(groups[3].title, /2024/, "a day from another year says which year");
  const march = dayGroups([visit("https://a/feb", "", local(2026, 2, 28, 22))], local(2026, 3, 1, 1));
  assert.deepEqual(titles(march), ["Yesterday"], "the day before March 1 is February 28 in a common year");
});

test("days stay whole across daylight saving changes", () => {
  const fallBack = dayGroups([
    visit("https://a/late", "", local(2026, 11, 1, 23, 30)),
    visit("https://a/early", "", local(2026, 11, 1, 0, 30)),
    visit("https://a/eve", "", local(2026, 10, 31, 23, 30)),
  ], local(2026, 11, 1, 23, 45));
  assert.deepEqual(urlsByGroup(fallBack), [["https://a/late", "https://a/early"], ["https://a/eve"]], "the 25-hour day is one day");
  assert.deepEqual(titles(fallBack), ["Today", "Yesterday"]);

  const springForward = dayGroups([
    visit("https://a/sunday", "", local(2026, 3, 8, 0, 10)),
    visit("https://a/saturday", "", local(2026, 3, 7, 23, 50)),
  ], local(2026, 3, 9, 0, 30));
  assert.deepEqual(titles(springForward).slice(0, 1), ["Yesterday"], "after the 23-hour day, Sunday is still Yesterday");
  assert.notEqual(springForward[1].title, "Yesterday", "and Saturday is not");
  assert.equal(springForward.length, 2);
});

test("days follow the local time zone, including half-hour and 45-minute offsets", () => {
  const instant = Date.UTC(2026, 10, 14, 19, 0);
  const now = Date.UTC(2026, 10, 15, 10, 0);
  const groupsIn = (zone) => {
    process.env.TZ = zone;
    try {
      return titles(dayGroups([visit("https://a/x", "", instant)], now));
    } finally {
      process.env.TZ = "America/New_York";
    }
  };
  assert.deepEqual(groupsIn("Asia/Kolkata"), ["Today"], "00:30 on the 15th in India, now 15:30");
  assert.deepEqual(groupsIn("Pacific/Chatham"), ["Today"], "08:45 on the 15th on the Chatham Islands, now 23:45");
  assert.deepEqual(groupsIn("America/Los_Angeles"), ["Yesterday"], "11:00 on the 14th in California, now 02:00 on the 15th");
  assert.deepEqual(groupsIn("America/New_York"), ["Yesterday"], "14:00 on the 14th in New York, now 05:00 on the 15th");
});

test("100,000 history entries all land in a day, and a search finds every matching one and nothing else", () => {
  const now = local(2026, 11, 15, 18);
  const history = Array.from({ length: 100_000 }, (_, i) => visit(`https://site${i % 997}.example/page/${i}`, `Page ${i} about topic ${i % 53}`, now - i * 315_000));
  const groups = dayGroups(history, now);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 100_000, "every entry lands in a day");
  assert.ok(groups.length >= 364 && groups.length <= 366, `a year of days (${groups.length})`);
  const found = new Set(searchItems(history, "topic 52"));
  assert.ok(history.filter((v) => v.title.endsWith("topic 52")).every((v) => found.has(v)), "every entry about topic 52 is found");
  assert.ok([...found].every((v) => `${v.title} ${v.url}`.includes("52")), "and nothing without 52 in it");
  assert.ok(found.size < history.length);
});

test("a refined search narrows as you type and reuses each wider result on backspace", () => {
  const { refinedSearch } = items;
  const history = Array.from({ length: 2000 }, (_, i) => visit(`https://site${i % 37}.example/${i}`, `Page ${i} topic ${i % 11}`, 1_000_000 - i));
  const typed = [];
  let memo = refinedSearch(null, history, "");
  assert.equal(memo.result, history);
  for (const q of ["t", "to", "top", "topic", "topic 1", "topic 10"]) {
    memo = refinedSearch(memo, history, q);
    typed.push(memo);
    assert.deepEqual(memo.result, searchItems(history, q), q);
  }
  for (let i = typed.length - 2; i >= 0; i--) {
    memo = refinedSearch(memo, history, typed[i].query);
    assert.equal(memo, typed[i], `back to "${typed[i].query}" reuses its result`);
  }
  assert.equal(refinedSearch(memo, history, "").result, history);
  memo = refinedSearch(typed[5], history, "topic 2");
  assert.deepEqual(memo.result, searchItems(history, "topic 2"), "a sibling query narrows from the shared prefix");
  const changed = history.slice(1);
  assert.deepEqual(refinedSearch(memo, changed, "topic 2").result, searchItems(changed, "topic 2"), "new history searches afresh");
});

test("a folder file that a private window downloaded keeps its thumbnail off disk", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const path = "/Users/me/Downloads/private-photo.jpg";
  const file = (p) => ({ path: p, name: p.slice(p.lastIndexOf("/") + 1), kind: "image", added: 5, size: 1 });
  useBrowser.getState().upsertDownload({ id: "otr", url: "https://x.example/p.jpg", filename: "private-photo.jpg", path, state: "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "image/jpeg", offTheRecord: true, profile: "" });
  const [privateItem, plainItem] = items.mediaItems([], "all", [file(path), file("/Users/me/Downloads/plain.jpg")]);
  assert.equal(privateItem.download.offTheRecord, true);
  assert.equal(!!plainItem.download.offTheRecord, false);
});
