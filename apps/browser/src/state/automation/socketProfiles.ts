import { boundFolders } from "../sharedFolders/store";
import { SHARED_GROUPS_SIDEBAR_ONLY } from "./workspaceSharedGuard";
import type { BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { deleteProfile } from "../browser/actions";
import { sanitizeTheme, startingTheme } from "../../lib/profileLook";
import { choosePresetColor, setProfileTheme } from "../profiles/themeActions";
import type { ProfileColor } from "../browser/types";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { setOpenTabsSynced } from "../sync/engine";
import { bool, id, ids, obj, oneOf, PROFILE, text } from "./socketSchema";
import { expect, now, profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { askWhereSeen, shownWindowId } from "./socketAsk";
import { t } from "../../lib/uiLanguage";


const COLORS = ["plum", "blue", "purple", "pink", "red", "orange", "yellow", "green", "neutral"] as const;

export function profileRow(s: BrowserState, id: string) {
  const p = s.profiles[id]!;
  return {
    id,
    name: p.name,
    color: p.color,
    icon: p.icon,
    theme: p.theme ?? null,
    default: s.settings.defaultProfileId === id,
    sharesDataWith: s.profileOrder.filter((other) => other !== id && engineProfile(s, other) === engineProfile(s, id)),
    shareTopApps: !!p.shareTopApps,
    syncTabs: !!p.syncTabs,
    pinnedCollapsed: !!p.pinnedCollapsed,
    createdAt: p.createdAt,
  };
}

const listProfiles = () => {
  const s = now();
  return s.profileOrder.filter((id) => s.profiles[id] && !isIncognitoProfile(id)).map((id) => profileRow(s, id));
};

const isName = (name: unknown) => typeof name === "string" && !!name.trim() && name.length <= 200;

function createProfile(params: Record<string, unknown>) {
  if (!isName(params.name)) throw new OpError("bad_request", t(`name is 1 to 200 characters.`));
  const shareWith = params.shareDataWith !== undefined ? profileArg(params.shareDataWith) : undefined;
  const id = now().createProfile({ name: (params.name as string).trim(), color: params.color as ProfileColor | undefined, icon: (params.icon as string | undefined) ?? null, shareWith, shareTopApps: params.shareTopApps as boolean | undefined });
  expect(!!id && !!now().profiles[id], t(`the profile wasn't made.`));
  return profileRow(now(), id);
}

function updateProfile(params: Record<string, unknown>) {
  const id = profileArg(params.profile);
  if (params.name !== undefined && !isName(params.name)) throw new OpError("bad_request", t(`name is 1 to 200 characters.`));
  const patch = {
    ...(params.name !== undefined ? { name: (params.name as string).trim() } : {}),
    ...(params.icon !== undefined ? { icon: params.icon as string | null } : {}),
    ...(params.pinnedCollapsed !== undefined ? { pinnedCollapsed: params.pinnedCollapsed as boolean } : {}),
    ...(params.shareTopApps !== undefined ? { shareTopApps: params.shareTopApps ? (true as const) : undefined } : {}),
  };
  if (!Object.keys(patch).length && params.syncTabs === undefined) throw new OpError("bad_request", t(`profiles.update needs name, icon, pinnedCollapsed, shareTopApps or syncTabs.`));
  if (Object.keys(patch).length) now().updateProfile(id, patch);
  if (params.syncTabs !== undefined && !!now().profiles[id]!.syncTabs !== params.syncTabs) setOpenTabsSynced(id, params.syncTabs as boolean);
  return profileRow(now(), id);
}

function setLook(params: Record<string, unknown>) {
  const id = profileArg(params.profile);
  let theme: ReturnType<typeof sanitizeTheme> | undefined;
  if (params.theme === null) theme = null;
  else if (typeof params.theme === "string") {
    if (!/^#[0-9a-fA-F]{6}$/.test(params.theme)) throw new OpError("bad_request", t(`theme is a #rrggbb colour, a theme object, or null.`));
    theme = startingTheme(params.theme);
  } else if (params.theme !== undefined) {
    theme = sanitizeTheme(params.theme);
    if (!theme) throw new OpError("bad_request", t(`That theme object isn't one Ardia reads (profiles.list shows the shape).`));
  }
  if (params.color === undefined && theme === undefined) throw new OpError("bad_request", t(`profiles.setLook needs color or theme.`));
  const leaveSync = () => {};
  if (params.color !== undefined) choosePresetColor(id, params.color as ProfileColor, leaveSync);
  if (theme !== undefined) setProfileTheme(id, theme, leaveSync);
  return profileRow(now(), id);
}

function reorder(params: Record<string, unknown>) {
  const s = now();
  const given = params.profiles as string[];
  const own = s.profileOrder.filter((p) => !isIncognitoProfile(p));
  if (given.length !== own.length || !own.every((p) => given.includes(p))) throw new OpError("bad_request", `profiles lists every profile once: ${own.join(", ")}.`);
  now().reorderProfiles(given);
  return listProfiles();
}

async function remove(params: Record<string, unknown>, call: SocketCall) {
  const id = profileArg(params.profile);
  if (now().profileOrder.length <= 1) throw new OpError("refused", t(`That's the only profile.`));
  if (boundFolders().some((b) => b.profileId === id)) throw new OpError("refused", `Profile ${id} has groups synced to shared folders; ${SHARED_GROUPS_SIDEBAR_ONLY}, so it can be deleted only from the sidebar.`);
  const mayDelete = () => call.serving() && !boundFolders().some((b) => b.profileId === id);
  await deleteProfile(id, shownWindowId(), mayDelete, askWhereSeen(`Profile ${id} wasn't deleted`, call));
  const deleted = !now().profiles[id];
  if (!deleted) call.stillServing();
  return { deleted };
}

export const PROFILE_METHODS: MethodSpec[] = [
  { name: "profiles.list", mutates: false, description: t(`Profiles (spaces) in sidebar order, with their look and what they share`), params: obj({}), result: "[profile]", run: listProfiles },
  {
    name: "profiles.create",
    mutates: true,
    description: t(`Make a profile (space)`),
    params: obj({ name: text(t(`Its name`)), color: oneOf(COLORS, t(`Its colour`)), icon: text(t(`An emoji`)), shareDataWith: id(t(`A profile whose cookies, history and extensions it shares`)), shareTopApps: bool(t(`Share Top Apps with the default profile`)) }, ["name"]),
    result: "profile",
    run: createProfile,
  },
  {
    name: "profiles.update",
    mutates: true,
    description: t(`Rename a profile or change its icon and switches`),
    params: obj({ profile: PROFILE, name: text(t(`Its name`)), icon: { type: ["string", "null"], description: t(`An emoji, or null for none`) }, pinnedCollapsed: bool(t(`Fold its pinned area`)), shareTopApps: bool(t(`Share Top Apps`)), syncTabs: bool(t(`Sync its open tabs`)) }, ["profile"]),
    result: "profile",
    run: updateProfile,
  },
  {
    name: "profiles.setLook",
    mutates: true,
    description: t(`Change a profile's colour and theme`),
    params: obj({ profile: PROFILE, color: oneOf(COLORS, t(`Its theme colour; switching brings back the edits you made to that colour`)), theme: { type: ["string", "object", "null"], description: t(`An edit of the theme colour: a #rrggbb to start one from, a theme object as profiles.list shows, or null to reset the colour to its original`) } }, ["profile"]),
    result: "profile",
    run: setLook,
  },
  { name: "profiles.reorder", mutates: true, description: t(`Put the profiles in this order`), params: obj({ profiles: ids(t(`Every profile id, in the new order`), 200) }, ["profiles"]), result: "[profile]", run: reorder },
  {
    name: "profiles.setDefault",
    mutates: true,
    description: t(`Make a profile the one new windows and links open in`),
    params: obj({ profile: PROFILE }, ["profile"]),
    result: "profile",
    run: (p) => {
      const id = profileArg(p.profile);
      now().setDefaultProfile(id);
      expect(now().settings.defaultProfileId === id, t(`the default didn't change.`));
      return profileRow(now(), id);
    },
  },
  {
    name: "profiles.delete",
    mutates: true,
    description: t(`Delete a profile and its data; Ardia asks the user to confirm first`),
    params: obj({ profile: PROFILE }, ["profile"]),
    result: "{deleted}",
    run: remove,
  },
];
