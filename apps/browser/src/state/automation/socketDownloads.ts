import { engineProfile } from "../browser/model";
import { cancelDownload, keepDownload, pauseDownload, resumeDownload, setDownloadSettings, type Download } from "../downloads/actions";
import { downloadSession } from "../downloads/downloadsSlice";
import { openDownload } from "../downloads/openDownload";
import { inDownloadTurn } from "../downloads/downloadTurns";
import { awaitsKeep } from "../downloads/status";
import { getDownloadSettings } from "../../platform/downloads";
import { revealFile } from "../../platform/files";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PAGE, PROFILE, text } from "./socketSchema";
import { expect, now, page, profileArg } from "./socketTargets";
import { useDownloadProgress, withProgress } from "../downloads/progress";
import { OpError } from "./workspaceTargets";
import { backgroundInstance } from "../app/appSettings";
import { isAbsoluteFolder } from "../../lib/absoluteFolder";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

const STATES = ["downloading", "finished", "failed", "cancelled"] as const;

const downloadRow = (d: Download) => ({
  id: d.id,
  url: d.url,
  filename: d.filename,
  path: d.path,
  state: d.state,
  paused: d.paused,
  dangerous: !!d.dangerous,
  awaitsKeep: awaitsKeep(d),
  received: d.received,
  total: d.total,
  speed: d.speed,
  mimeType: d.mimeType,
  profile: d.profile ?? "",
  startTime: d.startTime ?? null,
});

const ownDownloads = () => {
  const s = now();
  return s.downloads.filter((d) => downloadSession(s, d) === null);
};

function downloadOf(value: unknown): Download {
  const d = ownDownloads().find((x) => x.id === value);
  if (!d) throw new OpError("no_window", `There's no download ${String(value)}.`);
  return d;
}

function list(params: Record<string, unknown>) {
  const engine = params.profile !== undefined ? engineProfile(now(), profileArg(params.profile)) : null;
  const live = useDownloadProgress.getState();
  const rows = ownDownloads().filter((d) => (engine === null || (d.profile ?? "") === engine) && (params.state === undefined || d.state === params.state));
  return page(rows, params, (d) => downloadRow(withProgress(d, Object.hasOwn(live, d.id) ? live[d.id] : undefined)));
}

const engineCall = (verb: (id: string) => Promise<unknown>, when: (d: Download) => string | null) => async (params: Record<string, unknown>) => {
  const d = downloadOf(params.id);
  const problem = when(d);
  if (problem) throw new OpError("refused", problem);
  await verb(d.id);
  return { ok: true };
};

const inProgress = (d: Download) => (d.state === "downloading" ? null : `Download ${d.id} is ${d.state}.`);

async function openOrReveal(params: Record<string, unknown>, reveal: boolean, call: SocketCall) {
  const d = downloadOf(params.id);
  if (d.state !== "finished") throw new OpError("refused", `Download ${d.id} is ${d.state}, so there's no file yet.`);
  if (backgroundInstance) {
    throw new OpError("refused", reveal ? `Download ${d.id} wasn't shown: revealing a download needs the person, and this Ardia runs in the background.` : `Download ${d.id} wasn't opened: opening a download needs the person, and this Ardia runs in the background.`);
  }
  const done = await (reveal ? revealFile(d.path) : openDownload(d.path, undefined, call.serving));
  expect(done, `${reveal ? "revealing" : "opening"} ${d.filename} failed (the file may be gone).`);
  return { ok: true };
}

function remove(params: Record<string, unknown>) {
  const d = downloadOf(params.id);
  if (d.state === "downloading") throw new OpError("refused", `Download ${d.id} is still downloading; cancel it first.`);
  now().removeDownload(d.id);
  return { ok: true };
}

function clear() {
  const before = ownDownloads().length;
  const s = now();
  for (const d of s.downloads) if (downloadSession(s, d) === null && d.state !== "downloading") now().removeDownload(d.id);
  return { removed: before - ownDownloads().length };
}

async function settings(params: Record<string, unknown>) {
  const id = profileArg(params.profile);
  return inDownloadTurn(async () => getDownloadSettings(engineProfile(now(), profileArg(id))));
}

async function setSettings(params: Record<string, unknown>, call: SocketCall) {
  if (params.folder === undefined && params.askWhereToSave === undefined) throw new OpError("bad_request", "downloads.setSettings needs folder or askWhereToSave.");
  if (params.folder !== undefined && !isAbsoluteFolder(params.folder as string)) throw new OpError("bad_request", "folder is an absolute path.");
  const id = profileArg(params.profile);
  return inDownloadTurn(async () => {
    const engine = engineProfile(now(), profileArg(id));
    const current = await getDownloadSettings(engine);
    if (current.managed) throw new OpError("refused", "A policy sets this profile's download settings.");
    call.stillServing();
    profileArg(id);
    return setDownloadSettings({ ...(params.folder !== undefined ? { folder: params.folder as string } : {}), ...(params.askWhereToSave !== undefined ? { askWhereToSave: params.askWhereToSave as boolean } : {}) }, engine);
  });
}

const DOWNLOAD = obj({ id: id("A download id from downloads.list") }, ["id"]);

export const DOWNLOAD_METHODS: MethodSpec[] = [
  { name: "downloads.list", mutates: false, description: "Downloads, newest first, with progress and where the file is", params: obj({ profile: PROFILE, state: oneOf(STATES, "Only downloads in this state"), ...PAGE }), result: "{items: [download], total, nextOffset}", run: list },
  { name: "downloads.pause", mutates: true, description: "Pause a download", params: DOWNLOAD, result: "{ok}", run: engineCall(pauseDownload, (d) => inProgress(d) ?? (d.paused ? `Download ${d.id} is already paused.` : null)) },
  { name: "downloads.resume", mutates: true, description: "Resume a paused download", params: DOWNLOAD, result: "{ok}", run: engineCall(resumeDownload, (d) => inProgress(d) ?? (d.paused ? null : `Download ${d.id} isn't paused.`)) },
  { name: "downloads.cancel", mutates: true, description: "Cancel a download", params: DOWNLOAD, result: "{ok}", run: engineCall(cancelDownload, inProgress) },
  { name: "downloads.keep", mutates: true, description: "Keep a download Ardia held as dangerous", params: DOWNLOAD, result: "{ok}", run: engineCall(keepDownload, (d) => (awaitsKeep(d) ? null : `Download ${d.id} isn't waiting to be kept.`)) },
  { name: "downloads.open", mutates: true, description: "Open a finished download with its app", params: DOWNLOAD, result: "{ok}", run: (p, call) => openOrReveal(p, false, call) },
  { name: "downloads.reveal", mutates: true, description: `Show a finished download in ${PLATFORM_TERMS.fileManager}`, params: DOWNLOAD, result: "{ok}", run: (p, call) => openOrReveal(p, true, call) },
  { name: "downloads.remove", mutates: true, description: "Remove a download from the list (the file stays)", params: DOWNLOAD, result: "{ok}", run: remove },
  { name: "downloads.clear", mutates: true, description: "Remove every download that isn't running from the list", params: obj({}), result: "{removed}", run: clear },
  { name: "downloads.settings", mutates: false, description: "Where a profile saves downloads and whether it asks", params: obj({ profile: PROFILE }), result: "{folder, askWhereToSave, managed}", run: settings },
  { name: "downloads.setSettings", mutates: true, description: "Change where a profile saves downloads and whether it asks", params: obj({ profile: PROFILE, folder: text("An absolute folder path"), askWhereToSave: bool("Ask where to save each file") }), result: "{folder, askWhereToSave, managed}", run: setSettings },
];
