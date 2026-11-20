import { webStoreExtensionId } from "@ardia/core";
import { errorText } from "../../lib/errors";
import { engineProfile } from "../browser/model";
import { configureThenRead, freshExtensions, openInExtensionProfile } from "../extensions/actions";
import type { InstalledExtension } from "../extensions/store";
import { ownEntry } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import type { JsonSchema } from "../../lib/jsonSchema";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { now, profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const SITE_ACCESS = ["allSites", "specificSites", "onClick"] as const;
type SiteAccess = (typeof SITE_ACCESS)[number];
const SITE_ACCESS_STATE: Record<SiteAccess, string> = { allSites: "ON_ALL_SITES", specificSites: "ON_SPECIFIC_SITES", onClick: "ON_CLICK" };

const engineOf = (params: Record<string, unknown>) => engineProfile(now(), profileArg(params.profile));

function stillThere(call: SocketCall, profileId: string, engine: string) {
  call.stillServing();
  if (!ownEntry(now().profiles, profileId) || engineProfile(now(), profileId) !== engine) throw new OpError("no_window", `Profile ${profileId} closed before Ardia made the change, so nothing changed.`);
}

export const NO_FOLDER_INSTALLS = "installing an unpacked folder from the socket isn't supported; use Settings › Extensions › Load Unpacked";

async function install(params: Record<string, unknown>, call: SocketCall) {
  if (params.folder !== undefined) throw new OpError("refused", NO_FOLDER_INSTALLS);
  if (params.webStore === undefined) throw new OpError("bad_request", "extensions.install takes webStore, a Chrome Web Store link or extension id.");
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const extensionId = webStoreExtensionId(params.webStore as string);
  if (!extensionId) throw new OpError("bad_request", "webStore is a Chrome Web Store link or extension id.");
  const already = (await loaded(engine)).find((x) => x.id === extensionId);
  stillThere(call, profileId, engine);
  if (already) return { waiting: false, installed: true, extensions: [{ id: already.id, name: already.name, version: already.version }] };
  openInExtensionProfile(`https://chromewebstore.google.com/detail/${extensionId}`, engine, { profileId });
  return { waiting: true, id: extensionId };
}

type Change = { siteAccess: SiteAccess } | { incognito: boolean } | { userScripts: boolean };

function requestedChange(params: Record<string, unknown>): Change {
  if (params.siteAccess !== undefined) return { siteAccess: params.siteAccess as SiteAccess };
  if (params.incognito !== undefined) return { incognito: params.incognito as boolean };
  return { userScripts: params.userScripts as boolean };
}

export const SPECIFIC_SITES_REFUSED = "changing to specific sites needs engine support";

function checkedChange(ext: InstalledExtension, change: Change) {
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
  if ("siteAccess" in change && !ext.siteAccess) throw new OpError("refused", `${ext.name} asks for no site access, so there's nothing to choose.`);
  if ("siteAccess" in change && change.siteAccess === "specificSites") throw new OpError("refused", SPECIFIC_SITES_REFUSED);
  if ("userScripts" in change && !ext.userScriptsAvailable) throw new OpError("refused", `${ext.name} doesn't use user scripts.`);
  if (!("incognito" in change)) return;
  if (typeof ext.incognitoAllowed !== "boolean") throw new OpError("refused", `Ardia can't confirm incognito eligibility for ${ext.name}, so Allow in Incognito stays as it is.`);
  if (ext.path) throw new OpError("refused", `Allow in Incognito for ${ext.name}, an unpacked extension, needs engine support: Chromium doesn't report whether the loaded copy may run there.`);
  if (change.incognito && !ext.incognitoAllowed) throw new OpError("refused", `${ext.name} says it can't run in Incognito, so Allow in Incognito can't turn on.`);
}

async function loaded(engine: string): Promise<InstalledExtension[]> {
  try {
    return await freshExtensions(engine);
  } catch (error) {
    throw new OpError("failed", `Ardia couldn't read the profile's extensions from Chromium: ${errorText(error)}`);
  }
}

function expectation(change: Change): (after: InstalledExtension) => boolean {
  if ("incognito" in change) return (after) => after.incognito === change.incognito;
  if ("userScripts" in change) return (after) => !!after.userScripts === change.userScripts;
  const state = SITE_ACCESS_STATE[change.siteAccess];
  return (after) => after.siteAccess === state;
}

async function configureExtension(params: Record<string, unknown>, call: SocketCall) {
  const change = requestedChange(params);
  const expected = expectation(change);
  const profileId = profileArg(params.profile);
  const engine = engineOf(params);
  const ext = (await loaded(engine)).find((x) => x.id === params.id);
  if (!ext) throw new OpError("no_window", `There's no extension ${String(params.id)} in that profile.`);
  checkedChange(ext, change);
  stillThere(call, profileId, engine);
  const what = Object.keys(change)[0];
  let list: InstalledExtension[] | null;
  try {
    list = await configureThenRead(engine, ext.id, change);
  } catch (error) {
    throw new OpError("failed", `Ardia couldn't read the profile's extensions from Chromium after the change: ${errorText(error)}`);
  }
  if (!list) throw new OpError("failed", `Ardia didn't do that: Chromium refused ${ext.name}'s ${what} change, so nothing changed.`);
  const after = list.find((x) => x.id === ext.id);
  if (!after) throw new OpError("failed", `Ardia didn't do that: ${ext.name} wasn't in the profile's extensions when Ardia read them back after the change.`);
  if (!expected(after)) throw new OpError("failed", `Ardia didn't do that: Chromium didn't leave ${ext.name}'s ${what} as asked (${after.siteAccess ?? "no site access"}, ${(after.sites ?? []).join(", ") || "no sites"}, incognito ${after.incognito}).`);
  return { id: after.id, name: after.name, incognito: after.incognito, userScripts: !!after.userScripts, siteAccess: after.siteAccess ?? null, sites: after.sites ?? [] };
}

const EXTENSION_ID = id("An extension id from extensions.list");
const SITE_ACCESS_PARAM = oneOf(SITE_ACCESS, "Which sites it can read and change: allSites or onClick; specificSites is refused until the engine can grant sites");
const CONFIGURE_PARAMS: JsonSchema = {
  ...obj({ profile: PROFILE, id: EXTENSION_ID, siteAccess: SITE_ACCESS_PARAM, incognito: bool("Allow in Incognito"), userScripts: bool("Allow User Scripts") }, ["id"]),
  anyOf: [
    obj({ profile: PROFILE, id: EXTENSION_ID, siteAccess: SITE_ACCESS_PARAM }, ["id", "siteAccess"]),
    obj({ profile: PROFILE, id: EXTENSION_ID, incognito: bool("Allow in Incognito") }, ["id", "incognito"]),
    obj({ profile: PROFILE, id: EXTENSION_ID, userScripts: bool("Allow User Scripts") }, ["id", "userScripts"]),
  ],
};

export const EXTENSION_METHODS: MethodSpec[] = [
  {
    name: "extensions.install",
    mutates: true,
    description:
      "Add an extension from the Chrome Web Store, as Settings › Profiles › Extensions does: opens its store page, where the user adds it ({waiting}), or answers {installed} when it's already there. An unpacked folder is refused; Settings › Extensions › Load Unpacked adds one",
    params: obj({ profile: PROFILE, webStore: text("A Chrome Web Store link or extension id"), folder: text("Refused: unpacked folders install from Settings only") }),
    result: "{waiting, id} | {installed, extensions}",
    run: install,
  },
  {
    name: "extensions.configure",
    mutates: true,
    description:
      "Change exactly one of an extension's settings per call, as its page in Settings does: site access (allSites or onClick; specificSites is refused), Allow in Incognito or Allow User Scripts; a request with none or more than one fails validation",
    params: CONFIGURE_PARAMS,
    result: "{id, name, incognito, userScripts, siteAccess, sites}",
    run: configureExtension,
  },
];
