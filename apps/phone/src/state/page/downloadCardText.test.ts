import assert from "node:assert/strict";
import { test } from "node:test";
import { DOWNLOAD_FAILURE_WHY, downloadedDetail, downloadFailedToast, downloadFailureWhy, downloadHost, downloadingDetail, downloadRetries, downloadsCompleteDetail, downloadsCompleteTitle } from "./pagePrompts.ts";
import { clearChoice, clearedDetail } from "../settings/settingsRules.ts";
import { COULD_NOT_SEND_DETAIL, sentDetail } from "../sync/syncRules.ts";

test("a running download says how far it is, or that it is downloading when the size is unknown", () => {
  assert.equal(downloadingDetail(0.456), "Downloading · 45%");
  assert.equal(downloadingDetail(1.2), "Downloading · 100%");
  assert.equal(downloadingDetail(null), "Downloading…");
});

test("a finished download says its size and site, and leaves out what it doesn't know or must not show", () => {
  assert.equal(downloadedDetail(1_234_567, "127.0.0.1"), "Downloaded · 1.2 MB · 127.0.0.1");
  assert.equal(downloadedDetail(null, "files.example"), "Downloaded · files.example");
  assert.equal(downloadedDetail(0, null), "Downloaded");
  assert.equal(downloadHost("https://www.Files.example:8443/a/otter.pdf?x=1"), "files.example");
  assert.equal(downloadHost("http://user:pw@127.0.0.1/x"), "127.0.0.1");
  assert.equal(downloadHost("blob:https://files.example/7b0c"), null);
  assert.equal(downloadHost("data:application/pdf;base64,AAA"), null);
});

test("a failed download leads with the headline in sentence case and gives the engine's reason on its own line, worded as #4536 words it", () => {
  assert.equal(downloadFailedToast("quarterly-report.pdf"), "Couldn’t download quarterly-report.pdf");
  assert.equal(downloadFailedToast(""), "Couldn’t download the file");
  assert.equal(downloadFailureWhy("server"), "The site didn’t send the file.");
  assert.equal(downloadFailureWhy("privateSessionEnded"), null);
  assert.equal(downloadFailureWhy(null), null);
  assert.deepEqual(Object.keys(DOWNLOAD_FAILURE_WHY).sort(), ["insecureRedirect", "network", "noSpace", "server", "storage", "tooManyRedirects", "unsupported"]);
});

test("Retry is offered only where trying again can help, on a web link, and never for a private page", () => {
  assert.equal(downloadRetries("network", "https://files.example/a.pdf", false), true);
  assert.equal(downloadRetries("server", "http://files.example/a.pdf", false), true);
  assert.equal(downloadRetries("network", "https://files.example/a.pdf", true), false);
  assert.equal(downloadRetries("noSpace", "https://files.example/a.pdf", false), false);
  assert.equal(downloadRetries("unsupported", "https://files.example/a.pdf", false), false);
  assert.equal(downloadRetries("network", "blob:https://files.example/1", false), false);
  assert.equal(downloadRetries(null, "https://files.example/a.pdf", false), false);
});

test("finished downloads that land together are one card that counts them and names each file", () => {
  assert.equal(downloadsCompleteTitle(2), "2 downloads complete");
  assert.equal(downloadsCompleteDetail(["ok-report.pdf", "b.zip"]), "ok-report.pdf, b.zip");
});

test("Clear Browsing Data says what it cleared and from when, and which kinds a phone can only clear entirely", () => {
  assert.equal(clearedDetail(clearChoice(true, true, true, false, "lastHour"), "lastHour"), "History, Cache, and Cookies · Last Hour");
  assert.equal(clearedDetail(clearChoice(true, false, false, true, "allTime"), "allTime"), "History and Archived Tabs · All Time");
  assert.equal(clearedDetail(clearChoice(true, true, false, false, "today"), "today", false), "History · Today, Cache · All Time");
  assert.equal(clearedDetail(clearChoice(false, false, true, false, "today"), "today", false), "Cookies · All Time");
});

test("a sent tab names its site unless it came from a private tab, and a failed send says what to check", () => {
  assert.equal(sentDetail("example.com", false), "example.com");
  assert.equal(sentDetail("example.com", true), null);
  assert.equal(sentDetail(null, false), null);
  assert.equal(COULD_NOT_SEND_DETAIL, "Check your connection and try again.");
});
