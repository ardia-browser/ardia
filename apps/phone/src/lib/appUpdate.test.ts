import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_VALUES } from "../../../../scripts/security/hostile-inputs.mjs";
import {
  apkDownloadUrl,
  compareReleaseVersions,
  dueForUpdateCheck,
  findUpdate,
  installedReleaseVersion,
  isPublishedTime,
  isReleaseDownloadUrl,
  MAX_GITHUB_BODY_CHARS,
  newerTaggedVersions,
  nextCheckAt,
  parseAndroidVersion,
  parseCheckAt,
  parseOfferedVersions,
  parseUnpublished,
  publishedRelease,
  readGitHubJson,
  releaseLookupUrl,
  releaseOfDownloadUrl,
  releaseTagsUrl,
  rememberUnpublished,
  retryAtFrom,
  UNPUBLISHED_REMEMBERED_MS,
  UPDATE_CHECK_EVERY_MS,
  UPDATE_CHECK_LONGEST_WAIT_MS,
  UPDATE_RETRY_FAILED_MS,
  UPDATE_RETRY_INCOMPLETE_MS,
  updateDownloadRequest,
  assetDigest,
  checksumVerdict,
  handOffResultOf,
  downloadProgressOf,
  installOutcomeOf,
  parseDownloadRecord,
  downloadRecordText,
  downloadOutlivedBy,
  verifyOutcomeOf,
  installStatusOf,
  installSessionOf,
  parseCommittedInstall,
  parseReleaseChecksum,
  progressDetail,
  updateDotShown,
  updateOfferWanted,
  updateRow,
  withOfferedVersion,
  type GitHubJsonAnswer,
  type ReleaseVersion,
} from "./appUpdate.ts";

const v = (text: string): ReleaseVersion => {
  const parsed = parseAndroidVersion(text);
  assert.ok(parsed, text);
  return parsed;
};

const tags = (...versions: string[]) => versions.map((version) => ({ ref: `refs/tags/android-v${version}`, object: { type: "commit" } }));

const apk = (version: string) => ({ name: `Ardia-${version}.apk`, state: "uploaded", browser_download_url: `https://github.com/ardia-browser/ardia/releases/download/android-v${version}/Ardia-${version}.apk` });

const release = (version: string, overrides: Record<string, unknown> = {}) => ({
  tag_name: `android-v${version}`,
  draft: false,
  prerelease: true,
  published_at: "2026-11-26T01:00:00Z",
  assets: [{ ...apk(version), name: `Ardia-${version}.apk.sha256`, browser_download_url: `${apk(version).browser_download_url}.sha256` }, apk(version)],
  ...overrides,
});

const NOW = 1_800_000_000_000;

const offerOf = (version: string) => ({ version, downloadUrl: apkDownloadUrl(v(version)), checksumUrl: `${apkDownloadUrl(v(version))}.sha256`, sha256: null });

test("versions sort nightlies below the stable of the same base and above the stable before it", () => {
  const ordered = ["1.0.2", "1.0.3-nightly.1", "1.0.3-nightly.2", "1.0.3-nightly.10", "1.0.3", "1.0.4-nightly.1", "1.0.4", "1.1.0", "2.0.0"];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      const sign = Math.sign(compareReleaseVersions(v(ordered[i]!), v(ordered[j]!)));
      assert.equal(sign, Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
});

test("only release-shaped versions parse", () => {
  for (const good of ["0.2.47", "1.0.3", "1.0.3-nightly.2", "20.99.999-nightly.998"]) assert.ok(parseAndroidVersion(good), good);
  for (const bad of ["", "1.0", "1.0.3.4", "v1.0.3", "1.0.3-beta.1", "1.0.3-nightly.0", "1.0.3-nightly.", "1.0.3-nightly.01", "1.0.1000", "1.0.4-nightly.1000", " 1.0.3", "1.0.3\n", "1.0.3-nightly.2-x", "1e3.0.0", "-1.0.0"]) assert.equal(parseAndroidVersion(bad), null, JSON.stringify(bad));
  for (const { id, value } of HOSTILE_VALUES) assert.equal(parseAndroidVersion(value), null, id);
});

test("only Android release builds check: never iPhone, never a Dev build, never a build without a release version", () => {
  assert.equal(installedReleaseVersion("android", "1.0.3", false)?.text, "1.0.3");
  assert.equal(installedReleaseVersion("android", "1.0.3-nightly.2", false)?.nightly, 2);
  assert.equal(installedReleaseVersion("ios", "1.0.3", false), null);
  assert.equal(installedReleaseVersion("android", "1.0.3", true), null);
  assert.equal(installedReleaseVersion("android", "", false), null);
  assert.equal(installedReleaseVersion("android", null, false), null);
  assert.equal(installedReleaseVersion("android", "dev", false), null);
});

test("a stable sees only newer stables; a nightly sees newer nightlies and stables", () => {
  const listed = tags("1.0.2", "1.0.3-nightly.1", "1.0.3-nightly.2", "1.0.3", "1.0.4-nightly.1", "0.2.47");
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.2")).map((x) => x.text), ["1.0.3"]);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.3")).map((x) => x.text), []);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.3-nightly.1")).map((x) => x.text), ["1.0.4-nightly.1", "1.0.3", "1.0.3-nightly.2"]);
  assert.deepEqual(newerTaggedVersions(listed, v("1.0.4-nightly.1")).map((x) => x.text), []);
});

test("tag listings that aren't a list of Android release tags offer nothing", () => {
  const installed = v("1.0.2");
  for (const body of [undefined, null, {}, "refs/tags/android-v9.9.9", 7, [null], [{ ref: 9 }], [{ ref: "refs/tags/v9.9.9" }], [{ ref: "refs/tags/android-v9.9.9-beta.1" }], [{ ref: "refs/heads/android-v9.9.9" }], [{ ref: "refs/tags/android-v9.9.9/../x" }], [{ ref: " refs/tags/android-v9.9.9" }]]) {
    assert.deepEqual(newerTaggedVersions(body, installed), [], JSON.stringify(body));
  }
  for (const { id, value } of HOSTILE_VALUES) {
    assert.deepEqual(newerTaggedVersions(value, installed), [], id);
    assert.deepEqual(newerTaggedVersions([{ ref: value }], installed), [], id);
    if (typeof value === "string" && value !== "") assert.deepEqual(newerTaggedVersions([{ ref: `refs/tags/android-v${value}` }], installed), [], id);
  }
  assert.deepEqual(newerTaggedVersions([{ ref: "refs/tags/android-v9.9.9" }], installed).map((x) => x.text), ["9.9.9"], "positive control");
});

test("a release is offered only when published, for its own tag, with its uploaded APK on this repo's release download", () => {
  const version = v("1.0.3");
  assert.deepEqual(publishedRelease(release("1.0.3"), version), { version: "1.0.3", downloadUrl: "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", checksumUrl: "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk.sha256", sha256: null });
  assert.equal(publishedRelease(release("1.0.3", { assets: [apk("1.0.3")] }), version), null, "a release without its checksum asset is never offered");
  assert.equal(publishedRelease(release("1.0.3", { assets: [apk("1.0.3"), { ...apk("1.0.3"), name: "Ardia-1.0.3.apk.sha256", browser_download_url: "https://example.com/Ardia-1.0.3.apk.sha256" }] }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: [apk("1.0.3"), { ...apk("1.0.3"), name: "Ardia-1.0.3.apk.sha256", state: "new", browser_download_url: `${apk("1.0.3").browser_download_url}.sha256` }] }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { draft: true }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { draft: undefined }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { published_at: null }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { tag_name: "android-v1.0.4" }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: [] }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: "Ardia-1.0.3.apk" }), version), null);
  assert.equal(publishedRelease(release("1.0.3", { assets: [{ ...apk("1.0.3"), state: "starter" }] }), version), null);
  for (const url of ["http://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://evil.example/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://github.com/someone/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk", "https://objects.githubusercontent.com/Ardia-1.0.3.apk"]) {
    assert.equal(publishedRelease(release("1.0.3", { assets: [{ ...apk("1.0.3"), browser_download_url: url }] }), version), null, url);
  }
  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(publishedRelease(value, version), null, id);
    for (const field of ["tag_name", "draft", "published_at", "assets"]) if (!(field === "draft" && value === false)) assert.equal(publishedRelease(release("1.0.3", { [field]: value }), version), null, `${field} ${id}`);
    for (const field of ["name", "state", "browser_download_url"]) assert.equal(publishedRelease(release("1.0.3", { assets: [{ ...apk("1.0.3"), [field]: value }] }), version), null, `asset ${field} ${id}`);
  }
});

test("P3: an asset without an uploaded state, or a publish time that isn't a real time, offers nothing", () => {
  const version = v("1.0.3");
  const { state: _state, ...stateless } = apk("1.0.3");
  assert.equal(publishedRelease(release("1.0.3", { assets: [stateless] }), version), null);
  for (const at of ["2026-99-99T99:99:99Z", "2026-02-30T00:00:00Z", "2026-11-26T24:00:00Z", "2026-11-26T01:00:00", "2026-11-26T01:00:00+01:00", "2026-11-26"]) {
    assert.equal(isPublishedTime(at), false, at);
    assert.equal(publishedRelease(release("1.0.3", { published_at: at }), version), null, at);
  }
  for (const at of ["2026-11-26T01:00:00Z", "2026-11-26T01:00:00.123Z", "2024-02-29T23:59:59Z"]) assert.equal(isPublishedTime(at), true, at);
});

test("only https downloads of an Android APK on github.com for this repo open", () => {
  assert.ok(isReleaseDownloadUrl("https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3-nightly.2/Ardia-1.0.3-nightly.2.apk"));
  assert.equal(releaseOfDownloadUrl("https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3-nightly.2/Ardia-1.0.3-nightly.2.apk")?.text, "1.0.3-nightly.2");
  for (const url of [
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.4.apk",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk?x=1",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk#x",
    "https://user@github.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com:444/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://GITHUB.com/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.3/../android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com.evil.example/ardia-browser/ardia/releases/download/android-v1.0.3/Ardia-1.0.3.apk",
    "https://github.com/ardia-browser/ardia/releases/download/android-v1.0.03/Ardia-1.0.03.apk",
    "https://github.com/ardia-browser/ardia/releases/download/v0.2.49/Ardia-0.2.49.dmg",
    "javascript:alert(1)",
  ]) {
    assert.equal(isReleaseDownloadUrl(url), false, url);
  }
  for (const { id, value } of HOSTILE_VALUES) assert.equal(isReleaseDownloadUrl(value), false, id);
});

test("GitHub bodies parse only as bounded JSON", () => {
  assert.deepEqual(readGitHubJson('[{"ref":"x"}]'), [{ ref: "x" }]);
  assert.equal(readGitHubJson(""), undefined);
  assert.equal(readGitHubJson("<html>rate limited</html>"), undefined);
  assert.equal(readGitHubJson('{"truncated":'), undefined);
  assert.equal(readGitHubJson(`"${"x".repeat(MAX_GITHUB_BODY_CHARS)}"`), undefined);
  assert.equal(readGitHubJson(null), undefined);
});

test("the automatic check waits 6 hours after an answer, 10 minutes after an unfinished walk, and again when the clock went backwards", () => {
  assert.equal(dueForUpdateCheck(NOW, null), true);
  assert.equal(dueForUpdateCheck(NOW, NOW + UPDATE_CHECK_EVERY_MS), false);
  assert.equal(dueForUpdateCheck(NOW, NOW), true);
  assert.equal(dueForUpdateCheck(NOW, NOW + UPDATE_CHECK_LONGEST_WAIT_MS + 1), true);
  assert.equal(nextCheckAt({ kind: "current", unpublished: [] }, NOW), NOW + UPDATE_CHECK_EVERY_MS);
  assert.equal(nextCheckAt({ kind: "available", offer: offerOf("1.0.4"), unpublished: [] }, NOW), NOW + UPDATE_CHECK_EVERY_MS);
  assert.equal(nextCheckAt({ kind: "incomplete", unpublished: [] }, NOW), NOW + UPDATE_RETRY_INCOMPLETE_MS);
  assert.equal(nextCheckAt({ kind: "failed", answered: false, retryAt: null, unpublished: [] }, NOW), null);
  assert.equal(nextCheckAt({ kind: "failed", answered: true, retryAt: null, unpublished: [] }, NOW), NOW + UPDATE_RETRY_FAILED_MS, "a 5xx or malformed answer without a retry time stays retryable within the half hour");
  assert.equal(parseCheckAt(String(NOW)), NOW);
  for (const text of [null, undefined, "", "-1", "0", "1e12", "12.5", "abc", " 1", "99999999999999999"]) assert.equal(parseCheckAt(text), null, String(text));
});

test("a rate limit waits for GitHub's own Retry-After or reset time, within a minute and a day", () => {
  const headers = (values: Record<string, string>) => (name: string) => values[name] ?? null;
  assert.equal(retryAtFrom(429, headers({ "retry-after": "120" }), NOW), NOW + 120_000);
  assert.equal(retryAtFrom(503, headers({ "retry-after": "Thu, 26 Nov 2026 03:00:00 GMT" }), NOW), Date.parse("2026-11-26T03:00:00Z"));
  assert.equal(retryAtFrom(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000900" }), NOW), 1_800_000_900_000);
  assert.equal(retryAtFrom(403, headers({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1800000900" }), NOW), null);
  assert.equal(retryAtFrom(500, headers({}), NOW), null);
  assert.equal(retryAtFrom(429, headers({ "retry-after": "soon" }), NOW), null);
  const limited = (retryAt: number) => nextCheckAt({ kind: "failed", answered: true, retryAt, unpublished: [] }, NOW);
  assert.equal(limited(NOW + 900_000), NOW + 900_000);
  assert.equal(limited(NOW - 5_000), NOW + 60_000);
  assert.equal(limited(NOW + 10 * UPDATE_CHECK_LONGEST_WAIT_MS), NOW + UPDATE_CHECK_LONGEST_WAIT_MS);
  for (const { id, value } of HOSTILE_VALUES) if (typeof value === "string") assert.equal(retryAtFrom(429, () => value, NOW) === null || Number.isFinite(retryAtFrom(429, () => value, NOW)), true, id);
});

test("P2: each version is offered once, a set of offered versions keeps 1.0.4 from showing twice when 1.0.3 came between", () => {
  const offer = offerOf;
  let offered: string[] = [];
  assert.equal(updateOfferWanted(offer("1.0.4"), offered), true);
  offered = withOfferedVersion(offered, "1.0.4");
  offered = withOfferedVersion(offered, "1.0.3");
  assert.equal(updateOfferWanted(offer("1.0.4"), offered), false);
  assert.equal(updateOfferWanted(offer("1.0.5"), offered), true);
  assert.equal(updateOfferWanted(null, offered), false);
  assert.deepEqual(parseOfferedVersions(JSON.stringify(offered)), ["1.0.4", "1.0.3"]);
  assert.deepEqual(parseOfferedVersions('["1.0.4", 7, "nope", "1.0.4", "__proto__"]'), ["1.0.4"]);
  for (const text of [null, "", "{}", "[", '"1.0.4"']) assert.deepEqual(parseOfferedVersions(text), [], String(text));
  for (const { id, value } of HOSTILE_VALUES) assert.deepEqual(parseOfferedVersions(JSON.stringify([value])), [], id);
  let many: string[] = [];
  for (let i = 0; i < 30; i += 1) many = withOfferedVersion(many, `1.0.${i}`);
  assert.equal(many.length, 20);
  assert.ok(many.includes("1.0.29") && !many.includes("1.0.0"));
});

const answering = (answers: Record<string, GitHubJsonAnswer>) => {
  const asked: string[] = [];
  return { asked, fetchJson: async (url: string): Promise<GitHubJsonAnswer> => (asked.push(url), answers[url] ?? { kind: "missing" }) };
};

test("the check skips tags whose release is missing and offers the newest published one", async () => {
  const { asked, fetchJson } = answering({
    [releaseTagsUrl()]: { kind: "json", body: tags("1.0.2", "1.0.3", "1.0.4", "1.0.5") },
    [releaseLookupUrl(v("1.0.4"))]: { kind: "json", body: release("1.0.4") },
    [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: release("1.0.3") },
  });
  assert.deepEqual(await findUpdate(v("1.0.2"), fetchJson), { kind: "available", offer: offerOf("1.0.4"), unpublished: ["1.0.5"] });
  assert.deepEqual(asked, [releaseTagsUrl(), releaseLookupUrl(v("1.0.5")), releaseLookupUrl(v("1.0.4"))]);
});

test("P2: three unpublished tags above a published one don't hide it: the first check is unfinished, the next walks past them", async () => {
  const answers = { [releaseTagsUrl()]: { kind: "json", body: tags("1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: release("1.0.3") } } as const;
  const first = answering(answers);
  const firstResult = await findUpdate(v("1.0.2"), first.fetchJson, {});
  assert.deepEqual(firstResult, { kind: "incomplete", unpublished: ["1.0.6", "1.0.5", "1.0.4"] });
  assert.equal(first.asked.length, 4);
  const known = rememberUnpublished({}, firstResult.unpublished, NOW);
  const second = answering(answers);
  assert.deepEqual(await findUpdate(v("1.0.2"), second.fetchJson, parseUnpublished(JSON.stringify(known), NOW + UPDATE_RETRY_INCOMPLETE_MS)), { kind: "available", offer: offerOf("1.0.3"), unpublished: [] });
  assert.deepEqual(second.asked, [releaseTagsUrl(), releaseLookupUrl(v("1.0.3"))]);
  assert.deepEqual(parseUnpublished(JSON.stringify(known), NOW + UNPUBLISHED_REMEMBERED_MS), {}, "a remembered draft is looked up again once its memory runs out, in case it was published");
});

test("the unpublished memory keeps only release versions with plausible times", () => {
  assert.deepEqual(parseUnpublished(JSON.stringify({ "1.0.4": NOW - 1000, "1.0.5": NOW + 10 * 60_000, nope: NOW, "1.0.6": "x", "1.0.7": NOW - UNPUBLISHED_REMEMBERED_MS }), NOW), { "1.0.4": NOW - 1000 });
  for (const text of [null, "", "[]", "[", '"x"']) assert.deepEqual(parseUnpublished(text, NOW), {}, String(text));
  for (const { id, value } of HOSTILE_VALUES) {
    if (typeof value === "string") assert.deepEqual(parseUnpublished(JSON.stringify({ [value]: NOW }), NOW), {}, id);
    assert.deepEqual(parseUnpublished(JSON.stringify({ "1.0.4": value }), NOW), {}, id);
  }
  assert.deepEqual(parseUnpublished('{"__proto__": 1800000000000, "1.0.4": 1800000000000}', NOW), { "1.0.4": NOW });
});

test("the check is up to date when nothing newer is published, and fails quietly offline, on a rate limit or on malformed answers", async () => {
  const current = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.2", "1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: release("1.0.3", { draft: true }) } });
  assert.deepEqual(await findUpdate(v("1.0.2"), current.fetchJson), { kind: "current", unpublished: ["1.0.3"] });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "unreachable" })), { kind: "failed", answered: false, retryAt: null, unpublished: [] });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "refused", retryAt: NOW + 5 })), { kind: "failed", answered: true, retryAt: NOW + 5, unpublished: [] });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "missing" })), { kind: "failed", answered: true, retryAt: null, unpublished: [] });
  assert.deepEqual(await findUpdate(v("1.0.2"), async () => ({ kind: "json", body: { message: "API rate limit exceeded" } })), { kind: "failed", answered: true, retryAt: null, unpublished: [] });
  const limited = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.4", "1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "refused", retryAt: null } });
  assert.deepEqual(await findUpdate(v("1.0.2"), limited.fetchJson), { kind: "failed", answered: true, retryAt: null, unpublished: ["1.0.4"] });
  const malformed = answering({ [releaseTagsUrl()]: { kind: "json", body: tags("1.0.3") }, [releaseLookupUrl(v("1.0.3"))]: { kind: "json", body: [release("1.0.3")] } });
  assert.deepEqual(await findUpdate(v("1.0.2"), malformed.fetchJson), { kind: "current", unpublished: ["1.0.3"] });
});

test("the About row is the one place the update shows: each state is one line with its one action", () => {
  const offer = offerOf("1.0.4");
  const row = (status: Parameters<typeof updateRow>[0], handoff: Parameters<typeof updateRow>[2], progress: number | null = null) => {
    const { title, actionLabel, action } = updateRow(status, status === "idle" || status === "checking" ? null : offer, handoff, progress);
    return [title, actionLabel, action];
  };
  assert.deepEqual(row("idle", null), ["Check for updates", undefined, "check"]);
  assert.deepEqual(row("checking", null), ["Checking for updates…", undefined, "none"]);
  assert.deepEqual(row("current", "ready"), ["Ardia is up to date", "Check", "check"]);
  assert.deepEqual(updateRow("failed", null, null).title, "Couldn’t check for updates");
  assert.deepEqual(updateRow("incomplete", null, null).action, "check");
  assert.deepEqual(row("available", null), ["Ardia 1.0.4 is available", "Download", "download"]);
  assert.deepEqual(row("failed", null), ["Ardia 1.0.4 is available", "Download", "download"], "a failed refresh keeps the download it already validated");
  assert.deepEqual(row("available", "downloading"), ["Downloading Ardia 1.0.4…", undefined, "none"]);
  assert.equal(updateRow("available", offer, "downloading", 0.426).detail, "42%");
  assert.deepEqual(row("available", "verifying"), ["Checking Ardia 1.0.4…", undefined, "none"]);
  assert.deepEqual(row("available", "ready"), ["Ardia 1.0.4 is ready to install", "Install", "install"]);
  assert.deepEqual(row("available", "installing"), ["Ardia 1.0.4 is ready to install", "Install", "install"]);
  assert.deepEqual(row("available", "needs_permission"), ["Allow Ardia to install apps", "Open settings", "permission"]);
  assert.deepEqual(row("available", "failed"), ["The download didn’t finish", "Try again", "download"]);
  assert.deepEqual(row("available", "refused"), ["The download didn’t match the release", "Try again", "download"]);
  assert.deepEqual(row("available", "unchecked"), ["Couldn’t check the download", "Try again", "install"]);
  assert.deepEqual(row("available", "unprepared"), ["Couldn’t prepare the update", "Try again", "install"]);
  assert.deepEqual(row("available", "install_failed"), ["Couldn’t install the update", "Try again", "install"]);
  assert.deepEqual(row("available", "unavailable"), ["Couldn’t start the download", "Copy link", "copy"]);
});

test("download progress reads only as a fraction from 0 to 1", () => {
  assert.equal(progressDetail(0), "0%");
  assert.equal(progressDetail(1), "100%");
  for (const value of [-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) assert.equal(progressDetail(value), undefined, String(value));
});

test("the dot shows for a found update until its About row is seen, and never once Ardia is current", () => {
  const offer = offerOf("1.0.4");
  assert.equal(updateDotShown("available", offer, null), true);
  assert.equal(updateDotShown("available", offer, "1.0.3"), true, "a newer version brings the dot back");
  assert.equal(updateDotShown("available", offer, "1.0.4"), false);
  assert.equal(updateDotShown("current", offer, null), false);
  assert.equal(updateDotShown("available", null, null), false);
  assert.equal(updateDotShown("idle", null, null), false);
});

test("the download action builds its request only from this repo's exact APK address and its own version: the shared hostile list never reaches the sink", () => {
  assert.deepEqual(updateDownloadRequest(offerOf("1.0.4"))?.url, apkDownloadUrl(v("1.0.4")), "positive control");
  assert.equal(updateDownloadRequest(offerOf("1.0.4"))?.title, "Ardia 1.0.4");
  for (const offer of [null, undefined, {}, { version: "1.0.5", downloadUrl: apkDownloadUrl(v("1.0.4")) }]) assert.equal(updateDownloadRequest(offer as never), null, JSON.stringify(offer));
  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(updateDownloadRequest({ version: "1.0.4", downloadUrl: value }), null, `url ${id}`);
    assert.equal(updateDownloadRequest({ version: value, downloadUrl: apkDownloadUrl(v("1.0.4")) }), null, `version ${id}`);
    assert.equal(updateDownloadRequest(value as never), null, `offer ${id}`);
    if (typeof value === "string" && value !== "") {
      assert.equal(updateDownloadRequest({ version: "1.0.4", downloadUrl: `${apkDownloadUrl(v("1.0.4"))}${value}` }), null, `suffix ${id}`);
      assert.equal(updateDownloadRequest({ version: "1.0.4", downloadUrl: `https://github.com/ardia-browser/ardia/releases/download/android-v1.0.4${value}/Ardia-1.0.4.apk` }), null, `path ${id}`);
    }
  }
});

const SHA = "9f1eca24627f7475f34591c3738ca6b6418f08dec4929774d72158e7dfc1a5ca";

test("the release checksum file is read only in sha256sum's own form, for this release's APK", () => {
  assert.equal(parseReleaseChecksum(`${SHA}  Ardia-1.0.4.apk\n`, v("1.0.4")), SHA);
  assert.equal(parseReleaseChecksum(`${SHA} *Ardia-1.0.4.apk`, v("1.0.4")), SHA);
  for (const text of [`${SHA}  Ardia-1.0.5.apk\n`, `${SHA.toUpperCase()}  Ardia-1.0.4.apk\n`, `${SHA.slice(1)}  Ardia-1.0.4.apk\n`, `${SHA}  Ardia-1.0.4.apk\n${SHA}  Ardia-1.0.4.apk\n`, `${SHA}Ardia-1.0.4.apk`, `${SHA}  ../Ardia-1.0.4.apk`, "", "<html>Not Found</html>", `${SHA}  Ardia-1.0.4.apk\n`.repeat(20)]) {
    assert.equal(parseReleaseChecksum(text, v("1.0.4")), null, JSON.stringify(text));
  }
  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(parseReleaseChecksum(value, v("1.0.4")), null, id);
    if (typeof value === "string") assert.equal(parseReleaseChecksum(`${SHA}  Ardia-1.0.4.apk${value}`, v("1.0.4")), value === "" || value === "\n" || value === "\r\n" ? SHA : null, id);
  }
});

test("the download request carries the release's own checksum address and file name, or nothing", () => {
  const request = updateDownloadRequest(offerOf("1.0.4"));
  assert.equal(request?.checksumUrl, `${apkDownloadUrl(v("1.0.4"))}.sha256`);
  assert.equal(request?.fileName, "Ardia-1.0.4.apk");
  assert.equal(updateDownloadRequest({ ...offerOf("1.0.4"), checksumUrl: "https://example.com/x.sha256" }), null);
  assert.equal(updateDownloadRequest({ ...offerOf("1.0.4"), checksumUrl: `${apkDownloadUrl(v("1.0.5"))}.sha256` }), null);
  for (const { id, value } of HOSTILE_VALUES) assert.equal(updateDownloadRequest({ ...offerOf("1.0.4"), checksumUrl: value }), null, id);
});

test("native answers about the download and the install map onto a few known states, anything else onto the safe one", () => {
  assert.deepEqual(handOffResultOf({ handoff: "notifications", id: "41" }), { handoff: "downloading", id: "41" });
  assert.deepEqual(handOffResultOf({ handoff: "browser" }), { handoff: "browser", id: null });
  for (const value of [{ handoff: "notifications" }, { handoff: "notifications", id: "0" }, { handoff: "notifications", id: "-4" }, { handoff: "notifications", id: 41 }, "notifications"]) assert.deepEqual(handOffResultOf(value), { handoff: "unavailable", id: null }, JSON.stringify(value));
  assert.equal(downloadProgressOf("running"), "downloading");
  assert.equal(downloadProgressOf("paused"), "downloading");
  assert.equal(downloadProgressOf("successful"), "ready");
  assert.equal(downloadProgressOf("failed"), "failed");
  assert.equal(installOutcomeOf("committed"), "installing");
  assert.equal(installOutcomeOf("launched"), "failed");
  assert.equal(installOutcomeOf("mismatch"), "refused");
  assert.deepEqual(installStatusOf({ kind: "update", status: "aborted", session: "7", download: "41" }), { kind: "update", status: "aborted", session: "7", download: "41" });
  assert.deepEqual(installStatusOf({ kind: "file", status: "failure", session: "8", download: "0" }), { kind: "file", status: "failure", session: "8", download: "0" });
  for (const value of [null, {}, { kind: "update", status: "aborted" }, { kind: "update", status: "aborted", session: "7" }, { kind: "update", status: "aborted", session: 7, download: "41" }, { kind: "other", status: "success", session: "7", download: "41" }, { kind: "update", status: "installed", session: "7", download: "41" }]) assert.equal(installStatusOf(value), null, JSON.stringify(value));
  assert.equal(installOutcomeOf({ result: "committed", session: "7" }), "installing");
  assert.equal(installSessionOf({ result: "committed", session: "7" }), "7");
  for (const value of [{ result: "committed" }, { result: "committed", session: 7 }, { result: "failed", session: "7" }, "committed"]) assert.equal(installSessionOf(value), null, JSON.stringify(value));
  assert.deepEqual(parseCommittedInstall('{"version":"1.0.4","session":"9"}'), { version: "1.0.4", session: "9" });
  for (const text of ["", "{}", '{"version":"1.0.04","session":"9"}', '{"version":"1.0.4","session":9}']) assert.equal(parseCommittedInstall(text), null, text);
  assert.equal(verifyOutcomeOf("verified"), "verified");
  assert.equal(verifyOutcomeOf("mismatch"), "refused");
  assert.equal(verifyOutcomeOf("copy_failed"), "copy_failed");
  assert.equal(verifyOutcomeOf("gone"), "gone");
  assert.equal(installOutcomeOf("needs_permission"), "needs_permission");
  for (const { id, value } of HOSTILE_VALUES) {
    assert.deepEqual(handOffResultOf(value), { handoff: "unavailable", id: null }, id);
    if (!(typeof value === "string" && /^[1-9]\d{0,18}$/.test(value))) assert.deepEqual(handOffResultOf({ handoff: "notifications", id: value }), { handoff: "unavailable", id: null }, id);
    assert.equal(downloadProgressOf(value), "gone", id);
    assert.equal(installOutcomeOf(value), "failed", id);
    assert.equal(verifyOutcomeOf(value), "failed", id);
    assert.equal(installStatusOf(value), null, id);
    assert.equal(installStatusOf({ kind: "update", status: value, session: "7", download: "41" }), null, id);
    const digits = typeof value === "string" && /^[0-9]{1,10}$/.test(value);
    if (!digits) assert.equal(installStatusOf({ kind: "update", status: "aborted", session: value, download: "41" }), null, id);
    if (!digits) assert.equal(installStatusOf({ kind: "update", status: "aborted", session: "7", download: value }), null, id);
    assert.equal(installSessionOf({ result: "committed", session: value }), typeof value === "string" && /^[0-9]{1,10}$/.test(value) ? value : null, id);
  }
  const kept = downloadRecordText({ ...offerOf("1.0.4"), sha256: SHA }, "41");
  assert.deepEqual(parseDownloadRecord(kept), { version: "1.0.4", id: "41", offer: { ...offerOf("1.0.4"), sha256: SHA } });
  for (const text of ["", "{}", '{"version":"1.0.4","id":"41"}', JSON.stringify({ id: 41, offer: offerOf("1.0.4") }), JSON.stringify({ id: "0", offer: offerOf("1.0.4") }), JSON.stringify({ id: "41", offer: { ...offerOf("1.0.4"), downloadUrl: "https://example.com/Ardia-1.0.4.apk" } }), JSON.stringify({ id: "41", offer: { ...offerOf("1.0.4"), checksumUrl: "https://example.com/x" } })]) {
    assert.equal(parseDownloadRecord(text), null, text);
  }
  for (const { id, value } of HOSTILE_VALUES) assert.equal(parseDownloadRecord(JSON.stringify({ id: "41", offer: { ...offerOf("1.0.4"), downloadUrl: value } })), null, id);
  assert.equal(parseDownloadRecord(JSON.stringify({ id: "41", offer: { ...offerOf("1.0.4"), sha256: "<script>" } }))?.offer.sha256, null);
  assert.equal(downloadOutlivedBy(parseDownloadRecord(kept)!, v("1.0.3")), false);
  assert.equal(downloadOutlivedBy(parseDownloadRecord(kept)!, v("1.0.4")), true);
  assert.equal(downloadOutlivedBy(parseDownloadRecord(kept)!, v("1.0.5-nightly.1")), true);
});

test("GitHub's own digest of the APK asset rides along with the offer, read only as sha256:<64 hex>", () => {
  const digest = `sha256:${SHA}`;
  const version = v("1.0.3");
  const withDigest = publishedRelease(release("1.0.3", { assets: [{ ...apk("1.0.3"), digest }, { ...apk("1.0.3"), name: "Ardia-1.0.3.apk.sha256", browser_download_url: `${apk("1.0.3").browser_download_url}.sha256`, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }] }), version);
  assert.equal(withDigest?.sha256, SHA);
  assert.equal(assetDigest(digest), SHA);
  for (const value of [SHA, `sha1:${SHA.slice(0, 40)}`, `sha256:${SHA.toUpperCase()}`, `sha256:${SHA}\n`, `SHA256:${SHA}`, `sha256:${SHA.slice(2)}`]) assert.equal(assetDigest(value), null, value);
  for (const { id, value } of HOSTILE_VALUES) assert.equal(assetDigest(value), null, id);
});

test("the checksum verdict: the release's .sha256 file decides, GitHub's digest must agree with it, and stands in only when the file can't be reached", () => {
  const version = v("1.0.4");
  const file = { kind: "text" as const, text: `${SHA}  Ardia-1.0.4.apk\n` };
  const other = "0".repeat(64);
  assert.deepEqual(checksumVerdict(file, version, null), { kind: "verified", sha256: SHA });
  assert.deepEqual(checksumVerdict(file, version, SHA), { kind: "verified", sha256: SHA });
  assert.deepEqual(checksumVerdict(file, version, other), { kind: "refused" }, "the file and GitHub's digest disagree");
  assert.deepEqual(checksumVerdict({ kind: "missing" }, version, SHA), { kind: "refused" }, "a release whose checksum file is gone is refused even with a digest");
  assert.deepEqual(checksumVerdict({ kind: "text", text: "<html>" }, version, SHA), { kind: "refused" });
  assert.deepEqual(checksumVerdict({ kind: "unreachable" }, version, SHA), { kind: "verified", sha256: SHA });
  assert.deepEqual(checksumVerdict({ kind: "unreachable" }, version, null), { kind: "unverified" });
  for (const { id, value } of HOSTILE_VALUES) assert.deepEqual(checksumVerdict({ kind: "unreachable" }, version, value as never), { kind: "unverified" }, id);
  assert.equal(updateDownloadRequest({ ...offerOf("1.0.4"), sha256: SHA })?.sha256, SHA);
  for (const { id, value } of HOSTILE_VALUES) assert.equal(updateDownloadRequest({ ...offerOf("1.0.4"), sha256: value })?.sha256, null, id);
});
