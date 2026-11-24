import assert from "node:assert/strict";
import test from "node:test";
import { bookmarkMatches, bookmarkSections, type BookmarkLike } from "./bookmarkSearch.ts";
import { filterHistory, forgettingHidden, hidingEntry, historyDays, historyDayTitle, historyEntries, historyHost, keepingHidden } from "./historyTimeline.ts";
import { fileSizeText } from "./libraryText.ts";

const now = new Date(2026, 10, 16, 15, 0).getTime();
const at = (daysAgo: number, hour = 10) => new Date(2026, 10, 16 - daysAgo, hour, 0).getTime();

test("history merges this phone's and the Mac's visits by address, the newest wins, and the same visit within 2 s stays this phone's", () => {
  const entries = historyEntries(
    [
      { url: "https://a.example/", title: "", visitedAt: at(0, 9) },
      { url: "https://a.example/", title: "A", visitedAt: at(0, 8) },
      { url: "https://b.example/", title: "B", visitedAt: at(0, 11) },
    ],
    [
      { url: "https://b.example/", title: "B Mac", visitedAt: at(0, 11) + 1500 },
      { url: "https://c.example/", title: "C", visitedAt: at(1) },
      { url: "https://a.example/", title: "A Mac", visitedAt: at(0, 12) },
    ],
    {},
  );
  assert.deepEqual(
    entries.map((entry) => [entry.url, entry.title, entry.source]),
    [
      ["https://a.example/", "A Mac", "otherDevice"],
      ["https://b.example/", "B", "thisDevice"],
      ["https://c.example/", "C", "otherDevice"],
    ],
  );
});

test("a hidden address stays hidden until a newer visit, and the hidden list forgets what left the Mac's history or was cleared", () => {
  const visit = { url: "https://a.example/", title: "A", visitedAt: at(0, 9) };
  const hidden = hidingEntry({ ...visit, source: "otherDevice" }, {});
  assert.deepEqual(historyEntries([], [visit], hidden), []);
  assert.equal(historyEntries([], [{ ...visit, visitedAt: at(0, 10) }], hidden).length, 1);
  assert.deepEqual(keepingHidden(hidden, []), {});
  assert.deepEqual(forgettingHidden(hidden, at(0, 8)), {});
  assert.deepEqual(forgettingHidden(hidden, at(0, 10)), hidden);
  assert.deepEqual(forgettingHidden(hidden, null), {});
});

test("history filters on every word in title or address, groups by day, and titles days as main does", () => {
  const entries = historyEntries([{ url: "https://news.example/today", title: "Morning News", visitedAt: at(0) }, { url: "https://docs.example/", title: "Docs", visitedAt: at(3) }, { url: "https://old.example/", title: "Old", visitedAt: at(9) }], [], {});
  assert.deepEqual(filterHistory(entries, "news morning").map((entry) => entry.title), ["Morning News"]);
  const days = historyDays(entries);
  assert.equal(days.length, 3);
  assert.deepEqual(days.map((day) => historyDayTitle(day.day, now, "en-US")), ["Today", "Friday", "Saturday, November 7"]);
  assert.equal(historyDayTitle(at(1), now, "en-US"), "Yesterday");
  assert.equal(historyHost("https://www.Example.com/path"), "example.com");
});

test("bookmarks split into the bar and the rest, and search finds links at any depth", () => {
  const item = (key: string, title: string, url: string | null, root: string | null, children: BookmarkLike[] | null = null): BookmarkLike => ({ key, title, url, root, children });
  const tree = [item("1", "News", "https://news.example/", "bar"), item("2", "Folder", null, "other", [item("3", "Deep Docs", "https://docs.example/", null)])];
  assert.deepEqual(bookmarkSections(tree).map((section) => [section.title, section.items.length]), [["Bookmarks Bar", 1], ["Other Bookmarks", 1]]);
  assert.deepEqual(bookmarkMatches(tree, "deep docs").map((found) => found.key), ["3"]);
});

test("file sizes read as Apple's file byte counts", () => {
  assert.equal(fileSizeText(0), "Zero KB");
  assert.equal(fileSizeText(512), "512 bytes");
  assert.equal(fileSizeText(12_400), "12 KB");
  assert.equal(fileSizeText(1_234_567), "1.2 MB");
  assert.equal(fileSizeText(3_456_000_000), "3.46 GB");
});
