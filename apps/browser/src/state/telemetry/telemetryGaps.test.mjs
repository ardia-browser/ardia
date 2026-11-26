import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const downloads = await import("./downloadWork.ts");
const keyring = await import("./keyringCounts.ts");
const updates = await import("./updateCounts.ts");
const share = { ...(await import("./sharePreviewCounts.ts")), ...(await import("../media/sharePreviewFlatness.ts")) };
const misses = await import("./autoPipMisses.ts");
const { processCpuFields } = await import("./processCpu.ts");
const { pageMetricsFields } = await import("./diagnostics.ts");
const { nativeMessagingProperties } = await import("./launchEvents.ts");
const { inlineChance } = await import("../omnibox/inlineMiss.ts");

before(() => client.setSharing(true, "settings"));
after(() => client.setSharing(false, "settings"));

const MB = 1_048_576;

test("a download is counted once when it starts and once when it ends, and a finished one lands in its speed bucket", () => {
  downloads.takeDownloadWork(0);
  downloads.noteDownloadSeen({ id: "a", state: "downloading", received: 0, startTime: 1_000 }, 1_000);
  downloads.noteDownloadSeen({ id: "a", state: "downloading", received: MB, startTime: 1_000 }, 2_000);
  downloads.noteDownloadSeen({ id: "a", state: "finished", received: 4 * MB, startTime: 1_000 }, 3_000);
  downloads.noteDownloadSeen({ id: "a", state: "finished", received: 4 * MB, startTime: 1_000 }, 3_500);
  downloads.noteDownloadSeen({ id: "b", state: "downloading", received: 0 }, 4_000);
  downloads.noteDownloadSeen({ id: "b", state: "failed", received: 10 }, 5_000);
  const taken = downloads.takeDownloadWork(6_000);
  assert.equal(taken.downloads_started, 2);
  assert.equal(taken.downloads_finished, 1);
  assert.equal(taken.downloads_failed, 1);
  assert.equal(taken.downloads_timed, 1);
  assert.equal(taken.download_speeds_under_10mbs, 1);
  assert.equal(downloads.takeDownloadWork(7_000).downloads_started, 0);
});

test("download speed buckets leave out downloads too small or too quick to time", () => {
  assert.equal(downloads.downloadSpeedBucket(MB / 2, 10_000), null);
  assert.equal(downloads.downloadSpeedBucket(10 * MB, 500), null);
  assert.equal(downloads.downloadSpeedBucket(MB, 20_000), "download_speeds_under_100kbs");
  assert.equal(downloads.downloadSpeedBucket(MB, 2_000), "download_speeds_under_1mbs");
  assert.equal(downloads.downloadSpeedBucket(100 * MB, 2_000), "download_speeds_10mbs_up");
});

test("an allowed request for several downloads counts whether any and how many downloads followed within 15 seconds", () => {
  downloads.takeDownloadWork(0);
  const consent = client.consentNow();
  downloads.noteMultipleDownloadsAnswered("accept", consent, 10_000);
  downloads.noteDownloadSeen({ id: "c", state: "downloading", received: 0 }, 11_000);
  const first = downloads.takeDownloadWork(30_000);
  assert.deepEqual([first.multiple_download_asks, first.multiple_download_allows, first.multiple_download_follow_ups, first.multiple_download_single_follow_ups], [1, 1, 1, 1]);
  downloads.noteMultipleDownloadsAnswered("deny", client.consentNow(), 40_000);
  const second = downloads.takeDownloadWork(60_000);
  assert.deepEqual([second.multiple_download_blocks, second.multiple_download_follow_ups], [1, 0]);
});

test("keyring checks count the protection and failures, never which profile, and reset once taken", () => {
  keyring.takeKeyringCounts();
  keyring.noteKeyringCheck({ protection: "keyring", protectionFallback: false, passwords: { reason: "keyringLocked" } });
  keyring.noteKeyringCheck({ protection: "https://example.com", protectionFallback: true });
  keyring.noteKeyringFailure("sync", "unavailable");
  const taken = keyring.takeKeyringCounts();
  assert.equal(taken.keyring_checks, 2);
  assert.equal(taken.keyring_protection_keyring, 1);
  assert.equal(taken.keyring_protection_unknown, 1);
  assert.equal(taken.keyring_fallbacks, 1);
  assert.equal(taken.keyring_passwords_locked, 1);
  assert.equal(taken.keyring_sync_unavailable, 1);
  assert.ok(Object.values(taken).every((value) => typeof value === "number"));
  assert.equal(keyring.takeKeyringCounts().keyring_checks, 0);
});

test("Sparkle's update steps and failures land in the same counters as Linux's self-updates", () => {
  updates.takeUpdateCounts();
  const epoch = client.consentNow();
  updates.noteSparkleUpdate({ type: "updateStep", step: "downloadStarted", epoch });
  updates.noteSparkleUpdate({ type: "updateStep", step: "downloadFinished", epoch });
  updates.noteSparkleUpdate({ type: "updateStep", step: "installing", epoch });
  updates.noteSparkleUpdate({ type: "updateFailed", stage: "install", reason: "signature", epoch });
  updates.noteSparkleUpdate({ type: "updateFailed", stage: "install", reason: "extract", epoch });
  updates.noteSparkleUpdate({ type: "updateFailed", stage: "download", reason: "a path /Users/someone", epoch });
  updates.noteSparkleUpdate({ type: "updateFailed", stage: "download", reason: "network", epoch: "an-earlier-period" });
  updates.noteSparkleUpdate({ type: "updateFailed", stage: "download", reason: "network" });
  const taken = updates.takeUpdateCounts();
  assert.equal(taken.update_downloads_started, 1);
  assert.equal(taken.update_downloads_finished, 1);
  assert.equal(taken.update_install_starts, 1);
  assert.equal(taken.update_download_failures_network, 0);
  assert.equal(taken.update_install_failures_signature, 1);
  assert.equal(taken.update_install_failures_extract, 1);
  assert.equal(taken.update_download_failures_other, 1);
});

test("the share picker's flat and black previews are told apart from the thumbnails themselves", () => {
  const split = share.splitSharePreviews({ "window:1:0": "jpeg", "@blank": "2", "@black": "5" });
  assert.deepEqual(split, { thumbs: { "window:1:0": "jpeg" }, blank: 2, black: 2 });
  assert.deepEqual(share.splitSharePreviews({ "@blank": "nope" }), { thumbs: {}, blank: 0, black: 0 });
  share.takeSharePreviewCounts();
  share.startSharePreviews(3).found(0, split.blank, split.black);
  const taken = share.takeSharePreviewCounts();
  assert.deepEqual([taken.share_previews_asked, taken.share_previews_blank, taken.share_previews_black], [3, 2, 2]);
});

test("automatic Picture in Picture misses count by what hid the tab", () => {
  misses.takeAutoPipMisses();
  assert.equal(misses.isAutoPipMiss("missedAppSwitch"), true);
  assert.equal(misses.isAutoPipMiss("onScreen"), false);
  misses.noteAutoPipMiss("missedAppSwitch", client.consentNow());
  misses.noteAutoPipMiss("leftOnSpaceSwitchJoining", client.consentNow());
  misses.noteAutoPipMiss("missedTabSwitch", "");
  const taken = misses.takeAutoPipMisses();
  assert.equal(Object.values(taken).length, 7);
  assert.equal(taken.auto_pip_not_shown_app_switch, 1);
  assert.equal(taken.pip_left_on_space_switch_joining, 1);
  assert.equal(taken.auto_pip_not_shown_tab_switch, 0);
});

test("process CPU sums each kind of process once per process and keeps the busiest page process", () => {
  const fields = processCpuFields([
    { id: 1, pid: 10, type: "browser", cpu: 12.34 },
    { id: 2, pid: 11, type: "gpu", cpu: 30 },
    { id: 3, pid: 12, type: "renderer", cpu: 50 },
    { id: 4, pid: 12, type: "renderer", cpu: 50 },
    { id: 5, pid: 13, type: "renderer", cpu: 7.5 },
    { id: 6, pid: 14, type: "utility", cpu: 1 },
    { id: 7, type: "renderer", cpu: Number.NaN },
  ]);
  assert.deepEqual(fields, { browser_cpu_now_pct: 12.3, gpu_cpu_now_pct: 30, renderer_cpu_now_pct: 57.5, renderer_cpu_now_max_pct: 50, helper_cpu_now_pct: 1 });
  assert.deepEqual(processCpuFields([{ id: 1, pid: 10, type: "browser", cpu: 0 }, { id: 2, pid: 11, type: "renderer", cpu: 0 }]), {}, "a sample with every process at zero is one the task manager hadn't taken yet");
});

test("page metrics from native keep only the known counters, rounded, including every key Mac native emits", () => {
  assert.deepEqual(
    pageMetricsFields({
      media_errors_decode: 2,
      video_frames_60hz: 600.4,
      video_frames_dropped_120hz_low_power: 3,
      scroll_bursts: 1,
      scroll_frames_60hz: 58.6,
      scroll_ms_60hz: 1000.2,
      scroll_frames_120hz: 118,
      scroll_ms_120hz: 990,
      scroll_frames_60hz_low_power: 30,
      scroll_ms_60hz_low_power: 500,
      scroll_frames_120hz_low_power: 60,
      scroll_ms_120hz_low_power: 1000,
      "https://example.com": 4,
      scroll_ms_90hz: 1,
      media_errors_network: -1,
    }),
    {
      media_errors_decode: 2,
      video_frames_60hz: 600,
      video_frames_dropped_120hz_low_power: 3,
      scroll_bursts: 1,
      scroll_frames_60hz: 59,
      scroll_ms_60hz: 1000,
      scroll_frames_120hz: 118,
      scroll_ms_120hz: 990,
      scroll_frames_60hz_low_power: 30,
      scroll_ms_60hz_low_power: 500,
      scroll_frames_120hz_low_power: 60,
      scroll_ms_120hz_low_power: 1000,
    },
  );
  const mm = readFileSync(new URL("../../../../../packages/ardiacore/ios/ArdiaWebView+PageMetrics.mm", import.meta.url), "utf8");
  const buckets = ["_60hz", "_120hz", "_60hz_low_power", "_120hz_low_power"];
  const direct = [...mm.matchAll(/Add\(@"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const media = [...mm.matchAll(/@"(media_errors_[a-z]+)"/g)].map((m) => m[1]);
  const bucketed = [...mm.matchAll(/Add\(\[@"([a-z0-9_]+)" stringByAppendingString:bucket\]/g)].flatMap((m) => buckets.map((b) => `${m[1]}${b}`));
  const allNative = [...new Set([...direct, ...media, ...bucketed])];
  assert.ok(allNative.includes("scroll_frames_120hz") && allNative.includes("scroll_ms_120hz"));
  const payload = Object.fromEntries(allNative.map((k, i) => [k, i + 1]));
  assert.deepEqual(pageMetricsFields(payload), payload);
  assert.deepEqual(pageMetricsFields(null), {});
});

test("native messaging host health is sent as small counts only", () => {
  assert.deepEqual(nativeMessagingProperties({ found: 2, registered: 1, keptTheirs: 1, missing: 0, unusable: 99 }), {
    native_messaging_hosts: 2,
    native_messaging_registered: 1,
    native_messaging_kept_theirs: 1,
    native_messaging_missing: 0,
    native_messaging_unusable: 16,
  });
  assert.deepEqual(nativeMessagingProperties(undefined), {});
});

test("an inline completion counts as missed only when the typing began a top site and nothing was completed", () => {
  const history = [
    { url: "https://www.github.com/a", visits: 40 },
    { url: "https://github.com/b", visits: 5 },
    { url: "https://news.ycombinator.com/", visits: 10 },
  ];
  assert.equal(inlineChance("git", "", history, false), "missed");
  assert.equal(inlineChance("git", "hub.com", history, false), "offered");
  assert.equal(inlineChance("g", "", history, false), "none");
  assert.equal(inlineChance("git", "", history, true), "none");
  assert.equal(inlineChance("github.com", "", history, false), "none");
  assert.equal(inlineChance("git hub", "", history, false), "none");
  assert.equal(inlineChance("zzz", "", history, false), "none");
});

test("a download that was interrupted and resumed keeps its first token and isn't timed", () => {
  downloads.takeDownloadWork(0);
  downloads.noteDownloadSeen({ id: "r", state: "downloading", received: 0, startTime: 1_000 }, 1_000);
  downloads.noteDownloadSeen({ id: "r", state: "failed", received: MB }, 2_000);
  downloads.noteDownloadSeen({ id: "r", state: "downloading", received: MB, startTime: 1_000 }, 60_000);
  downloads.noteDownloadSeen({ id: "r", state: "finished", received: 8 * MB, startTime: 1_000 }, 61_000);
  const taken = downloads.takeDownloadWork(62_000);
  assert.deepEqual([taken.downloads_started, taken.downloads_failed, taken.downloads_finished, taken.downloads_timed], [1, 1, 1, 0]);
});

test("a download paused while downloading finishes without distorting speed buckets", () => {
  downloads.takeDownloadWork(0);
  downloads.noteDownloadSeen({ id: "p", state: "downloading", received: 0, startTime: 1_000, paused: false }, 1_000);
  downloads.noteDownloadSeen({ id: "p", state: "downloading", received: MB, startTime: 1_000, paused: true }, 2_000);
  downloads.noteDownloadSeen({ id: "p", state: "downloading", received: 2 * MB, startTime: 1_000, paused: false }, 3_602_000);
  downloads.noteDownloadSeen({ id: "p", state: "finished", received: 10 * MB, startTime: 1_000, paused: false }, 3_605_000);
  const taken = downloads.takeDownloadWork(3_606_000);
  assert.deepEqual([taken.downloads_started, taken.downloads_finished, taken.downloads_timed, taken.download_speeds_under_100kbs], [1, 1, 0, 0]);
});

test("a download is credited once, to the newest open approval, never to every approval at once", () => {
  downloads.takeDownloadWork(0);
  downloads.noteMultipleDownloadsAnswered("accept", client.consentNow(), 1_000);
  downloads.noteMultipleDownloadsAnswered("accept", client.consentNow(), 2_000);
  downloads.noteDownloadSeen({ id: "n1", state: "downloading", received: 0 }, 3_000);
  downloads.noteDownloadSeen({ id: "n2", state: "downloading", received: 0 }, 4_000);
  const taken = downloads.takeDownloadWork(30_000);
  assert.deepEqual([taken.multiple_download_allows, taken.multiple_download_follow_ups, taken.multiple_download_single_follow_ups], [2, 1, 0]);
});

test("each approval to download several files keeps its own follow-up", () => {
  downloads.takeDownloadWork(0);
  downloads.noteMultipleDownloadsAnswered("accept", client.consentNow(), 1_000);
  downloads.noteDownloadSeen({ id: "f1", state: "downloading", received: 0 }, 2_000);
  downloads.noteMultipleDownloadsAnswered("accept", client.consentNow(), 3_000);
  const taken = downloads.takeDownloadWork(30_000);
  assert.deepEqual([taken.multiple_download_allows, taken.multiple_download_follow_ups, taken.multiple_download_single_follow_ups], [2, 1, 1]);
});

test("on Linux one download seen by a leader and a follower window counts once", async () => {
  const leader = await import("./downloadWork.ts?window=leader");
  const follower = await import("./downloadWork.ts?window=follower");
  leader.setDownloadFlowOwner(() => true);
  follower.setDownloadFlowOwner(() => false);
  const events = [
    [{ id: "shared", state: "downloading", received: 0, startTime: 1_000 }, 1_000],
    [{ id: "shared", state: "downloading", received: 4 * MB, startTime: 1_000 }, 2_000],
    [{ id: "shared", state: "finished", received: 8 * MB, startTime: 1_000 }, 3_000],
  ];
  for (const [d, at] of events) {
    leader.noteDownloadSeen(d, at);
    follower.noteDownloadSeen(d, at);
  }
  const a = leader.takeDownloadWork(4_000);
  const b = follower.takeDownloadWork(4_000);
  const sum = (field) => a[field] + b[field];
  assert.deepEqual([sum("downloads_started"), sum("downloads_finished"), sum("downloads_timed")], [1, 1, 1]);
});

test("a window that becomes the leader mid-download keeps the download's identity and never counts its start again, even on a zero-byte update", async () => {
  const work = await import("./downloadWork.ts?window=handoff");
  let leading = false;
  work.setDownloadFlowOwner(() => leading);
  work.noteDownloadSeen({ id: "h", state: "downloading", received: 0 }, 1_000);
  leading = true;
  work.noteDownloadSeen({ id: "h", state: "downloading", received: 0 }, 1_500);
  work.noteDownloadSeen({ id: "h", state: "downloading", received: 2 * MB }, 2_000);
  work.noteDownloadSeen({ id: "h", state: "finished", received: 4 * MB }, 3_000);
  const taken = work.takeDownloadWork(4_000);
  assert.deepEqual([taken.downloads_started, taken.downloads_finished, taken.downloads_timed], [0, 1, 1]);
});

test("a download started while sharing was off is never counted as finished after opt-in and leadership handoff", async () => {
  const work = await import("./downloadWork.ts?window=handoff-consent");
  let leading = false;
  work.setDownloadFlowOwner(() => leading);
  client.setSharing(false, "settings");
  work.noteDownloadSeen({ id: "pre", state: "downloading", received: 0 }, 1_000);
  client.setSharing(true, "settings");
  leading = true;
  work.noteDownloadSeen({ id: "pre", state: "downloading", received: 0 }, 1_500);
  work.noteDownloadSeen({ id: "pre", state: "downloading", received: 2 * MB }, 2_000);
  work.noteDownloadSeen({ id: "pre", state: "finished", received: 4 * MB }, 3_000);
  const taken = work.takeDownloadWork(4_000);
  assert.deepEqual([taken.downloads_started, taken.downloads_finished, taken.downloads_timed], [0, 0, 0]);
});

test("a download started in an earlier consent period or already running before the window opened isn't counted after handoff", async () => {
  const work = await import("./downloadWork.ts?window=handoff-prior");
  let leading = false;
  work.setDownloadFlowOwner(() => leading);
  work.noteDownloadSeen({ id: "old-period", state: "downloading", received: 0 }, 1_000);
  work.seedRunningDownloads([{ id: "seeded", state: "downloading", received: 0 }], 1_000);
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  leading = true;
  work.noteDownloadSeen({ id: "old-period", state: "finished", received: 4 * MB }, 3_000);
  work.noteDownloadSeen({ id: "seeded", state: "downloading", received: 0 }, 3_100);
  work.noteDownloadSeen({ id: "seeded", state: "finished", received: 4 * MB }, 4_000);
  const taken = work.takeDownloadWork(5_000);
  assert.deepEqual([taken.downloads_started, taken.downloads_finished, taken.downloads_timed], [0, 0, 0]);
});

test("a multiple-downloads approval in a follower window relays its follow-up window to the leader", async () => {
  const { setTelemetryRelay } = await import("./relay.ts");
  const leader = await import("./downloadWork.ts?window=fu-leader");
  const follower = await import("./downloadWork.ts?window=fu-follower");
  leader.setDownloadFlowOwner(() => true);
  follower.setDownloadFlowOwner(() => false);
  const relayed = [];
  setTelemetryRelay({
    capture: () => true,
    log: () => {},
    resetId: async () => "",
    change: async () => true,
    installId: () => "",
    downloadFollowUp: (until, consent) => {
      relayed.push([until, consent]);
      leader.noteMultipleDownloadFollowUp(until, consent, 10_000);
    },
  });
  try {
    const consent = client.consentNow();
    follower.noteMultipleDownloadsAnswered("accept", consent, 10_000);
    assert.equal(relayed.length, 1);
    leader.noteDownloadSeen({ id: "relayed-1", state: "downloading", received: 0 }, 11_000);
    follower.noteDownloadSeen({ id: "relayed-1", state: "downloading", received: 0 }, 11_000);
    const l = leader.takeDownloadWork(30_000);
    const f = follower.takeDownloadWork(30_000);
    assert.deepEqual([f.multiple_download_asks, f.multiple_download_allows, f.multiple_download_follow_ups], [1, 1, 0]);
    assert.deepEqual([l.downloads_started, l.multiple_download_follow_ups, l.multiple_download_single_follow_ups], [1, 1, 1]);
  } finally {
    setTelemetryRelay(null);
  }
});
