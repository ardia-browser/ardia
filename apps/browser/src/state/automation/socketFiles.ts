import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { armFiles, DEFAULT_ARM_SECONDS, disarm, listArms, MAX_ARM_SECONDS, MAX_ARMS, MAX_PATH_BYTES, MAX_UPLOAD_PATHS } from "./fileArms";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, ids, int, obj, TAB } from "./socketSchema";
import { tabOf } from "./socketTargets";

const PATH = { type: "string", description: `An absolute path on this Mac, at most ${MAX_PATH_BYTES} bytes` } as const;
const ONCE = bool("Answer only the next one (default true); false keeps answering until the time runs out or files.disarm");
const SECONDS = int(`How long the arm waits, in seconds (default ${DEFAULT_ARM_SECONDS}, at most ${MAX_ARM_SECONDS})`, 1, MAX_ARM_SECONDS);
const ARMS = ids("Arm ids from files.armUpload or files.armDownload", MAX_ARMS * 4);

const armOptions = (params: Record<string, unknown>) => ({
  once: (params.once as boolean | undefined) ?? true,
  seconds: (params.seconds as number | undefined) ?? DEFAULT_ARM_SECONDS,
});

function armUpload(params: Record<string, unknown>, call: SocketCall) {
  const tab = tabOf(params.tab);
  return armFiles({ kind: "upload", tab: tab.id, profileId: tab.profileId, paths: params.paths as string[], ...armOptions(params) }, call);
}

function armDownload(params: Record<string, unknown>, call: SocketCall) {
  const tab = params.tab !== undefined ? tabOf(params.tab) : null;
  return armFiles({ kind: "download", tab: tab?.id ?? null, profileId: tab?.profileId ?? null, paths: [params.path as string], ...armOptions(params) }, call);
}

const ARM_RESULT = "{arm, kind, tab, paths | path, folder?, once, state, reason?, armedAt, expiresAt, answered, chosen?, downloads?}";

export const FILE_METHODS: MethodSpec[] = [
  {
    name: "files.armUpload",
    mutates: true,
    description: "Answer the next file chooser opened in this tab's window with these files, without showing a panel or taking focus; one waiting upload arm per window",
    params: obj(
      {
        tab: TAB,
        paths: { type: "array", items: PATH, minItems: 1, maxItems: MAX_UPLOAD_PATHS, description: "Regular files to choose (Ardia hands the page its own copy of each); more than one only for a chooser that takes several" },
        once: ONCE,
        seconds: SECONDS,
      },
      ["tab", "paths"],
    ),
    result: ARM_RESULT,
    run: armUpload,
    get hidden() {
      return !PLATFORM_FEATURES.silentFilePanels;
    },
  },
  {
    name: "files.armDownload",
    mutates: true,
    description: "Save the next download to this path without asking where, and report its id, path, size and state in files.arms",
    params: obj(
      {
        tab: id("Only a download started in this tab's profile; the next download in any regular profile when left out"),
        path: { ...PATH, description: "A file that doesn't exist yet, in a folder that does; or an existing folder, where each download keeps its own name" },
        once: ONCE,
        seconds: SECONDS,
      },
      ["path"],
    ),
    result: ARM_RESULT,
    run: armDownload,
    get hidden() {
      return !PLATFORM_FEATURES.silentFilePanels;
    },
  },
  {
    name: "files.arms",
    mutates: false,
    description: "Armed uploads and downloads from the last ten minutes and how each went: the files chosen, and each download's id, path, bytes and state",
    params: obj({ arms: ARMS }),
    result: `{items: [${ARM_RESULT}]}`,
    run: (params) => listArms((params.arms as string[] | undefined) ?? null),
    get hidden() {
      return !PLATFORM_FEATURES.silentFilePanels;
    },
  },
  {
    name: "files.disarm",
    mutates: true,
    description: "Stop armed uploads and downloads before they answer",
    params: obj({ arms: { ...ARMS, description: "These arms; every waiting arm when left out" } }),
    result: "{cleared}",
    run: (params) => disarm((params.arms as string[] | undefined) ?? null),
    get hidden() {
      return !PLATFORM_FEATURES.silentFilePanels;
    },
  },
];
