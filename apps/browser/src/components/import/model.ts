import type {
  BrowserProfile,
  BrowserSource,
  DiaTabsResult,
  ImportedExtension,
  ImportKind,
  ImportResult,
  SpaceSummary,
} from "../../state/import/apply";
import { IMPORT_KINDS } from "../../state/import/flow";
import { t } from "../../lib/uiLanguage";


export type { BrowserProfile, BrowserSource, DiaTabsResult, ImportedExtension, ImportKind, ImportResult, SpaceSummary };

export const APP = t(`Ardia`);

const KIND_LOOK: Record<ImportKind, { title: string; icon: string }> = {
  bookmarks: { title: t(`Bookmarks`), icon: "bookmark" },
  history: { title: t(`History`), icon: "clock" },
  passwords: { title: t(`Passwords`), icon: "key" },
  cookies: { title: t(`Cookies (stay signed in)`), icon: "person.badge.key" },
  autofill: { title: t(`Addresses and cards`), icon: "creditcard" },
  tabs: { title: t(`Tabs`), icon: "square.on.square" },
  spaces: { title: t(`Spaces`), icon: "square.stack" },
  pinnedTabs: { title: t(`Pinned tabs`), icon: "pin" },
  favorites: { title: t(`Favorites`), icon: "star" },
  linkRules: { title: t(`Air Traffic Control`), icon: "airplane" },
  archive: { title: t(`Archived tabs`), icon: "archivebox" },
};
export const KINDS: { kind: ImportKind; title: string; icon: string }[] = IMPORT_KINDS.map((kind) => ({ kind, ...KIND_LOOK[kind] }));
export const kindTitle = (k: ImportKind) => KIND_LOOK[k].title;

const DIA_NOT_SHARED = t(`Custom tab names, colours, spaces and folders stay in Dia: its AppleScript doesn't share them.`);
const DIA_ASKED = `${APP} asks Dia for its open and pinned tabs, opening it in the background if it isn't running.`;
const DIA_READ = `${APP} reads Dia's sidebar from its own files, without opening Dia: spaces, folders, groups, split views and renamed tabs come over as they are.`;

export function diaTabsNote(profiles: BrowserProfile[]): string {
  const files = profiles.filter((p) => p.diaSidebar).length;
  if (!files) return `${DIA_ASKED} ${DIA_NOT_SHARED}`;
  if (files === profiles.length) return DIA_READ;
  return `${DIA_READ} For a profile last opened in an older Dia, ${APP} asks Dia for its open and pinned tabs instead.`;
}
