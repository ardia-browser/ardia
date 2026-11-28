#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";

const HELP = `App Store Connect, for the iPhone app's TestFlight and App Store builds.

  node apps/phone/scripts/asc.mjs status
  node apps/phone/scripts/asc.mjs builds [--build <number>]
  node apps/phone/scripts/asc.mjs next-build
  node apps/phone/scripts/asc.mjs wait --build <number> [--timeout <seconds>]
  node apps/phone/scripts/asc.mjs certificates --save <file>
  node apps/phone/scripts/asc.mjs certificates --new-since <file>
  node apps/phone/scripts/asc.mjs certificates --create <request.csr> --out <file.cer>
  node apps/phone/scripts/asc.mjs register-device --udid <udid> [--name <name>]
  node apps/phone/scripts/asc.mjs public-link --build <number> [--what-to-test <file>] [--privacy-policy <url>]
  node apps/phone/scripts/asc.mjs add-tester --email <address> [--group <name>]
  node apps/phone/scripts/asc.mjs expire --build <number>
  node apps/phone/scripts/asc.mjs app-store --build <number> [--version <x.y.z>] [--notes <file> [--notes-root <dir>]]
      [--timeout <seconds>] [--no-default-browser] [--ios-dir <dir>]
  node apps/phone/scripts/asc.mjs listing [--check] [--version <x.y.z>] [--store <dir>] [--timeout <seconds>] [--ios-dir <dir>]
  node apps/phone/scripts/asc.mjs version [--first-build] [--ios-dir <dir>]
  node apps/phone/scripts/asc.mjs preflight [--no-default-browser] [--ios-dir <dir>]

Reads the API key from ASC_KEY (path to AuthKey_<id>.p8), ASC_KEY_ID and ASC_ISSUER.
status lists what the key can see: the app record, the App IDs and their capabilities,
registered devices, certificates, profiles, builds, App Store versions and their review
submissions, and tester groups. A section the key
has no access to prints "forbidden". A read Apple answers with a server error is asked
again, up to three more times; a write never is. next-build prints the build number after the highest
one uploaded. wait blocks until a build finishes processing, and stops with Apple's reasons
when the delivery was refused. certificates --save records
the team's certificate ids; --new-since fails when a development certificate was made since
then, which means the archive didn't sign with the stored one. --create makes a development
certificate from a signing request and writes it to --out. public-link puts a build in the
external tester group (made with a public link if it doesn't exist), sets its What to Test
text, submits it for Beta App Review and prints the link. add-tester invites an email address
to an external tester group (Public Testers unless --group names another); TestFlight emails
the invite once the group has an approved build. expire ends testing of an older build for
good: nobody can install it again and Apple can't undo it. It refuses the newest build.
register-device adds an iPhone to the team's devices, so a development-signed build
(apps/phone/scripts/release-ios --development) installs on it; an iPhone already there is left as it is.
The iPhone's release version is pinned in apps/phone/ios/Config/release-version: TestFlight uploads, listing
and app-store all take it, and listing and app-store refuse a --version that differs from it. app-store also
refuses a build below apps/phone/ios/Config/first-iphone-only-build, the first build of the iPhone-only project.
version prints the pin (or, with --first-build, that build number) and fails unless each file is one plain line.
app-store sends a processed build to App Review with an App Manager key. It picks the build of the pinned
version by number; finds or makes the App Store version for it;
attaches the build; sets What's New from --notes (a short default without it); keeps the release manual;
checks the listing and the App Review contact and notes; and submits through a review submission. It
reads every review submission before it writes and again before it submits, refuses while another
version or submission is in review or waits for release, and a re-run reports what is already done
instead of doing it twice. --notes-root refuses notes that resolve outside that directory. --timeout
waits that long for a build still processing. preflight, which app-store runs first and which needs no
key, checks the export compliance answer in Info.plist, the
privacy manifest, the pinned version and, unless --no-default-browser, the default browser entitlement.
listing pushes the App Store listing from apps/phone/store (or --store) with the same App Manager key: each
locale's description, keywords, promotional text and subtitle, the URLs, categories, age rating answers,
content rights, a free price, availability in every territory, the App Review notes and, from
ASC_REVIEW_CONTACT_FIRST_NAME, _LAST_NAME, _PHONE and _EMAIL, the App Review contact, and the iPhone
screenshots in screenshots/iphone-medium and screenshots/iphone-large. It checks lengths, URLs, sizes and
alpha before any request (--check stops there and needs no key), writes only what differs, and replaces a
screenshot set only when its files or their order differ. App Privacy isn't in Apple's API: fill it in by hand.`;

const BUNDLE_PREFIX = "com.ardia.browser.ios";
const DEVELOPMENT_CERTIFICATES = new Set(["DEVELOPMENT", "IOS_DEVELOPMENT"]);
const PUBLIC_GROUP = "Public Testers";
const API = "https://api.appstoreconnect.apple.com";
const TOKEN_LIFETIME_S = 900;
const TOKEN_MARGIN_S = 60;
const IOS_DIR = fileURLToPath(new URL("../ios", import.meta.url));
const DEFAULT_WHATS_NEW = "Bug fixes and improvements.";
const WHATS_NEW_LIMIT = 4000;
const EDITABLE_VERSION_STATES = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const SHIPPED_VERSION_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PREORDER_READY_FOR_SALE", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"]);
const SUBMITTED_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);
const REOPENABLE_REVIEW_STATES = new Set(["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"]);
const STATES_AFTER_OWN_WRITE = new Map([
  ["PREPARE_FOR_SUBMISSION", ["READY_FOR_REVIEW"]],
  ["REJECTED", ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]],
  ["METADATA_REJECTED", ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]],
  ["DEVELOPER_REJECTED", ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]],
  ["INVALID_BINARY", ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]],
]);
const IPHONE_SCREENSHOT_CLASSES = [
  { dir: "iphone-medium", displayType: "APP_IPHONE_61", label: "iPhone with Dynamic Island (medium display)", sizes: [[1206, 2622], [1179, 2556]] },
  { dir: "iphone-large", displayType: "APP_IPHONE_67", label: "iPhone with Dynamic Island (large display)", sizes: [[1320, 2868], [1290, 2796], [1260, 2736]] },
];
const DEVICE_FAMILIES = new Map([
  [
    "1",
    {
      name: "iPhone",
      prefix: "APP_IPHONE_",
      required: `${IPHONE_SCREENSHOT_CLASSES.map((kind) => kind.displayType).join(" or ")}, iPhone with Dynamic Island (medium or large display)`,
      counts: (type) => IPHONE_SCREENSHOT_CLASSES.some((kind) => kind.displayType === type),
    },
  ],
  ["2", { name: "iPad", prefix: "APP_IPAD_", required: "APP_IPAD_*", counts: (type) => type?.startsWith("APP_IPAD_") ?? false }],
]);
const RELEASE_VERSION_FILE = join("Config", "release-version");
const FIRST_BUILD_FILE = join("Config", "first-iphone-only-build");
const STORE_DIR = fileURLToPath(new URL("../store", import.meta.url));
const LOCALE_DIR = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const LISTING_TEXT = [
  { file: "description.txt", field: "description", rule: "the description takes", limit: 4000, unit: "characters", required: true },
  { file: "keywords.txt", field: "keywords", rule: "the keywords take", limit: 100, unit: "bytes", required: true },
  { file: "promotional-text.txt", field: "promotionalText", rule: "the promotional text takes", limit: 170, unit: "characters", required: false },
  { file: "subtitle.txt", field: "subtitle", rule: "the subtitle takes", limit: 30, unit: "characters", required: false },
];
const REVIEW_NOTES_FILE = "review-notes.txt";
const REVIEW_NOTES = { rule: "App Review notes take", limit: 4000, unit: "bytes" };
const SCREENSHOTS_PER_SET = 10;
const LISTING_KEYS = new Set(["supportUrl", "marketingUrl", "privacyPolicyUrl", "copyright", "primaryCategory", "secondaryCategory", "ageRating", "contentRights", "price", "availability", "baseTerritory"]);
const FREQUENCY = ["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE", "INFREQUENT", "FREQUENT"];
const AGE_RATING_ANSWERS = new Map([
  ...["advertising", "datingAndRelationships", "gambling", "healthOrWellnessTopics", "lootBox", "messagingAndChat", "parentalControls", "ageAssurance", "sharedLocation", "socialMedia", "socialMediaAgeRestricted", "unrestrictedWebAccess", "userGeneratedContent"].map((key) => [key, "boolean"]),
  ...[
    "alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "gunsOrOtherWeapons", "medicalOrTreatmentInformation", "profanityOrCrudeHumor",
    "sexualContentGraphicAndNudity", "sexualContentOrNudity", "horrorOrFearThemes", "matureOrSuggestiveThemes", "violenceCartoonOrFantasy",
    "violenceRealisticProlongedGraphicOrSadistic", "violenceRealistic",
  ].map((key) => [key, FREQUENCY]),
  ["kidsAgeBand", ["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"]],
  ["ageRatingOverride", ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "SEVENTEEN_PLUS", "UNRATED"]],
  ["ageRatingOverrideV2", ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "EIGHTEEN_PLUS", "UNRATED"]],
  ["koreaAgeRatingOverride", ["NONE", "ALL", "TWELVE_PLUS", "FIFTEEN_PLUS", "NINETEEN_PLUS"]],
  ["gracRatingClassificationNumber", "text"],
  ["developerAgeRatingInfoUrl", "url"],
]);
const CONTENT_RIGHTS = new Set(["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"]);
const REVIEW_CONTACT = [
  ["contactFirstName", "ASC_REVIEW_CONTACT_FIRST_NAME"],
  ["contactLastName", "ASC_REVIEW_CONTACT_LAST_NAME"],
  ["contactPhone", "ASC_REVIEW_CONTACT_PHONE"],
  ["contactEmail", "ASC_REVIEW_CONTACT_EMAIL"],
];
const EDITABLE_APP_INFO_STATES = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED"]);
const SCREENSHOT_POLL_MS = 5000;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function token() {
  const keyPath = process.env.ASC_KEY;
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER;
  if (!keyPath || !keyId || !issuer) {
    console.error("asc: set ASC_KEY, ASC_KEY_ID and ASC_ISSUER");
    process.exit(64);
  }
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const expires = now + TOKEN_LIFETIME_S;
  const body = base64url(JSON.stringify({ iss: issuer, iat: now, exp: expires, aud: "appstoreconnect-v1" }));
  const key = createPrivateKey(readFileSync(keyPath));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return { jwt: `${head}.${body}.${signature.toString("base64url")}`, expires };
}

class ApiError extends Error {
  constructor(status, detail, errors = []) {
    super(`${status} ${detail}`);
    this.status = status;
    this.errors = errors;
  }
}

let bearer = null;

function authorization() {
  if (!bearer || Date.now() / 1000 >= bearer.expires - TOKEN_MARGIN_S) bearer = token();
  return `Bearer ${bearer.jwt}`;
}

async function fail(response) {
  const text = await response.text();
  let detail = text.slice(0, 200);
  let errors = [];
  try {
    errors = JSON.parse(text).errors;
    detail = errors.map((error) => error.detail ?? error.title).join("; ");
  } catch {}
  const safe = (Array.isArray(errors) ? errors : []).map((error) => ({ code: typeof error?.code === "string" ? error.code : null, pointer: typeof error?.source?.pointer === "string" ? error.source.pointer : null }));
  throw new ApiError(response.status, detail, safe);
}

const RETRY_AFTER_MS = [1000, 3000, 9000];

async function read(url, deadline) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRY_AFTER_MS.length || (deadline !== undefined && Date.now() + RETRY_AFTER_MS[attempt] >= deadline);
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: authorization() } });
    } catch (error) {
      if (last) throw error;
    }
    if (response && (last || (response.status < 500 && response.status !== 429))) return response;
    console.error(`asc: App Store Connect ${response ? `answered ${response.status}` : "didn't answer"}, asking again`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS[attempt]));
  }
}

async function send(method, path, body) {
  const response = await fetch(new URL(path, API), {
    method,
    headers: { Authorization: authorization(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await fail(response);
  return response.status === 204 ? null : (await response.json()).data;
}

const post = (path, body) => send("POST", path, body);
const patch = (path, body) => send("PATCH", path, body);

async function get(path, params = {}, deadline) {
  authorization();
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const rows = [];
  const included = [];
  let next = url.toString();
  while (next) {
    const response = await read(next, deadline);
    if (!response.ok) await fail(response);
    const page = await response.json();
    rows.push(...(Array.isArray(page.data) ? page.data : page.data ? [page.data] : []));
    included.push(...(page.included ?? []));
    next = page.links?.next ?? null;
  }
  return { rows, included };
}

async function section(title, read) {
  console.log(`\n## ${title}`);
  try {
    await read();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.log(error.status === 403 ? `forbidden: ${error.message}` : `error: ${error.message}`);
  }
}

function day(value) {
  return value ? value.slice(0, 10) : "?";
}

async function listApps() {
  const { rows } = await get("/v1/apps", { "fields[apps]": "name,bundleId,primaryLocale,contentRightsDeclaration", limit: "200" });
  return rows;
}

async function findApp() {
  return (await listApps()).find((row) => row.attributes.bundleId === BUNDLE_PREFIX) ?? null;
}

function ours(text) {
  return /ardia|netnyahoo/i.test(text ?? "");
}

async function listBuilds(appId, build) {
  const params = {
    "filter[app]": appId,
    sort: "-uploadedDate",
    limit: "20",
    "fields[builds]": "version,uploadedDate,processingState,expired,usesNonExemptEncryption,minOsVersion,preReleaseVersion,buildBetaDetail",
    include: "preReleaseVersion,buildBetaDetail",
    "fields[preReleaseVersions]": "version",
    "fields[buildBetaDetails]": "internalBuildState,externalBuildState",
  };
  if (build) params["filter[version]"] = build;
  const { rows, included } = await get("/v1/builds", params);
  const byKey = new Map(included.map((row) => [`${row.type}:${row.id}`, row]));
  return rows.slice(0, 20).map((row) => {
    const related = (name) => {
      const link = row.relationships?.[name]?.data;
      return link ? byKey.get(`${link.type}:${link.id}`) : undefined;
    };
    return {
      version: related("preReleaseVersion")?.attributes.version ?? "?",
      build: row.attributes.version,
      uploaded: day(row.attributes.uploadedDate),
      processing: row.attributes.processingState,
      expired: row.attributes.expired,
      encryption: row.attributes.usesNonExemptEncryption,
      internal: related("buildBetaDetail")?.attributes.internalBuildState ?? "?",
      external: related("buildBetaDetail")?.attributes.externalBuildState ?? "?",
    };
  });
}

function printBuilds(builds) {
  if (builds.length === 0) console.log("none");
  for (const build of builds) {
    console.log(
      `${build.version} (${build.build}) uploaded ${build.uploaded} processing=${build.processing} ` +
        `internal=${build.internal} external=${build.external} encryption=${build.encryption} expired=${build.expired}`,
    );
  }
}

async function status() {
  let app = null;
  await section("App record", async () => {
    const apps = await listApps();
    app = apps.find((row) => row.attributes.bundleId === BUNDLE_PREFIX) ?? null;
    console.log(app ? `${app.attributes.name} ${app.attributes.bundleId} (id ${app.id})` : `none for ${BUNDLE_PREFIX}`);
    const related = apps.filter((row) => row !== app && (ours(row.attributes.bundleId) || ours(row.attributes.name)));
    for (const row of related) console.log(`also: ${row.attributes.name} ${row.attributes.bundleId}`);
    console.log(`${apps.length} app records visible to this key`);
  });

  await section("App IDs", async () => {
    const { rows: all, included } = await get("/v1/bundleIds", {
      "fields[bundleIds]": "identifier,platform,bundleIdCapabilities",
      include: "bundleIdCapabilities",
      limit: "200",
    });
    const capabilities = new Map(included.map((row) => [row.id, row.attributes.capabilityType]));
    const rows = all.filter((row) => ours(row.attributes.identifier));
    console.log(`${all.length} App IDs on the team, ${rows.length} of them Ardia's`);
    for (const row of rows) {
      const types = (row.relationships?.bundleIdCapabilities?.data ?? []).map((link) => capabilities.get(link.id) ?? "?");
      console.log(`${row.attributes.identifier} ${row.attributes.platform} [${types.sort().join(", ")}]`);
    }
  });

  await section("Devices", async () => {
    const { rows } = await get("/v1/devices", { "fields[devices]": "platform,deviceClass,status", limit: "200" });
    const counts = {};
    for (const row of rows) {
      const kind = `${row.attributes.deviceClass} ${row.attributes.status}`;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    console.log(rows.length === 0 ? "none" : Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(", "));
  });

  await section("Certificates", async () => {
    const { rows } = await get("/v1/certificates", { "fields[certificates]": "certificateType,expirationDate", limit: "200" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) console.log(`${row.attributes.certificateType} expires ${day(row.attributes.expirationDate)}`);
  });

  await section("Profiles", async () => {
    const { rows } = await get("/v1/profiles", { "fields[profiles]": "name,profileType,profileState,expirationDate", limit: "200" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const profile = row.attributes;
      console.log(`${profile.profileType} ${profile.profileState} expires ${day(profile.expirationDate)} ${profile.name}`);
    }
  });

  if (!app) return;

  await section("Builds", async () => printBuilds(await listBuilds(app.id)));

  await section("App Store versions", async () => {
    const versions = await listAppStoreVersions(app.id);
    if (versions.length === 0) console.log("none");
    for (const version of versions) {
      console.log(`${version.version} state=${version.state} release=${version.releaseType} build=${version.build ?? "none"} created ${version.created}`);
    }
  });

  await section("App Store review submissions", async () => {
    const submissions = newestFirst(await listReviewSubmissions(app.id));
    if (submissions.length === 0) console.log("none");
    for (const submission of submissions.slice(0, 5)) {
      console.log(`${submission.state} submitted ${submission.submitted ? day(submission.submitted) : "not yet"}`);
    }
  });

  await section("Build uploads", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/buildUploads`, { limit: "200" });
    if (rows.length === 0) console.log("none");
    const byBuild = rows.toSorted((a, b) => Number(b.attributes?.cfBundleVersion) - Number(a.attributes?.cfBundleVersion));
    for (const row of byBuild.slice(0, 15)) {
      const a = row.attributes ?? {};
      console.log(`${a.cfBundleShortVersionString ?? "?"} (${a.cfBundleVersion ?? "?"}) state=${a.state?.state ?? "?"} created=${a.createdDate ?? "?"} uploaded=${a.uploadedDate ?? "none"}`);
    }
  });

  await section("Encryption declarations", async () => {
    const { rows } = await get("/v1/appEncryptionDeclarations", { "filter[app]": app.id, limit: "50" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const declaration = row.attributes;
      console.log(
        `code ${declaration.codeValue ?? "none"} state=${declaration.appEncryptionDeclarationState} exempt=${declaration.exempt} ` +
          `proprietary=${declaration.containsProprietaryCryptography} thirdParty=${declaration.containsThirdPartyCryptography} ` +
          `france=${declaration.availableOnFrenchStore} created ${day(declaration.createdDate)}`,
      );
    }
  });

  await section("Tester groups", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaGroups`, { "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLink,iosBuildsAvailableForAppleSiliconMac" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const group = row.attributes;
      const { rows: testers } = await get(`/v1/betaGroups/${row.id}/betaTesters`, { "fields[betaTesters]": "state", limit: "200" });
      const states = {};
      for (const tester of testers) states[tester.attributes.state ?? "?"] = (states[tester.attributes.state ?? "?"] ?? 0) + 1;
      const summary = Object.entries(states).map(([state, count]) => `${count} ${state}`).join(", ") || "none";
      console.log(
        `${group.name} ${group.isInternalGroup ? "internal" : "external"} allBuilds=${group.hasAccessToAllBuilds} ` +
          `publicLink=${group.publicLinkEnabled ? group.publicLink : group.publicLinkEnabled} mac=${group.iosBuildsAvailableForAppleSiliconMac} testers: ${summary}`,
      );
    }
  });

  await section("Beta review details", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppReviewDetail`, {
      "fields[betaAppReviewDetails]": "contactEmail,demoAccountRequired,notes",
    });
    const detail = rows[0]?.attributes;
    console.log(detail ? `contact ${detail.contactEmail ? "set" : "missing"}, notes ${detail.notes ? "set" : "missing"}` : "none");
  });

  await section("Beta test info", async () => {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: "50" });
    if (rows.length === 0) console.log("none");
    for (const row of rows) {
      const info = row.attributes;
      console.log(
        `${info.locale}: description ${info.description ? `${info.description.length} chars` : "missing"}, ` +
          `feedback email ${info.feedbackEmail ? "set" : "missing"}, privacy policy ${info.privacyPolicyUrl ?? "missing"}, ` +
          `marketing ${info.marketingUrl ?? "missing"}`,
      );
    }
  });
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function requireApp() {
  const app = await findApp();
  if (!app) {
    console.error(`asc: no app record for ${BUNDLE_PREFIX}`);
    process.exit(1);
  }
  return app;
}

async function builds(args) {
  const app = await requireApp();
  printBuilds(await listBuilds(app.id, option(args, "--build")));
}

async function deliveryRefusal(appId, build) {
  try {
    const { rows } = await get(`/v1/apps/${appId}/buildUploads`, { "filter[cfBundleVersion]": build, limit: "10" });
    const failed = rows.find((row) => row.attributes?.state?.state === "FAILED");
    if (!failed) return null;
    const errors = failed.attributes.state.errors ?? [];
    return errors.map((error) => `${error.code ?? ""} ${error.description ?? ""}`.trim()).join("\n") || "no reason given";
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

async function wait(args) {
  const build = option(args, "--build");
  if (!build) {
    console.error("asc: wait needs --build <number>");
    process.exit(64);
  }
  const deadline = Date.now() + Number(option(args, "--timeout") ?? 1500) * 1000;
  const app = await requireApp();
  let last = "";
  while (Date.now() < deadline) {
    const [found] = await listBuilds(app.id, build);
    const awaitsTesterState = found?.processing === "VALID" && found.internal === "?";
    const state = !found ? "not listed yet" : awaitsTesterState ? "VALID, not ready for testers yet" : found.processing;
    if (!found) {
      const refusal = await deliveryRefusal(app.id, build);
      if (refusal) {
        console.error(`asc: App Store Connect refused build ${build}:\n${refusal}`);
        process.exit(1);
      }
    }
    if (state !== last) console.log(`build ${build}: ${state}`);
    last = state;
    if (found && found.processing !== "PROCESSING" && !awaitsTesterState) {
      printBuilds([found]);
      process.exit(found.processing === "VALID" ? 0 : 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  console.error(`asc: build ${build} was still ${last} at the deadline`);
  process.exit(124);
}

async function uploadedBuildNumbers(appId) {
  try {
    const { rows } = await get(`/v1/apps/${appId}/buildUploads`, { limit: "200" });
    return rows.map((row) => row.attributes?.cfBundleVersion);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.status !== 429) return [];
    throw error;
  }
}

async function nextBuild() {
  const app = await requireApp();
  const seen = [...(await listBuilds(app.id)).map((build) => build.build), ...(await uploadedBuildNumbers(app.id))];
  console.log(Math.max(0, ...seen.map(Number).filter(Number.isInteger)) + 1);
}

async function createCertificate(requestPath, out) {
  const made = await post("/v1/certificates", {
    data: { type: "certificates", attributes: { certificateType: "DEVELOPMENT", csrContent: readFileSync(requestPath, "utf8") } },
  });
  writeFileSync(out, Buffer.from(made.attributes.certificateContent, "base64"));
  console.log(`created a ${made.attributes.certificateType} certificate, expires ${day(made.attributes.expirationDate)}`);
}

async function certificates(args) {
  const create = option(args, "--create");
  if (create) {
    const out = option(args, "--out");
    if (!out) {
      console.error("asc: certificates --create needs --out <file.cer>");
      process.exit(64);
    }
    await createCertificate(create, out);
    return;
  }
  const { rows } = await get("/v1/certificates", { "fields[certificates]": "certificateType,expirationDate", limit: "200" });
  const save = option(args, "--save");
  const since = option(args, "--new-since");
  if (save) {
    writeFileSync(save, JSON.stringify(rows.map((row) => row.id)));
    console.log(`${rows.length} certificates recorded`);
    return;
  }
  if (!since) {
    console.error("asc: certificates needs --save, --new-since or --create");
    process.exit(64);
  }
  const before = new Set(JSON.parse(readFileSync(since, "utf8")));
  const made = rows.filter((row) => !before.has(row.id));
  for (const row of made) console.log(`new ${row.attributes.certificateType} certificate, expires ${day(row.attributes.expirationDate)}`);
  if (made.length === 0) console.log("no new certificates");
  if (made.some((row) => DEVELOPMENT_CERTIFICATES.has(row.attributes.certificateType))) process.exit(1);
}

async function onceListed(action) {
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
}

async function unlessAlready(action, done) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error;
    console.log(`${done}: ${error.message}`);
  }
}

async function publicLink(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: public-link needs --build <number>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows: found } = await get("/v1/builds", { "filter[app]": app.id, "filter[version]": number, "fields[builds]": "version,processingState" });
  const build = found[0];
  if (!build || build.attributes.processingState !== "VALID") {
    console.error(`asc: build ${number} is ${build ? build.attributes.processingState : "not on App Store Connect"}`);
    process.exit(1);
  }

  const policy = option(args, "--privacy-policy");
  if (policy) {
    const { rows } = await get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: "50" });
    for (const row of rows.filter((row) => row.attributes.privacyPolicyUrl !== policy)) {
      await patch(`/v1/betaAppLocalizations/${row.id}`, { data: { type: "betaAppLocalizations", id: row.id, attributes: { privacyPolicyUrl: policy } } });
      console.log(`privacy policy set for ${row.attributes.locale}`);
    }
  }

  const notesPath = option(args, "--what-to-test");
  if (notesPath) {
    const whatsNew = readFileSync(notesPath, "utf8").trim();
    const { rows } = await get(`/v1/builds/${build.id}/betaBuildLocalizations`, { limit: "50" });
    if (rows.length === 0) {
      await post("/v1/betaBuildLocalizations", {
        data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew }, relationships: { build: { data: { type: "builds", id: build.id } } } },
      });
    }
    for (const row of rows) {
      await patch(`/v1/betaBuildLocalizations/${row.id}`, { data: { type: "betaBuildLocalizations", id: row.id, attributes: { whatsNew } } });
    }
    console.log("What to Test set");
  }

  const fields = { "fields[betaGroups]": "name,isInternalGroup,publicLinkEnabled,publicLink,iosBuildsAvailableForAppleSiliconMac" };
  const { rows: groups } = await get(`/v1/apps/${app.id}/betaGroups`, fields);
  let group = groups.find((row) => !row.attributes.isInternalGroup && row.attributes.name === PUBLIC_GROUP);
  if (!group) {
    group = await post("/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes: { name: PUBLIC_GROUP, publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    console.log(`created the ${PUBLIC_GROUP} group`);
  }
  if (group.attributes.iosBuildsAvailableForAppleSiliconMac !== false) {
    await patch(`/v1/betaGroups/${group.id}`, { data: { type: "betaGroups", id: group.id, attributes: { iosBuildsAvailableForAppleSiliconMac: false } } });
    console.log(`${PUBLIC_GROUP} builds are no longer offered on Apple silicon Macs`);
  }

  await unlessAlready(
    () => onceListed(() => post(`/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] })),
    "build already in the group",
  );
  await unlessAlready(
    () => post("/v1/betaAppReviewSubmissions", { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } } }),
    "not submitted",
  );

  const { rows: after } = await get(`/v1/betaGroups/${group.id}`, fields);
  printBuilds(await listBuilds(app.id, number));
  console.log(`public link: ${after[0].attributes.publicLink ?? "none yet"}`);
}

async function addTester(args) {
  const email = option(args, "--email")?.trim().toLowerCase();
  const groupName = option(args, "--group") ?? PUBLIC_GROUP;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("asc: add-tester needs --email <address>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows: groups } = await get(`/v1/apps/${app.id}/betaGroups`, { "fields[betaGroups]": "name,isInternalGroup" });
  const group = groups.find((row) => !row.attributes.isInternalGroup && row.attributes.name === groupName);
  if (!group) {
    console.error(`asc: no external group named ${groupName}; run public-link first`);
    process.exit(1);
  }
  const { rows: existing } = await get("/v1/betaTesters", { "filter[email]": email, "fields[betaTesters]": "state", limit: "10" });
  if (existing.length === 0) {
    await post("/v1/betaTesters", {
      data: { type: "betaTesters", attributes: { email }, relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } } },
    });
    console.log(`tester invited to ${groupName}`);
  } else {
    await unlessAlready(
      () => post(`/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: "betaTesters", id: existing[0].id }] }),
      "tester already in the group",
    );
    console.log(`tester (${existing[0].attributes.state ?? "?"}) is in ${groupName}`);
  }
  const { rows: testers } = await get(`/v1/betaGroups/${group.id}/betaTesters`, { "fields[betaTesters]": "state", limit: "200" });
  console.log(`${groupName} now has ${testers.length} testers`);
}

async function expire(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: expire needs --build <number>");
    process.exit(64);
  }
  const app = await requireApp();
  const { rows } = await get("/v1/builds", { "filter[app]": app.id, "fields[builds]": "version,expired", limit: "200" });
  const build = rows.find((row) => row.attributes.version === number);
  if (!build) {
    console.error(`asc: build ${number} is not on App Store Connect`);
    process.exit(1);
  }
  const live = rows.filter((row) => !row.attributes.expired).map((row) => Number(row.attributes.version));
  if (build.attributes.expired) {
    console.log(`build ${number} was already expired`);
  } else if (Number(number) >= Math.max(...live)) {
    console.error(`asc: build ${number} is the newest one testers have; expire an older build`);
    process.exit(1);
  } else {
    await patch(`/v1/builds/${build.id}`, { data: { type: "builds", id: build.id, attributes: { expired: true } } });
    console.log(`build ${number} expired`);
  }
  printBuilds(await listBuilds(app.id));
}

function refuse(message) {
  console.error(`asc: ${message}`);
  process.exit(1);
}

async function listAppStoreVersions(appId) {
  const { rows, included } = await get(`/v1/apps/${appId}/appStoreVersions`, {
    "filter[platform]": "IOS",
    "fields[appStoreVersions]": "versionString,appStoreState,appVersionState,releaseType,copyright,createdDate,build",
    include: "build",
    "fields[builds]": "version",
    limit: "50",
  });
  const builds = new Map(included.filter((row) => row.type === "builds").map((row) => [row.id, row]));
  return rows.map((row) => {
    const link = row.relationships?.build?.data;
    return {
      id: row.id,
      version: row.attributes.versionString,
      state: row.attributes.appVersionState ?? row.attributes.appStoreState ?? "?",
      releaseType: row.attributes.releaseType ?? "?",
      copyright: row.attributes.copyright ?? null,
      created: day(row.attributes.createdDate),
      createdAt: row.attributes.createdDate ?? "",
      buildId: link?.id ?? null,
      build: link ? (builds.get(link.id)?.attributes.version ?? "?") : null,
    };
  });
}

async function listReviewSubmissions(appId) {
  const { rows } = await get("/v1/reviewSubmissions", {
    "filter[app]": appId,
    "filter[platform]": "IOS",
    "fields[reviewSubmissions]": "state,submittedDate,platform",
    limit: "50",
  });
  return rows.map((row) => ({ id: row.id, state: row.attributes.state ?? "?", submitted: row.attributes.submittedDate ?? null }));
}

function newestFirst(submissions) {
  return submissions.toSorted((a, b) => (b.submitted ?? "~").localeCompare(a.submitted ?? "~"));
}

async function listSubmissionItems(submissionId) {
  const { rows } = await get(`/v1/reviewSubmissions/${submissionId}/items`, {
    "fields[reviewSubmissionItems]": "state,appStoreVersion",
    include: "appStoreVersion",
    limit: "50",
  });
  return rows.map((row) => ({ id: row.id, state: row.attributes?.state ?? "?", versionId: row.relationships?.appStoreVersion?.data?.id ?? null }));
}

async function openReviewSubmissions(appId) {
  const open = (await listReviewSubmissions(appId)).filter((submission) => submission.state !== "COMPLETE");
  const withItems = [];
  for (const submission of open) withItems.push({ ...submission, items: await listSubmissionItems(submission.id) });
  return withItems;
}

function submissionsFingerprint(submissions) {
  return JSON.stringify(
    submissions
      .map((submission) => [submission.id, submission.state, submission.items.map((item) => `${item.id}:${item.versionId}`).sort()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function planVersion(versions, versionString, buildId) {
  const same = versions.find((version) => version.version === versionString);
  if (same && SHIPPED_VERSION_STATES.has(same.state)) {
    return { act: "refuse", message: `version ${versionString} is already ${same.state}; a new App Store release needs a new version` };
  }
  if (same && !EDITABLE_VERSION_STATES.has(same.state)) {
    if (same.buildId === buildId) return { act: "done", version: same };
    return {
      act: "refuse",
      message: `version ${versionString} is ${same.state} with build ${same.build ?? "none"}; remove it from review in App Store Connect before sending another build`,
    };
  }
  const busy = versions.find((version) => version !== same && !EDITABLE_VERSION_STATES.has(version.state) && !SHIPPED_VERSION_STATES.has(version.state));
  if (busy) return { act: "refuse", message: `version ${busy.version} is ${busy.state}; release it or remove it from review before submitting ${versionString}` };
  if (same) return { act: "use", version: same };
  const drafts = versions.filter((version) => EDITABLE_VERSION_STATES.has(version.state));
  if (drafts.length === 0) return { act: "create" };
  if (drafts.length === 1 && drafts[0].state === "PREPARE_FOR_SUBMISSION") return { act: "rename", version: drafts[0] };
  return {
    act: "refuse",
    message: `${drafts.map((version) => `${version.version} is ${version.state}`).join(", ")}; only a lone draft in PREPARE_FOR_SUBMISSION is renamed to ${versionString}, so settle these in App Store Connect first`,
  };
}

function planSubmission(submissions, versionId, versionNames) {
  const holdsThis = (submission) => versionId !== null && submission.items.some((item) => item.versionId === versionId);
  const others = (submission) => submission.items.filter((item) => item.versionId === null || item.versionId !== versionId);
  const label = (item) => (item.versionId ? `version ${versionNames.get(item.versionId) ?? item.versionId}` : `item ${item.id}, which is not an App Store version`);
  const holding = (submission) => {
    const foreign = others(submission);
    return foreign.length > 0 ? ` and holds ${foreign.map(label).join(", ")}` : "";
  };
  const submitted = submissions.find((submission) => SUBMITTED_REVIEW_STATES.has(submission.state) && holdsThis(submission));
  if (submitted) return { act: "done", submission: submitted };
  const blockers = [];
  const reusable = [];
  for (const submission of submissions) {
    const clean = others(submission).length === 0;
    if (submission.state === "READY_FOR_REVIEW" && clean) reusable.push(submission);
    else if (submission.state === "UNRESOLVED_ISSUES" && clean && holdsThis(submission)) reusable.push(submission);
    else if (SUBMITTED_REVIEW_STATES.has(submission.state)) blockers.push(`review submission ${submission.id} is ${submission.state}${holding(submission)}; wait for it or cancel it`);
    else if (REOPENABLE_REVIEW_STATES.has(submission.state)) {
      blockers.push(`review submission ${submission.id} is ${submission.state}${holding(submission) || " for nothing of this version"}; remove those items or settle it in App Store Connect`);
    } else blockers.push(`review submission ${submission.id} is ${submission.state}; run this again in a few minutes`);
  }
  if (blockers.length > 0) return { act: "refuse", message: `nothing was submitted:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}` };
  const reuse = reusable.find(holdsThis) ?? reusable[0];
  return reuse ? { act: "use", submission: reuse } : { act: "create" };
}

function contents(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function projectPath(iosDir) {
  return join(iosDir, "Ardia.xcodeproj", "project.pbxproj");
}

function targetedFamilies(iosDir) {
  const project = contents(projectPath(iosDir)) ?? "";
  const releases = project.match(/\/\* Release \*\/ = \{[\s\S]*?\n\t\t\};/g) ?? [];
  const bundle = new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = "?${BUNDLE_PREFIX.replaceAll(".", "\\.")}"?;`);
  const value = releases.find((block) => bundle.test(block))?.match(/TARGETED_DEVICE_FAMILY = "?([\d,]+)"?;/)?.[1];
  const families = (value ?? "").split(",").map((code) => DEVICE_FAMILIES.get(code.trim())).filter(Boolean);
  return families.length > 0 ? families : null;
}

function shown(path) {
  return relative(process.cwd(), path) || path;
}

function pinnedLine(iosDir, file, pattern) {
  const raw = contents(join(iosDir, file));
  return raw !== null && pattern.test(raw) ? raw.replace(/\n$/, "") : null;
}

function pinnedVersion(iosDir) {
  return pinnedLine(iosDir, RELEASE_VERSION_FILE, /^\d+\.\d+\.\d+\n?$/);
}

function firstIphoneOnlyBuild(iosDir) {
  const line = pinnedLine(iosDir, FIRST_BUILD_FILE, /^[1-9]\d*\n?$/);
  return line === null ? null : Number(line);
}

function pinProblems(iosDir) {
  const problems = [];
  if (!pinnedVersion(iosDir)) problems.push(`${shown(join(iosDir, RELEASE_VERSION_FILE))} must hold one line with the version as x.y.z`);
  if (!firstIphoneOnlyBuild(iosDir)) problems.push(`${shown(join(iosDir, FIRST_BUILD_FILE))} must hold one line with a build number`);
  return problems;
}

async function version(args) {
  const iosDir = option(args, "--ios-dir") ?? IOS_DIR;
  const problems = pinProblems(iosDir);
  if (problems.length > 0) refuse(problems.join("\n"));
  console.log(args.includes("--first-build") ? firstIphoneOnlyBuild(iosDir) : pinnedVersion(iosDir));
}

function preflightGaps(iosDir, defaultBrowser) {
  const gaps = [];
  const infoPath = join(iosDir, "Ardia", "Info.plist");
  const info = contents(infoPath);
  if (info === null) gaps.push(`${shown(infoPath)} is missing`);
  else if (!/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\/>/.test(info)) {
    gaps.push(`${shown(infoPath)} doesn't answer export compliance: set ITSAppUsesNonExemptEncryption (docs/phone.md › Export compliance)`);
  }
  const privacyPath = join(iosDir, "PrivacyInfo.xcprivacy");
  if (!/<plist/.test(contents(privacyPath) ?? "")) gaps.push(`${shown(privacyPath)} is missing: App Review refuses an app without its privacy manifest`);
  if (!targetedFamilies(iosDir)) {
    gaps.push(`${shown(projectPath(iosDir))} gives ${BUNDLE_PREFIX}'s Release build no TARGETED_DEVICE_FAMILY, so the screenshots it needs are unknown`);
  }
  gaps.push(...pinProblems(iosDir));
  if (defaultBrowser) {
    const entitlementsPath = join(iosDir, "Config", "Ardia-DefaultBrowser.entitlements");
    if (!/<key>com\.apple\.developer\.web-browser<\/key>\s*<true\/>/.test(contents(entitlementsPath) ?? "")) {
      gaps.push(`${shown(entitlementsPath)} doesn't grant com.apple.developer.web-browser: restore it, or pass --no-default-browser for a build signed without it`);
    }
  }
  return gaps;
}

function requirePreflight(args) {
  const defaultBrowser = !args.includes("--no-default-browser");
  const iosDir = option(args, "--ios-dir") ?? IOS_DIR;
  const gaps = preflightGaps(iosDir, defaultBrowser);
  if (gaps.length > 0) refuse(`the iPhone app isn't ready for App Review:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  const families = targetedFamilies(iosDir);
  const version = pinnedVersion(iosDir);
  const firstBuild = firstIphoneOnlyBuild(iosDir);
  console.log(
    `preflight passed: export compliance answered, privacy manifest present${defaultBrowser ? ", default browser entitlement present" : ""}, ` +
      `version ${version} from build ${firstBuild}, for ${families.map((family) => family.name).join(" and ")}`,
  );
  return { families, version, firstBuild };
}

async function preflight(args) {
  requirePreflight(args);
}

async function encryptionDeclarationState(buildId) {
  try {
    const { rows } = await get(`/v1/builds/${buildId}/appEncryptionDeclaration`, { "fields[appEncryptionDeclarations]": "appEncryptionDeclarationState" });
    return rows[0]?.attributes?.appEncryptionDeclarationState ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function processedBuild(appId, number, wanted, timeout) {
  const deadline = Date.now() + timeout * 1000;
  let said = "";
  for (;;) {
    const { rows, included } = await get(
      "/v1/builds",
      {
        "filter[app]": appId,
        "filter[version]": number,
        "fields[builds]": "version,processingState,expired,usesNonExemptEncryption,preReleaseVersion",
        include: "preReleaseVersion",
        "fields[preReleaseVersions]": "version",
      },
      timeout > 0 ? deadline : undefined,
    );
    const versionOf = (row) => {
      const link = row.relationships?.preReleaseVersion?.data;
      return included.find((candidate) => candidate.type === "preReleaseVersions" && candidate.id === link?.id)?.attributes.version ?? "?";
    };
    const numbered = rows.filter((candidate) => candidate.attributes.version === number);
    const matching = wanted ? numbered.filter((candidate) => versionOf(candidate) === wanted) : numbered;
    if (matching.length > 1) {
      refuse(`build ${number} is on App Store Connect for ${matching.map((row) => `${versionOf(row)} (${row.attributes.processingState})`).join(", ")}; pass --version`);
    }
    const row = matching[0];
    const elsewhere = numbered.length > 0 ? ` (it is for ${numbered.map(versionOf).join(", ")})` : "";
    const state = row ? row.attributes.processingState : `not on App Store Connect${wanted ? elsewhere : ""}`;
    const subject = wanted ? `build ${number} of ${wanted}` : `build ${number}`;
    if (row && state !== "PROCESSING") {
      if (state !== "VALID") refuse(`${subject} is ${state}`);
      if (row.attributes.expired) refuse(`${subject} has expired; upload a new build`);
      if (row.attributes.usesNonExemptEncryption == null) {
        refuse(`${subject} has no export compliance answer; set ITSAppUsesNonExemptEncryption and upload a new build`);
      }
      if (row.attributes.usesNonExemptEncryption) {
        const declaration = await encryptionDeclarationState(row.id);
        if (declaration !== "APPROVED") {
          refuse(
            `${subject} declares non-exempt encryption and ${declaration ? `its encryption declaration is ${declaration}` : "has no encryption declaration"}; ` +
              "App Review needs an approved one (docs/phone.md › Export compliance)",
          );
        }
        console.log(`${subject} declares non-exempt encryption under an approved encryption declaration`);
      }
      const version = versionOf(row);
      if (version === "?") refuse(`App Store Connect gives ${subject} no version`);
      return { id: row.id, number, version };
    }
    const tooLate = () => refuse(`${subject} is ${state}${timeout > 0 ? ` after ${timeout} s` : ""}`);
    const left = deadline - Date.now();
    if (left <= 0) tooLate();
    if (state !== said) console.log(`${subject}: ${state}, waiting`);
    said = state;
    await new Promise((resolve) => setTimeout(resolve, Math.min(30000, left)));
    if (Date.now() >= deadline) tooLate();
  }
}

function notesInside(notesPath, root) {
  let real;
  try {
    real = realpathSync(notesPath);
  } catch {
    refuse(`no notes file at ${notesPath}`);
  }
  const base = realpathSync(root);
  if (!real.startsWith(base + sep)) refuse(`${notesPath} resolves to ${real}, outside ${base}`);
  if (!statSync(real).isFile()) refuse(`${notesPath} is not a file`);
  return real;
}

function whatsNewText(notesPath, root) {
  if (!notesPath) {
    console.log(`no --notes given, so What's New reads "${DEFAULT_WHATS_NEW}"`);
    return DEFAULT_WHATS_NEW;
  }
  const text = readFileSync(root ? notesInside(notesPath, root) : notesPath, "utf8").trim();
  if (!text) refuse(`${notesPath} is empty`);
  if (text.length > WHATS_NEW_LIMIT) refuse(`${notesPath} has ${text.length} characters; What's New takes at most ${WHATS_NEW_LIMIT}`);
  return text;
}

async function reviewDetail(versionId) {
  try {
    const { rows } = await get(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`, {
      "fields[appStoreReviewDetails]": "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,demoAccountName,demoAccountPassword,notes",
    });
    return rows[0]?.attributes ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function reviewDetailGaps(detail) {
  if (!detail) return ["App Review Information: contact name, phone, email and notes"];
  const gaps = [];
  const contact = [
    ["contactFirstName", "contact first name"],
    ["contactLastName", "contact last name"],
    ["contactPhone", "contact phone"],
    ["contactEmail", "contact email"],
  ];
  for (const [field, label] of contact) if (!detail[field]?.trim()) gaps.push(`App Review ${label}`);
  if (!detail.notes?.trim()) gaps.push("App Review notes");
  if (detail.demoAccountRequired && !(detail.demoAccountName && detail.demoAccountPassword)) gaps.push("App Review demo account name and password");
  return gaps;
}

async function listingGaps(localization, locale, families) {
  if (!localization) return [`the ${locale} App Store listing`];
  const gaps = [];
  const fields = [
    ["description", "description"],
    ["keywords", "keywords"],
    ["supportUrl", "support URL"],
  ];
  for (const [field, label] of fields) if (!localization.attributes[field]?.trim()) gaps.push(`${locale} ${label}`);
  const { rows: sets, included } = await get(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`, {
    "fields[appScreenshotSets]": "screenshotDisplayType,appScreenshots",
    include: "appScreenshots",
    "fields[appScreenshots]": "assetDeliveryState",
    limit: "50",
  });
  const delivery = new Map(included.filter((row) => row.type === "appScreenshots").map((row) => [row.id, row.attributes?.assetDeliveryState?.state]));
  const finishedIn = (set) => (set.relationships?.appScreenshots?.data ?? []).filter((link) => delivery.get(link.id) === "COMPLETE").length;
  for (const family of families) {
    const mine = sets.filter((set) => family.counts(set.attributes?.screenshotDisplayType));
    const linked = mine.flatMap((set) => set.relationships?.appScreenshots?.data ?? []);
    if (mine.some((set) => finishedIn(set) > 0)) continue;
    const elsewhere = sets
      .filter((set) => !mine.includes(set) && finishedIn(set) > 0 && set.attributes?.screenshotDisplayType?.startsWith(family.prefix))
      .map((set) => set.attributes.screenshotDisplayType);
    const detail = [
      linked.length > 0 ? `${linked.length} not finished uploading` : mine.length > 0 ? `${mine.length} empty screenshot sets` : "",
      elsewhere.length > 0 ? `only ${elsewhere.join(", ")} finished, which App Review doesn't take in their place` : "",
    ].filter(Boolean);
    gaps.push(`${locale} ${family.name} screenshots in ${family.required}${detail.length > 0 ? ` (${detail.join("; ")})` : ""}`);
  }
  return gaps;
}

async function requireVersionUnchanged(appId, expected) {
  const now = (await listAppStoreVersions(appId)).find((row) => row.id === expected.id);
  const drift = now
    ? [
        ["version", now.version === expected.version, now.version],
        ["state", expected.states.has(now.state), now.state],
        ["build", now.buildId === expected.buildId, now.build ?? "none"],
        ["release", now.releaseType === expected.releaseType, now.releaseType],
      ]
        .filter(([, same]) => !same)
        .map(([name, , shown]) => `${name} is now ${shown}`)
    : ["it is gone"];
  if (drift.length > 0) refuse(`version ${expected.version} changed while this ran (${drift.join(", ")}); nothing was submitted, run this again`);
  expected.states = new Set([now.state]);
  return now;
}

function allowOwnWrite(expected) {
  for (const state of [...expected.states]) for (const next of STATES_AFTER_OWN_WRITE.get(state) ?? []) expected.states.add(next);
}

function requireManualAlready(version, where) {
  if (version.releaseType === "MANUAL") return;
  refuse(
    `${where}, but its release is ${version.releaseType}, so Apple would release it as soon as it's approved; ` +
      "set it to Manual in App Store Connect (the version's App Store Version Release). Nothing was changed, and the submission is left as it is",
  );
}

function carriedCopyright(versions) {
  return versions.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).find((row) => row.copyright?.trim())?.copyright ?? null;
}

async function appStore(args) {
  const number = option(args, "--build");
  if (!number) {
    console.error("asc: app-store needs --build <number>");
    process.exit(64);
  }
  const timeout = Number(option(args, "--timeout") ?? 0);
  if (!Number.isFinite(timeout) || timeout < 0) {
    console.error("asc: --timeout takes seconds");
    process.exit(64);
  }
  if (!/^[1-9]\d*$/.test(number)) {
    console.error("asc: --build takes a build number");
    process.exit(64);
  }
  const { families, version: pinned, firstBuild } = requirePreflight(args);
  if (Number(number) < firstBuild) {
    refuse(
      `build ${number} is older than build ${firstBuild}, the first iPhone-only build (apps/phone/ios/${FIRST_BUILD_FILE}); ` +
        "builds before it were made for iPhone and iPad, so upload a new build to TestFlight and submit that one",
    );
  }
  const asked = option(args, "--version");
  if (asked !== undefined && asked !== pinned) {
    refuse(`--version ${asked} isn't the pinned iPhone version ${pinned} (apps/phone/ios/${RELEASE_VERSION_FILE}), which TestFlight uploads too; change the pin in a commit instead`);
  }
  const whatsNew = whatsNewText(option(args, "--notes"), option(args, "--notes-root"));
  const app = await requireApp();
  const build = await processedBuild(app.id, number, pinned, timeout);
  const versionString = build.version;

  const versions = await listAppStoreVersions(app.id);
  const plan = planVersion(versions, versionString, build.id);
  if (plan.act === "refuse") refuse(plan.message);
  if (plan.act === "done") {
    requireManualAlready(plan.version, `version ${versionString} is ${plan.version.state} with build ${number}`);
    console.log(`version ${versionString} with build ${number} is already ${plan.version.state}; nothing to do`);
    return;
  }
  const versionNames = new Map(versions.map((row) => [row.id, row.version]));
  const submissions = await openReviewSubmissions(app.id);
  const early = planSubmission(submissions, plan.version?.id ?? null, versionNames);
  if (early.act === "refuse") refuse(early.message);
  if (early.act === "done") {
    const reviewed = (await listAppStoreVersions(app.id)).find((row) => row.id === plan.version.id);
    if (reviewed?.buildId !== build.id) {
      refuse(
        `version ${versionString} is in a review submission that is ${early.submission.state} with build ${reviewed?.build ?? "none"}, not ${number}; ` +
          "remove it from review in App Store Connect before sending another build",
      );
    }
    requireManualAlready(reviewed, `version ${versionString} is in a review submission that is ${early.submission.state} with build ${number}`);
    console.log(`version ${versionString} is already in a review submission that is ${early.submission.state}; nothing to do`);
    return;
  }

  let version = plan.version;
  let wroteVersion = plan.act !== "use";
  if (plan.act === "create") {
    const copyright = carriedCopyright(versions);
    const made = await post("/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString, releaseType: "MANUAL", ...(copyright ? { copyright } : {}) },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    const held = made.attributes?.copyright ?? copyright;
    version = { id: made.id, version: versionString, state: "PREPARE_FOR_SUBMISSION", releaseType: made.attributes?.releaseType ?? "MANUAL", copyright: held, buildId: null, build: null };
    console.log(`made App Store version ${versionString}${copyright ? ", copyright carried from the last version" : held ? ", copyright filled in by App Store Connect" : ""}`);
  } else if (plan.act === "rename") {
    await patch(`/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { versionString } } });
    console.log(`App Store version ${version.version} (${version.state}) is now ${versionString}`);
  } else {
    console.log(`App Store version ${versionString} is ${version.state}`);
  }
  versionNames.set(version.id, versionString);

  if (version.buildId === build.id) {
    console.log(`build ${number} is already attached`);
  } else {
    await patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: build.id } });
    wroteVersion = true;
    console.log(`build ${number} attached${version.build ? ` in place of build ${version.build}` : ""}`);
  }
  if (version.releaseType !== "MANUAL") {
    await patch(`/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { releaseType: "MANUAL" } } });
    wroteVersion = true;
    console.log(`release set to manual (was ${version.releaseType})`);
  }

  const locale = app.attributes.primaryLocale ?? "en-US";
  const { rows: localizations } = await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, {
    "fields[appStoreVersionLocalizations]": "locale,description,keywords,supportUrl,whatsNew",
    limit: "50",
  });
  let primary = localizations.find((row) => row.attributes.locale === locale);
  if (!versions.some((row) => SHIPPED_VERSION_STATES.has(row.state))) {
    console.log("What's New left out: the App Store shows it from the second version on");
  } else if (!primary) {
    wroteVersion = true;
    primary = await post("/v1/appStoreVersionLocalizations", {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale, whatsNew },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
      },
    });
    console.log(`What's New set for ${locale}`);
  } else if (primary.attributes.whatsNew === whatsNew) {
    console.log(`What's New for ${locale} already reads the notes`);
  } else {
    await patch(`/v1/appStoreVersionLocalizations/${primary.id}`, { data: { type: "appStoreVersionLocalizations", id: primary.id, attributes: { whatsNew } } });
    wroteVersion = true;
    console.log(`What's New set for ${locale}`);
  }

  const detail = await reviewDetail(version.id);
  const gaps = [...(await listingGaps(primary, locale, families)), ...reviewDetailGaps(detail)];
  if (!version.copyright?.trim()) gaps.push(`version ${versionString} copyright (mode=listing sets it from apps/phone/store/listing.json)`);
  if (gaps.length > 0) {
    refuse(`fill these in App Store Connect before version ${versionString} goes to App Review, then run this again:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  }
  if (!/chatgpt/i.test(detail.notes)) console.log("warning: the App Review notes don't say how to try Continue with ChatGPT, so App Review may ask");

  const expected = { id: version.id, version: versionString, states: new Set([version.state]), buildId: build.id, releaseType: "MANUAL" };
  if (wroteVersion) allowOwnWrite(expected);
  await requireVersionUnchanged(app.id, expected);
  const again = await openReviewSubmissions(app.id);
  if (submissionsFingerprint(again) !== submissionsFingerprint(submissions)) refuse("the review submissions changed while this ran; nothing was submitted, run this again");
  const pick = planSubmission(again, version.id, versionNames);
  if (pick.act === "refuse") refuse(pick.message);
  if (pick.act === "done") {
    console.log(`version ${versionString} is already in a review submission that is ${pick.submission.state}`);
    return;
  }
  let submission = pick.submission;
  if (pick.act === "create") {
    const made = await post("/v1/reviewSubmissions", {
      data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
    });
    submission = { id: made.id, state: made.attributes?.state ?? "READY_FOR_REVIEW", items: [] };
    console.log("opened a review submission");
  } else {
    console.log(`using the open review submission ${submission.id} (${submission.state})`);
  }
  if (submission.items.some((item) => item.versionId === version.id)) {
    console.log(`version ${versionString} is already in it`);
  } else {
    await post("/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
        },
      },
    });
    console.log(`version ${versionString} added to it`);
    allowOwnWrite(expected);
  }
  const onlyThisVersion = async () => {
    const items = await listSubmissionItems(submission.id);
    const strays = items.filter((item) => item.versionId !== version.id);
    if (strays.length > 0 || items.length === 0) {
      const listed = strays.map((item) => (item.versionId ? `version ${versionNames.get(item.versionId) ?? item.versionId}` : `item ${item.id}`)).join(", ");
      refuse(`review submission ${submission.id} now holds ${listed || "nothing"} besides version ${versionString}; nothing was submitted`);
    }
    return items;
  };
  for (const item of (await onlyThisVersion()).filter((row) => row.state === "REJECTED")) {
    await patch(`/v1/reviewSubmissionItems/${item.id}`, { data: { type: "reviewSubmissionItems", id: item.id, attributes: { resolved: true } } });
    console.log(`the rejected review item for version ${versionString} marked resolved`);
    allowOwnWrite(expected);
  }
  const held = await requireVersionUnchanged(app.id, expected);
  await onlyThisVersion();
  const sent = await patch(`/v1/reviewSubmissions/${submission.id}`, { data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } } });
  let reviewed;
  try {
    reviewed = (await listAppStoreVersions(app.id)).find((row) => row.id === version.id);
  } catch (error) {
    refuse(
      `review submission ${submission.id} was sent with version ${versionString}, submitted build ${number}, but this run couldn't confirm the build ` +
        `App Store Connect holds (${error instanceof Error ? error.message : String(error)}); check it there and cancel it in App Store Connect if it's wrong`,
    );
  }
  if (!reviewed) {
    refuse(
      `review submission ${submission.id} was sent with version ${versionString}, submitted build ${number}, but this run couldn't confirm the build: ` +
        "App Store Connect didn't list the version; check it there and cancel it in App Store Connect if it's wrong",
    );
  }
  if (reviewed.buildId !== build.id) {
    refuse(
      `review submission ${submission.id} was sent with version ${versionString}: submitted build ${number}, but App Store Connect shows build ` +
        `${reviewed.build ?? "none"}; cancel it in App Store Connect if that's wrong`,
    );
  }
  if (reviewed.releaseType !== held.releaseType) {
    refuse(
      `review submission ${submission.id} was sent with version ${versionString}, submitted build ${number}, but App Store Connect now shows the release as ` +
        `${reviewed.releaseType}, not ${held.releaseType}; set it back to Manual in App Store Connect before approval, or cancel the submission there`,
    );
  }
  console.log(
    `version ${versionString} (${number}) submitted for App Review: ${sent?.attributes?.state ?? "WAITING_FOR_REVIEW"}. ` +
      `The release is ${reviewed.releaseType}: press Release in App Store Connect once it is approved.`,
  );
}

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  } catch {
    return [];
  }
}

function counted(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function characters(text) {
  return [...text].length;
}

function pngFacts(bytes) {
  if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { problem: "no PNG signature" };
  let header = null;
  let transparency = false;
  let ended = false;
  const data = [];
  let at = 8;
  while (at < bytes.length && !ended) {
    if (at + 12 > bytes.length) return { problem: "a chunk is cut off" };
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const end = at + 12 + length;
    if (end > bytes.length) return { problem: `its ${type} chunk is cut off` };
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) return { problem: `its ${type} chunk fails its checksum` };
    if (header === null && type !== "IHDR") return { problem: "it doesn't start with IHDR" };
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) return { problem: "its IHDR is the wrong size" };
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], compression: body[10], filter: body[11], interlace: body[12] };
    } else if (type === "IDAT") data.push(body);
    else if (type === "tRNS") transparency = true;
    else if (type === "IEND") ended = true;
    at = end;
  }
  if (!header) return { problem: "it has no IHDR" };
  if (data.length === 0) return { problem: "it has no image data" };
  if (!ended) return { problem: "it has no IEND" };
  if (at !== bytes.length) return { problem: "it has bytes after IEND" };
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(header.colorType);
  if (!channels || ![1, 2, 4, 8, 16].includes(header.depth) || header.compression !== 0 || header.filter !== 0) return { problem: "its IHDR isn't a valid PNG header" };
  if (header.interlace !== 0) return { problem: "it's interlaced; save it without interlacing" };
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(data));
  } catch {
    return { problem: "its image data doesn't decompress" };
  }
  const rowBytes = Math.ceil((header.width * channels * header.depth) / 8);
  if (pixels.length !== header.height * (1 + rowBytes)) return { problem: "its image data doesn't fill the image" };
  for (let row = 0; row < header.height; row++) {
    const filter = pixels[row * (1 + rowBytes)];
    if (filter > 4) return { problem: `row ${row + 1} uses filter type ${filter}, which PNG doesn't define` };
  }
  return { width: header.width, height: header.height, alpha: header.colorType === 4 || header.colorType === 6 || transparency };
}

function httpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function ageRatingProblem(key, value) {
  const kind = AGE_RATING_ANSWERS.get(key);
  if (!kind) return `has an unknown answer ${key}`;
  if (kind === "boolean") return typeof value === "boolean" ? null : `.${key} must be true or false`;
  if (kind === "text") return typeof value === "string" && value.trim() ? null : `.${key} must be text`;
  if (kind === "url") return httpsUrl(value) ? null : `.${key} must be an https URL`;
  return kind.includes(value) ? null : `.${key} must be one of ${kind.join(", ")}`;
}

function listingProblems(listing, where) {
  if (typeof listing !== "object" || listing === null || Array.isArray(listing)) return [`${where} must hold one JSON object`];
  const problems = [];
  for (const key of Object.keys(listing)) if (!LISTING_KEYS.has(key)) problems.push(`${where} has an unknown key ${key}`);
  for (const [key, required] of [["supportUrl", true], ["privacyPolicyUrl", true], ["marketingUrl", false]]) {
    if (listing[key] === undefined && !required) continue;
    if (!httpsUrl(listing[key])) problems.push(`${where} ${key} must be an https URL`);
  }
  for (const [key, required] of [["primaryCategory", true], ["secondaryCategory", false]]) {
    if (listing[key] === undefined && !required) continue;
    if (typeof listing[key] !== "string" || !/^[A-Z][A-Z_]*$/.test(listing[key])) problems.push(`${where} ${key} must be an App Store category id such as UTILITIES`);
  }
  if (listing.primaryCategory && listing.primaryCategory === listing.secondaryCategory) problems.push(`${where} secondaryCategory repeats primaryCategory`);
  if (typeof listing.copyright !== "string" || !/^\d{4} \S/.test(listing.copyright) || listing.copyright.includes("©")) {
    problems.push(`${where} copyright must be the year and the holder, such as "2026 Example, Inc." (Apple adds the ©)`);
  }
  const rating = listing.ageRating;
  if (typeof rating !== "object" || rating === null || Array.isArray(rating) || Object.keys(rating).length === 0) {
    problems.push(`${where} ageRating must hold the age rating answers`);
  } else {
    for (const [key, value] of Object.entries(rating)) {
      const problem = ageRatingProblem(key, value);
      if (problem) problems.push(`${where} ageRating${problem.startsWith(".") ? problem : ` ${problem}`}`);
    }
  }
  if (!CONTENT_RIGHTS.has(listing.contentRights)) problems.push(`${where} contentRights must be ${[...CONTENT_RIGHTS].join(" or ")}`);
  if (listing.price !== "free") problems.push(`${where} price must be "free": listing sets no other price`);
  if (listing.availability !== "all") problems.push(`${where} availability must be "all": listing makes the app available in every territory`);
  if (listing.baseTerritory !== undefined && (typeof listing.baseTerritory !== "string" || !/^[A-Z]{3}$/.test(listing.baseTerritory))) {
    problems.push(`${where} baseTerritory must be a territory code such as USA`);
  }
  return problems;
}

function measured(text, unit) {
  return unit === "bytes" ? Buffer.byteLength(text, "utf8") : characters(text);
}

function readLocale(dir, locale, problems) {
  const text = {};
  for (const field of LISTING_TEXT) {
    const path = join(dir, field.file);
    const value = contents(path)?.trim();
    if (!value) {
      if (field.required) problems.push(`${shown(path)} is ${value === undefined ? "missing" : "empty"}`);
      continue;
    }
    const size = measured(value, field.unit);
    if (size > field.limit) problems.push(`${shown(path)} has ${size} ${field.unit}; ${field.rule} at most ${field.limit}`);
    text[field.field] = value;
  }
  const notesPath = join(dir, REVIEW_NOTES_FILE);
  const reviewNotes = contents(notesPath)?.trim() || null;
  const notesSize = reviewNotes ? measured(reviewNotes, REVIEW_NOTES.unit) : 0;
  if (notesSize > REVIEW_NOTES.limit) problems.push(`${shown(notesPath)} has ${notesSize} ${REVIEW_NOTES.unit}; ${REVIEW_NOTES.rule} at most ${REVIEW_NOTES.limit}`);
  return { locale, text, reviewNotes };
}
function readScreenshots(dir, kind, problems) {
  const files = [];
  const accepted = kind.sizes.map(([width, height]) => `${width}×${height}`).join(", ");
  for (const entry of entries(dir).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (!entry.isFile() || !/^\d{2}-[^/]+\.png$/.test(entry.name)) {
      problems.push(`${shown(path)} isn't a screenshot named NN-<name>.png`);
      continue;
    }
    const bytes = readFileSync(path);
    const facts = pngFacts(bytes);
    if (facts.problem) {
      problems.push(`${shown(path)} isn't a complete PNG: ${facts.problem}`);
      continue;
    }
    const fits = kind.sizes.some(([width, height]) => (facts.width === width && facts.height === height) || (facts.width === height && facts.height === width));
    if (!fits) problems.push(`${shown(path)} is ${facts.width}×${facts.height}; ${kind.label} takes ${accepted}, portrait or landscape`);
    else if (facts.alpha) problems.push(`${shown(path)} has an alpha channel or transparency, which App Store screenshots can't`);
    else files.push({ name: entry.name, bytes, size: bytes.length, checksum: createHash("md5").update(bytes).digest("hex") });
  }
  if (files.length > SCREENSHOTS_PER_SET) problems.push(`${shown(dir)} has ${files.length} screenshots; a set takes at most ${SCREENSHOTS_PER_SET}`);
  return files;
}

function reviewContact(problems) {
  const values = Object.fromEntries(REVIEW_CONTACT.map(([field, name]) => [field, process.env[name]?.trim() ?? ""]));
  const missing = REVIEW_CONTACT.filter(([field]) => !values[field]).map(([, name]) => name);
  if (values.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.contactEmail)) problems.push("ASC_REVIEW_CONTACT_EMAIL isn't an email address");
  if (values.contactPhone && !/^\+?[\d ()\-.]{6,}$/.test(values.contactPhone)) problems.push("ASC_REVIEW_CONTACT_PHONE isn't a phone number, such as +1 555 010 0100");
  return missing.length === 0 ? { values, missing } : { values: null, missing };
}

function readStore(storeDir) {
  const problems = [];
  const listingPath = join(storeDir, "listing.json");
  const raw = contents(listingPath);
  let listing = null;
  if (raw === null) problems.push(`${shown(listingPath)} is missing`);
  else {
    try {
      listing = JSON.parse(raw);
      problems.push(...listingProblems(listing, shown(listingPath)));
    } catch (error) {
      problems.push(`${shown(listingPath)} isn't JSON: ${error.message}`);
    }
  }
  const locales = entries(storeDir)
    .filter((entry) => entry.isDirectory() && LOCALE_DIR.test(entry.name))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readLocale(join(storeDir, entry.name), entry.name, problems));
  if (locales.length === 0) problems.push(`${shown(storeDir)} has no locale folder such as en-US`);
  else if (!locales.some((entry) => entry.reviewNotes)) problems.push(`${shown(storeDir)} has no ${REVIEW_NOTES_FILE} in any locale folder`);
  const before = problems.length;
  const screenshots = IPHONE_SCREENSHOT_CLASSES.map((kind) => ({ ...kind, files: readScreenshots(join(storeDir, "screenshots", kind.dir), kind, problems) }));
  if (!screenshots.some((kind) => kind.files.length > 0) && problems.length === before) {
    problems.push(`${shown(join(storeDir, "screenshots"))} has no iPhone screenshots: App Review needs ${DEVICE_FAMILIES.get("1").required}`);
  }
  return { listing, locales, screenshots, problems };
}

function given(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

function described(diff) {
  const set = Object.keys(given(diff));
  const cleared = Object.keys(diff).filter((key) => diff[key] === null);
  return [set.length > 0 ? `${set.join(", ")} updated` : "", cleared.length > 0 ? `${cleared.join(", ")} cleared` : ""].filter(Boolean).join("; ");
}

function differing(current, wanted) {
  const changed = Object.entries(wanted).filter(([key, value]) => (current?.[key] ?? null) !== (value ?? null));
  return changed.length > 0 ? Object.fromEntries(changed) : null;
}

async function optional(path, params) {
  try {
    return (await get(path, params)).rows[0] ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function planListingVersion(versions, versionString) {
  const same = versions.find((version) => version.version === versionString);
  if (same && !EDITABLE_VERSION_STATES.has(same.state) && !SHIPPED_VERSION_STATES.has(same.state)) {
    return { act: "refuse", message: `version ${versionString} is ${same.state}; its listing can't change until it leaves review` };
  }
  return planVersion(versions, versionString, null);
}

async function listingVersion(app, versionString, copyright, changed) {
  const plan = planListingVersion(await listAppStoreVersions(app.id), versionString);
  if (plan.act === "refuse") refuse(plan.message);
  if (plan.act === "create") {
    const made = await post("/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString, releaseType: "MANUAL", copyright },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    changed(`made App Store version ${versionString} with a manual release and its copyright`);
    return { id: made.id, version: versionString };
  }
  const attributes = {};
  if (plan.act === "rename") attributes.versionString = versionString;
  if (plan.version.copyright !== copyright) attributes.copyright = copyright;
  if (Object.keys(attributes).length === 0) console.log(`App Store version ${versionString} is ${plan.version.state}, its copyright already set`);
  else {
    await patch(`/v1/appStoreVersions/${plan.version.id}`, { data: { type: "appStoreVersions", id: plan.version.id, attributes } });
    if (attributes.versionString) changed(`App Store version ${plan.version.version} (${plan.version.state}) is now ${versionString}`);
    if (attributes.copyright) changed(`version ${versionString} copyright set`);
  }
  return { ...plan.version, version: versionString };
}

async function screenshotState(id) {
  const { rows } = await get(`/v1/appScreenshots/${id}`, { "fields[appScreenshots]": "fileName,assetDeliveryState" });
  return rows[0]?.attributes ?? {};
}

async function settleScreenshots(ids, deadline) {
  for (const id of ids) {
    for (;;) {
      const shot = await screenshotState(id);
      const delivery = shot.assetDeliveryState ?? {};
      if (delivery.state === "COMPLETE") break;
      if (delivery.state === "FAILED") {
        const reasons = (delivery.errors ?? []).map((error) => `${error.code ?? ""} ${error.description ?? ""}`.trim()).join("; ");
        refuse(`App Store Connect refused screenshot ${shot.fileName ?? id}: ${reasons || "no reason given"}; fix it and run listing again`);
      }
      if (Date.now() >= deadline) refuse(`screenshot ${shot.fileName ?? id} is still ${delivery.state ?? "processing"}; run listing again to finish`);
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_POLL_MS));
    }
  }
}

async function uploadScreenshot(setId, file) {
  const made = await post("/v1/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName: file.name, fileSize: file.size },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } },
    },
  });
  const operations = made.attributes?.uploadOperations ?? [];
  if (operations.length === 0) refuse(`App Store Connect gave no upload for ${file.name}`);
  for (const operation of operations) {
    if (!httpsUrl(operation.url)) refuse(`App Store Connect gave ${file.name} an upload address that isn't https`);
    const headers = Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value]));
    const response = await fetch(operation.url, { method: operation.method ?? "PUT", headers, body: file.bytes.subarray(operation.offset, operation.offset + operation.length) });
    if (!response.ok) refuse(`uploading ${file.name} failed with ${response.status}; run listing again`);
  }
  await patch(`/v1/appScreenshots/${made.id}`, { data: { type: "appScreenshots", id: made.id, attributes: { uploaded: true, sourceFileChecksum: file.checksum } } });
  return made.id;
}

const USABLE_SCREENSHOT_STATES = new Set(["COMPLETE", "UPLOAD_COMPLETE"]);

function planScreenshots(held, files) {
  const usable = held.filter((row) => USABLE_SCREENSHOT_STATES.has(row.state));
  const byChecksum = new Map();
  for (const row of usable.filter((candidate) => candidate.checksum)) byChecksum.set(row.checksum, [...(byChecksum.get(row.checksum) ?? []), row]);
  const slots = files.map((file) => ({ file, row: byChecksum.get(file.checksum)?.shift() ?? null }));
  const kept = new Set(slots.filter((slot) => slot.row).map((slot) => slot.row.id));
  return {
    slots,
    broken: held.filter((row) => !USABLE_SCREENSHOT_STATES.has(row.state)),
    unwanted: usable.filter((row) => !kept.has(row.id)),
  };
}

async function pushScreenshots(localizationId, classes, deadline, changed) {
  const { rows: sets, included } = await get(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`, {
    "fields[appScreenshotSets]": "screenshotDisplayType,appScreenshots",
    include: "appScreenshots",
    "fields[appScreenshots]": "fileName,sourceFileChecksum,assetDeliveryState",
    "limit[appScreenshots]": String(SCREENSHOTS_PER_SET),
    limit: "50",
  });
  const shots = new Map(included.filter((row) => row.type === "appScreenshots").map((row) => [row.id, row.attributes ?? {}]));
  const remove = (row) => send("DELETE", `/v1/appScreenshots/${row.id}`);
  for (const kind of classes) {
    if (kind.files.length === 0) {
      console.log(`no screenshots in screenshots/${kind.dir}, so ${kind.displayType} is left as it is`);
      continue;
    }
    let set = sets.find((row) => row.attributes?.screenshotDisplayType === kind.displayType);
    const held = (set?.relationships?.appScreenshots?.data ?? []).map((link) => ({
      id: link.id,
      checksum: shots.get(link.id)?.sourceFileChecksum ?? null,
      state: shots.get(link.id)?.assetDeliveryState?.state ?? null,
    }));
    const { slots, broken, unwanted } = planScreenshots(held, kind.files);
    const missing = slots.filter((slot) => !slot.row);
    if (!set) {
      set = await post("/v1/appScreenshotSets", {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: kind.displayType },
          relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localizationId } } },
        },
      });
    }
    for (const row of broken) await remove(row);
    await settleScreenshots(slots.filter((slot) => slot.row?.state === "UPLOAD_COMPLETE").map((slot) => slot.row.id), deadline);
    let count = held.length - broken.length;
    const spare = [...unwanted];
    let unsettled = [];
    for (const slot of missing) {
      if (count >= SCREENSHOTS_PER_SET) {
        await settleScreenshots(unsettled, deadline);
        unsettled = [];
        await remove(spare.shift());
        count--;
      }
      slot.id = await uploadScreenshot(set.id, slot.file);
      unsettled.push(slot.id);
      count++;
    }
    await settleScreenshots(unsettled, deadline);
    for (const row of spare) await remove(row);
    const order = slots.map((slot) => slot.row?.id ?? slot.id);
    const settledOrder = held.filter((row) => order.includes(row.id)).map((row) => row.id);
    const changedFiles = missing.length + broken.length + unwanted.length;
    if (changedFiles === 0 && settledOrder.join() === order.join()) {
      console.log(`${kind.displayType}: ${counted(order.length, "screenshot")} already ${order.length === 1 ? "matches" : "match"} screenshots/${kind.dir}`);
      continue;
    }
    await patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: order.map((id) => ({ type: "appScreenshots", id })) });
    if (changedFiles === 0) changed(`${kind.displayType}: screenshots put in the order of screenshots/${kind.dir}`);
    else {
      const kept = slots.length - missing.length;
      changed(
        `${kind.displayType}: ${counted(missing.length, "screenshot")} uploaded${kept > 0 ? `, ${kept} kept` : ""}` +
          `${broken.length + unwanted.length > 0 ? `, ${broken.length + unwanted.length} removed` : ""}, in the order of screenshots/${kind.dir}`,
      );
    }
  }
}

async function freePrice(app, baseTerritory, changed) {
  const schedule = await optional(`/v1/apps/${app.id}/appPriceSchedule`, { include: "baseTerritory", "fields[appPriceSchedules]": "baseTerritory" });
  if (schedule) {
    const { rows: prices, included } = await get(`/v1/appPriceSchedules/${schedule.id}/manualPrices`, {
      include: "appPricePoint",
      "fields[appPrices]": "startDate,endDate,appPricePoint",
      "fields[appPricePoints]": "customerPrice",
      limit: "200",
    });
    const today = new Date().toISOString().slice(0, 10);
    const current = prices.filter((row) => (!row.attributes?.startDate || row.attributes.startDate <= today) && (!row.attributes?.endDate || row.attributes.endDate > today));
    const customerPrice = (row) => included.find((point) => point.type === "appPricePoints" && point.id === row.relationships?.appPricePoint?.data?.id)?.attributes?.customerPrice;
    const free = current.length > 0 && current.every((row) => Number(customerPrice(row)) === 0);
    if (free && schedule.relationships?.baseTerritory?.data?.id === baseTerritory) {
      console.log(`the app is already free, priced from ${baseTerritory}`);
      return;
    }
  }
  const { rows: points } = await get(`/v1/apps/${app.id}/appPricePoints`, { "filter[territory]": baseTerritory, "fields[appPricePoints]": "customerPrice", limit: "200" });
  const zero = points.find((point) => point.attributes?.customerPrice !== undefined && Number(point.attributes.customerPrice) === 0);
  if (!zero) refuse(`App Store Connect lists no free price point for ${baseTerritory}`);
  await post("/v1/appPriceSchedules", {
    data: {
      type: "appPriceSchedules",
      relationships: {
        app: { data: { type: "apps", id: app.id } },
        baseTerritory: { data: { type: "territories", id: baseTerritory } },
        manualPrices: { data: [{ type: "appPrices", id: "${free}" }] },
      },
    },
    included: [{ type: "appPrices", id: "${free}", attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: "appPricePoints", id: zero.id } } } }],
  });
  changed(`price set to free, from ${baseTerritory}`);
}

async function everywhere(app, changed, byHand) {
  const { rows: territories } = await get("/v1/territories", { "fields[territories]": "currency", limit: "200" });
  const availability = await optional(`/v1/apps/${app.id}/appAvailabilityV2`, { "fields[appAvailabilities]": "availableInNewTerritories" });
  if (!availability) {
    await post("/v2/appAvailabilities", {
      data: {
        type: "appAvailabilities",
        attributes: { availableInNewTerritories: true },
        relationships: {
          app: { data: { type: "apps", id: app.id } },
          territoryAvailabilities: { data: territories.map((territory) => ({ type: "territoryAvailabilities", id: `\${${territory.id}}` })) },
        },
      },
      included: territories.map((territory) => ({
        type: "territoryAvailabilities",
        id: `\${${territory.id}}`,
        attributes: { available: true },
        relationships: { territory: { data: { type: "territories", id: territory.id } } },
      })),
    });
    changed(`available in all ${territories.length} territories, and in new ones as Apple adds them`);
    return;
  }
  const { rows: current } = await get(`/v2/appAvailabilities/${availability.id}/territoryAvailabilities`, {
    include: "territory",
    "fields[territoryAvailabilities]": "available,territory",
    limit: "200",
  });
  const off = current.filter((row) => row.attributes?.available !== true);
  for (const row of off) {
    await patch(`/v1/territoryAvailabilities/${row.id}`, { data: { type: "territoryAvailabilities", id: row.id, attributes: { available: true } } });
  }
  if (off.length > 0) changed(`made available in ${counted(off.length, "more territory", "more territories")}`);
  else console.log(`already available in every listed territory (${current.length})`);
  const listed = new Set(current.map((row) => row.relationships?.territory?.data?.id));
  const unlisted = territories.filter((territory) => !listed.has(territory.id));
  if (unlisted.length > 0) {
    byHand.push(`${counted(unlisted.length, "territory isn't", "territories aren't")} in the app's availability (${unlisted.map((territory) => territory.id).join(", ")}): add them in Pricing and Availability`);
  }
  if (availability.attributes?.availableInNewTerritories === false) byHand.push("turn on availability in new territories in Pricing and Availability: Apple's API has no way to change it");
}

async function withoutContactInErrors(what, write) {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const where = error.errors.map((entry) => [entry.code, entry.pointer].filter(Boolean).join(" at ")).filter(Boolean).join("; ");
    refuse(`App Store Connect refused ${what} with ${error.status}${where ? ` (${where})` : ""}; its message is left out because it can repeat the App Review contact`);
  }
}

async function listing(args) {
  const storeDir = option(args, "--store") ?? STORE_DIR;
  const iosDir = option(args, "--ios-dir") ?? IOS_DIR;
  const timeout = Number(option(args, "--timeout") ?? 600);
  if (!Number.isFinite(timeout) || timeout < 0) {
    console.error("asc: --timeout takes seconds");
    process.exit(64);
  }
  const store = readStore(storeDir);
  const contact = reviewContact(store.problems);
  const versionString = pinnedVersion(iosDir);
  store.problems.push(...pinProblems(iosDir));
  const asked = option(args, "--version");
  if (asked !== undefined && versionString && asked !== versionString) {
    store.problems.push(`--version ${asked} isn't the pinned iPhone version ${versionString} (apps/phone/ios/${RELEASE_VERSION_FILE}); change the pin in a commit instead`);
  }
  const families = targetedFamilies(iosDir);
  if (!families) {
    store.problems.push(`${shown(projectPath(iosDir))} gives ${BUNDLE_PREFIX}'s Release build no TARGETED_DEVICE_FAMILY, so the screenshots it needs are unknown`);
  } else if (families.some((family) => family.name !== "iPhone")) {
    store.problems.push(`${shown(projectPath(iosDir))} targets ${families.map((family) => family.name).join(" and ")}; listing pushes only iPhone screenshots`);
  }
  if (store.problems.length > 0) refuse(`the listing in ${shown(storeDir)} isn't ready, so nothing was sent:\n${store.problems.map((problem) => `- ${problem}`).join("\n")}`);
  const counts = store.screenshots.map((kind) => `${kind.files.length} ${kind.displayType}`).join(", ");
  console.log(`listing checked: version ${versionString}, ${store.locales.map((entry) => entry.locale).join(", ")}, screenshots ${counts}`);
  if (args.includes("--check")) return;

  const deadline = Date.now() + timeout * 1000;
  const changes = [];
  const changed = (what) => {
    changes.push(what);
    console.log(what);
  };
  const byHand = ["App Privacy: answer the data collection questions in App Store Connect › App Privacy (Apple's API has no endpoint for them)"];
  const { listing: wanted } = store;
  const app = await requireApp();
  const primaryLocale = app.attributes.primaryLocale ?? "en-US";
  const primary = store.locales.find((entry) => entry.locale === primaryLocale);
  if (!primary) refuse(`the app's primary language is ${primaryLocale}, and ${shown(storeDir)} has no ${primaryLocale} folder; nothing was sent`);
  if (!primary.reviewNotes) refuse(`${shown(join(storeDir, primaryLocale, REVIEW_NOTES_FILE))} is missing; App Review reads the primary language's notes`);

  const version = await listingVersion(app, versionString, wanted.copyright, changed);

  const { rows: localizations } = await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, {
    "fields[appStoreVersionLocalizations]": "locale,description,keywords,promotionalText,supportUrl,marketingUrl",
    limit: "50",
  });
  const localizationIds = new Map();
  for (const entry of store.locales) {
    const text = {
      description: entry.text.description,
      keywords: entry.text.keywords,
      supportUrl: wanted.supportUrl,
      promotionalText: entry.text.promotionalText ?? null,
      marketingUrl: wanted.marketingUrl ?? null,
    };
    const row = localizations.find((candidate) => candidate.attributes?.locale === entry.locale);
    if (!row) {
      const made = await post("/v1/appStoreVersionLocalizations", {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: { locale: entry.locale, ...given(text) },
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } },
        },
      });
      localizationIds.set(entry.locale, made.id);
      changed(`${entry.locale}: ${Object.keys(given(text)).join(", ")} set`);
      continue;
    }
    localizationIds.set(entry.locale, row.id);
    const diff = differing(row.attributes, text);
    if (!diff) console.log(`${entry.locale}: the version's text already matches`);
    else {
      await patch(`/v1/appStoreVersionLocalizations/${row.id}`, { data: { type: "appStoreVersionLocalizations", id: row.id, attributes: diff } });
      changed(`${entry.locale}: ${described(diff)}`);
    }
  }

  const { rows: infos } = await get(`/v1/apps/${app.id}/appInfos`, {
    "fields[appInfos]": "state,appStoreState,primaryCategory,secondaryCategory",
    include: "primaryCategory,secondaryCategory",
    limit: "10",
  });
  const info = infos.find((row) => EDITABLE_APP_INFO_STATES.has(row.attributes?.state ?? row.attributes?.appStoreState));
  if (!info) refuse(`no app information can be edited (${infos.map((row) => row.attributes?.state ?? row.attributes?.appStoreState ?? "?").join(", ") || "none"}); run listing again once version ${versionString} has its own`);

  const { rows: infoLocalizations } = await get(`/v1/appInfos/${info.id}/appInfoLocalizations`, {
    "fields[appInfoLocalizations]": "locale,name,subtitle,privacyPolicyUrl",
    limit: "50",
  });
  for (const entry of store.locales) {
    const text = { privacyPolicyUrl: wanted.privacyPolicyUrl, subtitle: entry.text.subtitle ?? null };
    const row = infoLocalizations.find((candidate) => candidate.attributes?.locale === entry.locale);
    if (!row) {
      await post("/v1/appInfoLocalizations", {
        data: {
          type: "appInfoLocalizations",
          attributes: { locale: entry.locale, name: app.attributes.name, ...given(text) },
          relationships: { appInfo: { data: { type: "appInfos", id: info.id } } },
        },
      });
      changed(`${entry.locale}: ${Object.keys(given(text)).join(", ")} set in the app information`);
      continue;
    }
    const diff = differing(row.attributes, text);
    if (!diff) console.log(`${entry.locale}: the app information already matches`);
    else {
      await patch(`/v1/appInfoLocalizations/${row.id}`, { data: { type: "appInfoLocalizations", id: row.id, attributes: diff } });
      changed(`${entry.locale}: ${described(diff)} in the app information`);
    }
  }

  const categories = { primaryCategory: wanted.primaryCategory, ...(wanted.secondaryCategory ? { secondaryCategory: wanted.secondaryCategory } : {}) };
  const heldCategories = Object.fromEntries(Object.keys(categories).map((key) => [key, info.relationships?.[key]?.data?.id ?? null]));
  const categoryDiff = differing(heldCategories, categories);
  if (!categoryDiff) console.log(`categories already ${Object.values(categories).join(" and ")}`);
  else {
    const relationships = Object.fromEntries(Object.entries(categoryDiff).map(([key, id]) => [key, { data: { type: "appCategories", id } }]));
    await patch(`/v1/appInfos/${info.id}`, { data: { type: "appInfos", id: info.id, relationships } });
    changed(`categories set: ${Object.entries(categoryDiff).map(([key, id]) => `${key} ${id}`).join(", ")}`);
  }

  const declaration = await optional(`/v1/appInfos/${info.id}/ageRatingDeclaration`, {});
  if (!declaration) refuse("App Store Connect gives the app information no age rating declaration; answer it once in App Store Connect and run listing again");
  const ratingDiff = differing(declaration.attributes, wanted.ageRating);
  if (!ratingDiff) console.log("the age rating answers already match");
  else {
    await patch(`/v1/ageRatingDeclarations/${declaration.id}`, { data: { type: "ageRatingDeclarations", id: declaration.id, attributes: ratingDiff } });
    changed(`age rating answers updated: ${Object.keys(ratingDiff).join(", ")}`);
  }

  if (app.attributes.contentRightsDeclaration === wanted.contentRights) console.log(`content rights already ${wanted.contentRights}`);
  else {
    await patch(`/v1/apps/${app.id}`, { data: { type: "apps", id: app.id, attributes: { contentRightsDeclaration: wanted.contentRights } } });
    changed(`content rights set to ${wanted.contentRights}`);
  }

  await freePrice(app, wanted.baseTerritory ?? "USA", changed);
  await everywhere(app, changed, byHand);

  const review = await optional(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, {
    "fields[appStoreReviewDetails]": "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired,notes",
  });
  const reviewWanted = { notes: primary.reviewNotes, demoAccountRequired: false, ...(contact.values ?? {}) };
  if (!contact.values) {
    console.log(`App Review contact skipped: ${contact.missing.join(", ")} ${contact.missing.length === 1 ? "is" : "are"} unset`);
    byHand.push(`App Review contact: set ${contact.missing.join(", ")} as GitHub secrets and run mode=listing again, or fill it in App Store Connect`);
  }
  const shownFields = (fields) => Object.keys(fields).map((key) => (key.startsWith("contact") ? "contact" : key)).filter((key, at, all) => all.indexOf(key) === at).join(", ");
  if (!review) {
    await withoutContactInErrors("the App Review information", () =>
      post("/v1/appStoreReviewDetails", {
        data: { type: "appStoreReviewDetails", attributes: reviewWanted, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } },
      }),
    );
    changed(`App Review information set: ${shownFields(reviewWanted)}`);
  } else {
    const diff = differing(review.attributes, reviewWanted);
    if (!diff) console.log("the App Review information already matches");
    else {
      await withoutContactInErrors("the App Review information", () =>
        patch(`/v1/appStoreReviewDetails/${review.id}`, { data: { type: "appStoreReviewDetails", id: review.id, attributes: diff } }),
      );
      changed(`App Review information updated: ${shownFields(diff)}`);
    }
  }

  await pushScreenshots(localizationIds.get(primaryLocale), store.screenshots, deadline, changed);

  console.log(changes.length === 0 ? `\nthe listing for ${versionString} already matched the repo; nothing was written` : `\nthe listing for ${versionString} is up to date: ${counted(changes.length, "change")}`);
  console.log(`still by hand in App Store Connect:\n${byHand.map((item) => `- ${item}`).join("\n")}`);
}

async function registerDevice(args) {
  const udid = option(args, "--udid");
  if (!udid) {
    console.error("asc: register-device needs --udid");
    process.exit(64);
  }
  const { rows } = await get("/v1/devices", { "filter[udid]": udid, "fields[devices]": "status,udid", limit: "200" });
  const known = rows.find((row) => row.attributes.udid === udid);
  if (known) {
    console.log(`the iPhone is already registered (${known.attributes.status})`);
    return;
  }
  await post("/v1/devices", { data: { type: "devices", attributes: { name: option(args, "--name") ?? "iPhone", udid, platform: "IOS" } } });
  console.log("registered the iPhone");
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  status,
  builds,
  wait,
  certificates,
  "next-build": nextBuild,
  "public-link": publicLink,
  "add-tester": addTester,
  "register-device": registerDevice,
  expire,
  "app-store": appStore,
  listing,
  preflight,
  version,
};
if (!command || command === "-h" || command === "--help" || !commands[command]) {
  console.log(HELP);
  process.exit(command && commands[command] === undefined && command !== "-h" && command !== "--help" ? 64 : 0);
}
try {
  await commands[command](args);
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  console.error(`asc: App Store Connect answered ${error.message}`);
  if (command === "app-store" && error.status === 403) {
    console.error("asc: submitting for App Review needs a key with the App Manager role (docs/phone.md › The App Store)");
  }
  if (command === "listing" && error.status === 403) {
    console.error("asc: editing the App Store listing needs a key with the App Manager role (docs/phone.md › The App Store)");
  }
  process.exit(1);
}
