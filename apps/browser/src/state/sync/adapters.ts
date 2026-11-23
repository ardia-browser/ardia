import { deletePassword } from "../../platform/passwords";
import { orWarn } from "../../lib/fallback";
import { assignPositions, folderChildren, SyncNative, type Adapter, type SealedLogin } from "../../platform/sync";
import { bookmarkRoots, bookmarkUuidFor, ensureRoots, isBookmarkUuid } from "../bookmarks/bookmarks";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import { profileOpened } from "../profiles/profileLoading";
import { isPeekTab } from "../peek/peek";
import { fromSync } from "../pins/pinOrderChoices";
import { fromLegacy } from "../../lib/legacy";
import { thisDeviceDetails } from "./deviceDetails";
import type { BookmarkNode } from "../browser/types";
import { isWebPageUrl } from "../../lib/url";
import { BOOKMARK, DEVICE, DEVICE_TABS, RECEIVES_TABS, SHARE, bookmarkValue, passwordValue, recordId, type BookmarkValue, type DeviceRecord, type DeviceTabs, type PasswordValue, type ShareRecord } from "./records";
import { isAsleep } from "../tabs/pageSession";
import { withSyncWorkCounts } from "../telemetry/workCounts";

const store = () => useBrowser.getState();

export const inTodaysNames = (adapter: Adapter): Adapter => ({
  ...adapter,
  apply: (visible, changed, base, records) =>
    adapter.apply(new Map([...visible].map(([key, value]) => [key, fromLegacy(value)])), changed, (key) => fromLegacy(base(key)), records),
});

type ShareLink = { syncId: string; enabled: boolean; retire?: boolean };

export function sharedDataAdapter(links: () => Record<string, ShareLink>, removed: () => ReadonlySet<string> = () => new Set()): Adapter {
  return {
    prefix: SHARE,
    adoptRemoteOnJoin: true,
    publishAfterPull: true,
    extract: (_base, _queued, _now, known, remote) => {
      const all = links();
      const synced = (id: string) => !!store().profiles[id] && !!all[id]?.enabled && !all[id]?.retire;
      const values = new Map<string, unknown>();
      for (const [id, link] of Object.entries(all)) {
        const ownerId = store().profiles[id]?.dataId;
        if (!synced(id) || !ownerId || ownerId === id || !all[ownerId] || !store().profiles[ownerId]) continue;
        const key = `${SHARE}${link.syncId}`;
        const removedElsewhere = known(key) && remote(key) === null;
        if (removedElsewhere || !known(key)) values.set(key, { o: all[ownerId]!.syncId } satisfies ShareRecord);
      }
      const gone = removed();
      return { values, ignore: (key) => !values.has(key) && !gone.has(key) };
    },
    apply: () => true,
  };
}

export function deviceAdapter(deviceId: string, name: () => string, retired = false, spaceOrder: () => string[] = () => []): Adapter {
  const recordOf = (order: string[]): DeviceRecord => ({ n: name(), k: "mac", f: [RECEIVES_TABS], ...thisDeviceDetails(), ...(order.length ? { o: order } : {}) });
  return {
    prefix: DEVICE,
    extract: () => ({
      values: retired ? new Map() : new Map([[`${DEVICE}${deviceId}`, recordOf(spaceOrder())]]),
      ignore: (key) => key !== `${DEVICE}${deviceId}`,
    }),
    apply: () => true,
  };
}

const bookmarkTokens = new WeakMap<BrowserState["bookmarks"], Map<string, object>>();

function bookmarksToken(profileId: string): object {
  const s = store();
  const engine = engineProfile(s, profileId);
  const key = `${profileId}\n${engine}\n${s.bookmarksReady[engine] ? 1 : 0}`;
  let byKey = bookmarkTokens.get(s.bookmarks);
  if (!byKey) bookmarkTokens.set(s.bookmarks, (byKey = new Map()));
  let token = byKey.get(key);
  if (!token) byKey.set(key, (token = {}));
  return token;
}

export function bookmarksAdapter(profileId: string): Adapter {
  const ready = () => !!store().bookmarksReady[engineProfile(store(), profileId)];
  return withSyncWorkCounts("bookmark", {
    prefix: BOOKMARK,
    extractsOnlyFrom: () => bookmarksToken(profileId),
    extract: (base) => {
      if (!ready()) return null;
      const b = store().bookmarks;
      const roots = bookmarkRoots(store(), profileId);
      const values = new Map<string, unknown>();
      if (!roots) return { values };
      const keyOf = (id: string) => {
        if (id === roots.bar) return "bar";
        if (id === roots.other) return "other";
        const key = b.nodes[id]?.syncKey;
        return key && bookmarkUuidFor(key) === id ? key : id;
      };
      const seen = new Set<string>();
      const open = (folderId: string) => {
        const folder = b.nodes[folderId];
        if (folder?.kind !== "folder" || seen.has(folderId)) return null;
        seen.add(folderId);
        const parent = keyOf(folderId);
        const children = folder.children.filter((id) => b.nodes[id]);
        const positions = assignPositions(
          children.map((id) => {
            const known = bookmarkValue(base(`${BOOKMARK}${keyOf(id)}`));
            return known?.p === parent ? known.pos : undefined;
          }),
        );
        return { parent, children, positions, next: 0 };
      };
      for (const root of [roots.bar, roots.other]) {
        const first = open(root);
        const stack = first ? [first] : [];
        while (stack.length) {
          const top = stack.at(-1)!;
          if (top.next === top.children.length) {
            stack.pop();
            continue;
          }
          const i = top.next++;
          const id = top.children[i]!;
          const node = b.nodes[id]!;
          values.set(`${BOOKMARK}${keyOf(id)}`, {
            k: node.kind === "url" ? "u" : "f",
            p: top.parent,
            t: node.title,
            ...(node.kind === "url" ? { u: node.url } : {}),
            a: node.addedAt,
            pos: top.positions[i]!,
          } satisfies BookmarkValue);
          const inner = node.kind === "folder" ? open(id) : null;
          if (inner) stack.push(inner);
        }
      }
      return { values };
    },
    apply: (visible) => {
      if (!ready()) return false;
      const s = store();
      const [b, roots] = ensureRoots(s.bookmarks, engineProfile(s, profileId));
      const decoded = [...visible].map(([k, v]) => [k, bookmarkValue(v)] as const);
      if (decoded.some(([, v]) => !v)) return false;
      const values = new Map(decoded.map(([k, v]) => [bookmarkUuidFor(recordId(BOOKMARK, k)), v!]));
      const keys = new Map([...visible.keys()].map((k) => [bookmarkUuidFor(recordId(BOOKMARK, k)), recordId(BOOKMARK, k)]));
      const rootOf = (key: string) => (key === "bar" ? roots.bar : key === "other" ? roots.other : null);
      const parentOf = new Map<string, string>();
      for (const [id, v] of values) {
        const root = rootOf(v.p);
        const parent = root ? null : bookmarkUuidFor(v.p);
        parentOf.set(id, root ?? (parent && values.get(parent)?.k === "f" ? parent : roots.other));
      }
      const children = folderChildren(parentOf, [...values.keys()].sort(), roots.other);
      for (const root of [roots.bar, roots.other]) if (!children.has(root)) children.set(root, []);
      const byPosition = (a: string, z: string) => {
        const pa = values.get(a)!.pos;
        const pz = values.get(z)!.pos;
        const ka = keys.get(a)!;
        const kz = keys.get(z)!;
        return pa < pz ? -1 : pa > pz ? 1 : ka < kz ? -1 : 1;
      };
      const nodes: Record<string, BookmarkNode> = { ...b.nodes };
      const dropping = [roots.bar, roots.other];
      while (dropping.length) {
        const id = dropping.pop()!;
        const node = nodes[id];
        if (node?.kind === "folder") for (const child of node.children) dropping.push(child);
        if (id !== roots.bar && id !== roots.other) delete nodes[id];
      }
      for (const [id, v] of values) {
        const old = b.nodes[id];
        const key = keys.get(id)!;
        const syncKey = isBookmarkUuid(key) ? {} : { syncKey: key };
        nodes[id] =
          v.k === "u"
            ? { kind: "url", id, parentId: parentOf.get(id)!, title: v.t, url: v.u ?? "", favicon: old?.kind === "url" ? old.favicon : null, addedAt: v.a, ...syncKey }
            : { kind: "folder", id, parentId: parentOf.get(id)!, title: v.t, children: [], addedAt: v.a, ...syncKey };
      }
      for (const [parent, ids] of children) {
        const folder = nodes[parent];
        if (folder?.kind === "folder") nodes[parent] = { ...folder, children: ids.sort(byPosition) };
      }
      useBrowser.setState({ bookmarks: { ...b, nodes } });
    },
  });
}

const MAX_DEVICE_TABS = 30;

export function deviceTabsAdapter(profileId: string, deviceId: string, name: () => string, retired = false): Adapter {
  const key = `${DEVICE_TABS}${deviceId}`;
  return {
    prefix: DEVICE_TABS,
    extract: () => {
      if (retired) return { values: new Map(), ignore: (k) => k !== key };
      const s = store();
      const open = Object.values(s.tabs)
        .filter((t) => t.profileId === profileId && !t.pin && !isAsleep(t) && isWebPageUrl(t.url) && s.windows[t.windowId]?.kind !== "private" && !isPeekTab(s, t.id))
        .sort((a, z) => z.lastActiveAt - a.lastActiveAt)
        .slice(0, MAX_DEVICE_TABS)
        .map((t) => ({ u: t.url, t: t.customTitle || t.title }));
      return { values: new Map([[key, { n: name(), tabs: open } satisfies DeviceTabs]]), ignore: (k) => k !== key };
    },
    apply: () => true,
  };
}

const PASSWORD_READ_INTERVAL = 30_000;

export type SealedPasswords = {
  read: (engineProfile: string) => Promise<SealedLogin[] | null | undefined>;
  save: (engineProfile: string, origin: string, username: string, sealed: string, replacing: boolean) => Promise<boolean>;
};

const nativePasswords: SealedPasswords = {
  read: async (p) => SyncNative?.readPasswords(p),
  save: async (p, origin, username, sealed, replacing) => !!(await SyncNative?.savePassword(p, origin, username, sealed, replacing)),
};

export function passwordsAdapter(profileId: string, logins: SealedPasswords = nativePasswords): (forced: boolean) => Adapter {
  let lastRead = 0;
  let quietUntil = 0;
  let created = new Map<string, number>();
  const profile = () => engineProfile(useBrowser.getState(), profileId);
  const keyOf = (origin: string, username: string) => `pws:${origin}\n${username}`;
  let passwordless = new Set<string>();
  const read = async () => {
    if (!profileOpened(profile())) return null;
    const list = await logins.read(profile());
    if (!list) return null;
    passwordless = new Set(list.filter((l) => l.passwordless).map((l) => keyOf(l.origin, l.username)));
    return new Map(list.flatMap((l) => (l.sealed === undefined ? [] : [[keyOf(l.origin, l.username), { o: l.origin, u: l.username, s: l.sealed, c: l.created }] as const])));
  };
  return (forced) => ({
    prefix: "pws:",
    extract: async () => {
      const now = Date.now();
      if (now < quietUntil || (now - lastRead < PASSWORD_READ_INTERVAL && !forced)) return null;
      const local = await read();
      if (!local) return null;
      lastRead = now;
      created = new Map([...local].map(([k, v]) => [k, v.c]));
      const blank = new Set(passwordless);
      return { values: new Map([...local].map(([k, { o, u, s }]) => [k, { o, u, s } satisfies PasswordValue])), ignore: (k) => blank.has(k) };
    },
    editedAt: (v) => {
      const value = passwordValue(v);
      return (value && created.get(keyOf(value.o, value.u))) || undefined;
    },
    apply: async (visible, changed, base, records) => {
      const local = await read();
      if (!local) return false;
      let ok = true;
      for (const key of changed) {
        if (records.held()) return false;
        if (passwordless.has(key)) {
          records.defer(key);
          continue;
        }
        const v = passwordValue(visible.get(key));
        if (visible.has(key) && !v) return false;
        const have = local.get(key);
        const known = passwordValue(base(key));
        if (have && known?.s !== have.s) continue;
        if (v) {
          if (have?.s === v.s) continue;
          const saved = await logins.save(profile(), v.o, v.u, v.s, !!have).catch(orWarn(false));
          if (saved) records.landed(key);
          ok = saved && ok;
        } else if (have) {
          const deleted = await deletePassword(profile(), have.o, have.u).catch(orWarn(false, "sync delete"));
          if (deleted) records.landed(key);
          ok = deleted && ok;
        }
      }
      const landed = (now: Map<string, { s: string }>, key: string) => {
        if (!visible.has(key)) return !now.has(key);
        const v = passwordValue(visible.get(key));
        return !v || v.s === now.get(key)?.s;
      };
      let settled = false;
      for (let i = 0; i < 20 && !settled; i++) {
        if (records.held()) return false;
        const now = await read();
        settled = !!now && [...changed].every((k) => passwordless.has(k) || landed(now, k));
        if (!settled) await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) quietUntil = Date.now() + 30_000;
      return ok;
    },
  });
}
