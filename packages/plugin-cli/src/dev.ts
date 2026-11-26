import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildProject, watchProject, type BuildFlags, type BuildReport } from "./build";
import { checkProject } from "./check";
import { CliError, type Output } from "./output";
import { loadProject, type Project } from "./project";
import { CLI_VERSION } from "./version";

export type DevFlags = BuildFlags & { dataDir?: string; configDir?: string; once?: boolean; tail?: boolean; env?: Env; signal?: AbortSignal };

export type DevPaths = { dataDir: string; configDir: string; socket: string; link: string; logs: string[] };

export type DevLink = { v: 1; id: string; path: string; manifest: "plugin.json"; version: string; linkedAt: string; pid: number; cli: string };

type ReloadOutcome = { ok: true; reached: boolean; reason?: undefined; message?: undefined } | { ok: false; reached?: undefined; reason: "build" | "check" | "refused"; message?: string };

export type DevSession = { paths: DevPaths; stop(): Promise<void>; done: Promise<void> };

export type Env = Readonly<Record<string, string | undefined>>;

export function defaultDataDir(env: Env = {}, platform = process.platform, home = homedir()): string {
  if (env.ARDIA_DATA_DIR) return resolve(env.ARDIA_DATA_DIR);
  if (platform === "darwin") return join(home, "Library", "Application Support", "Ardia");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Ardia", "User Data");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Ardia");
}

export function devPaths(project: Project, flags: DevFlags, env: Env = flags.env ?? {}, platform = process.platform, home = homedir()): DevPaths {
  const explicitData = flags.dataDir ?? env.ARDIA_DATA_DIR;
  const dataDir = explicitData ? resolve(explicitData) : defaultDataDir(env, platform, home);
  const configDir = flags.configDir
    ? resolve(flags.configDir)
    : explicitData
      ? join(dataDir, "config")
      : platform === "win32"
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "ardia")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "ardia");
  const linkName = `${project.scope}__${project.name}`;
  return {
    dataDir,
    configDir,
    socket: join(dataDir, "ArdiaControl.sock"),
    link: join(configDir, "plugins-dev", `${linkName}.json`),
    logs: [join(dataDir, "PluginData", linkName, "plugin.log"), join(dataDir, "PluginData", project.name, "plugin.log")],
  };
}

export function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function writeDevLink(project: Project, paths: DevPaths): DevLink {
  const link: DevLink = { v: 1, id: project.manifest.id, path: canonicalDir(project.dir), manifest: "plugin.json", version: project.manifest.version, linkedAt: new Date().toISOString(), pid: process.pid, cli: CLI_VERSION };
  mkdirSync(join(paths.configDir, "plugins-dev"), { recursive: true });
  const partial = `${paths.link}.partial-${process.pid}`;
  writeFileSync(partial, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, paths.link);
  return link;
}

export function removeDevLink(paths: DevPaths): boolean {
  try {
    const current = JSON.parse(readFileSync(paths.link, "utf8")) as Partial<DevLink>;
    if (current.pid !== process.pid) return false;
    rmSync(paths.link, { force: true });
    return true;
  } catch {
    return false;
  }
}

function refusalReason(error: unknown): string {
  if (error && typeof error === "object") {
    const { message, code } = error as { message?: unknown; code?: unknown };
    if (typeof message === "string" && message.trim()) return message;
    if (typeof code === "string" && code.trim()) return code;
  }
  if (typeof error === "string" && error.trim()) return error;
  return "Ardia refused the reload";
}

function reloadReplyError(reply: unknown): string | undefined {
  if (!reply || typeof reply !== "object") return "Ardia answered with something unexpected";
  const record = reply as { ok?: unknown; error?: unknown; result?: unknown };
  if (record.error !== undefined && record.error !== null && record.error !== false) return refusalReason(record.error);
  if (record.ok === false) return "Ardia refused the reload";
  if (record.result && typeof record.result === "object") {
    const result = record.result as { ok?: unknown; error?: unknown; message?: unknown };
    if (result.error !== undefined && result.error !== null && result.error !== false) return refusalReason(result.error);
    if (result.ok === false) return typeof result.message === "string" && result.message.trim() ? result.message : "Ardia refused the reload";
  }
  return undefined;
}

export function pingArdia(socketPath: string, params: Record<string, unknown>, timeoutMs = 1500): Promise<{ reached: boolean; reply?: unknown; error?: string }> {
  if (process.platform === "win32" || !existsSync(socketPath)) return Promise.resolve({ reached: false, error: "Ardia's control socket isn't there" });
  return new Promise((done) => {
    const socket = connect(socketPath);
    let buffer = "";
    const finish = (result: { reached: boolean; reply?: unknown; error?: string }) => {
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(() => finish({ reached: false, error: "Ardia didn't answer in time" }), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method: "plugins.devReload", params })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { result?: unknown };
        const error = reloadReplyError(reply);
        finish(error !== undefined ? { reached: true, error } : { reached: true, reply: reply.result });
      } catch {
        finish({ reached: true, error: "Ardia answered with something that isn't JSON" });
      }
    });
    socket.on("error", (error) => finish({ reached: false, error: error.message }));
  });
}

function tailLogs(paths: readonly string[], write: (text: string) => void, intervalMs = 400): () => void {
  let active: string | null = null;
  let offset = 0;
  const poll = () => {
    const path = active ?? paths.find((p) => existsSync(p)) ?? null;
    if (!path) return;
    if (active !== path) {
      active = path;
      offset = statSync(path).size;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      active = null;
      return;
    }
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      write(buffer.subarray(0, read).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return () => clearInterval(timer);
}

function describeBuild(report: BuildReport): string {
  if (!report.ok) return `build failed:\n${report.errors.map((e) => `  ${e}`).join("\n")}`;
  return report.outputs.length ? `built ${report.outputs.map((o) => o.entry).join(", ")}` : "nothing to build";
}

export async function runDev(dir: string | undefined, out: Output, flags: DevFlags = {}): Promise<DevSession> {
  const project = loadProject(dir);
  const paths = devPaths(project, flags);
  const signal = flags.signal;
  let warnedUnreachable = false;
  const reload = async (report: BuildReport): Promise<ReloadOutcome> => {
    out.info(`[${new Date().toLocaleTimeString()}] ${describeBuild(report)}`);
    if (!report.ok) return { ok: false, reason: "build" };
    const check = checkProject(project, { built: true });
    if (!check.ok) {
      out.warn(`not reloading ${project.manifest.id}: plugin.json or its files have ${check.problems.length} problem${check.problems.length === 1 ? "" : "s"}`);
      for (const problem of check.problems) out.warn(`  ${problem}`);
      return { ok: false, reason: "check" };
    }
    const ping = await pingArdia(paths.socket, { id: project.manifest.id, path: canonicalDir(project.dir), link: paths.link });
    if (ping.reached && ping.error === undefined) out.info(`reloaded ${project.manifest.id} in Ardia`);
    else if (ping.reached) {
      const reason = ping.error || "Ardia refused the reload";
      out.warn(`Ardia didn't reload the plugin: ${reason}`);
      return { ok: false, reason: "refused", message: reason };
    }
    else if (!warnedUnreachable) {
      warnedUnreachable = true;
      out.info(`Ardia isn't reachable at ${paths.socket}; it picks the link up when it starts (turn on Settings › Advanced › Let programs control Ardia to reload on save)`);
    }
    return { ok: true, reached: ping.reached };
  };
  const finished = (): DevSession => ({ paths, stop: async () => undefined, done: Promise.resolve() });
  if (signal?.aborted) return finished();
  writeDevLink(project, paths);
  out.info(`linked ${project.manifest.id} → ${paths.link}`);
  if (flags.once) {
    const interrupted = () => new CliError(`Stopped before ${project.manifest.id} was reloaded; the dev link is removed`, [], 130);
    let report: BuildReport;
    let outcome: ReloadOutcome;
    try {
      report = await buildProject(project, flags);
      if (signal?.aborted) throw interrupted();
      outcome = await reload(report);
      if (signal?.aborted) throw interrupted();
      if (!report.ok) throw new CliError("The build failed, so the dev link is removed", report.errors);
      if (!outcome.ok && outcome.reason === "refused") throw new CliError(`Ardia refused to reload ${project.manifest.id}, so the dev link is removed`, [outcome.message ?? ""]);
      if (!outcome.ok) throw new CliError(`${project.manifest.id} has problems, so Ardia wasn't asked to reload it and the dev link is removed`, checkProject(project, { built: true }).problems);
    } catch (error) {
      if (removeDevLink(paths)) out.info(`unlinked ${project.manifest.id}`);
      throw error;
    }
    out.result(`linked ${project.manifest.id} at ${paths.link}: ${describeBuild(report)}`, { id: project.manifest.id, link: paths.link, socket: paths.socket, reloaded: outcome.reached === true, build: report });
    return finished();
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let reloading = Promise.resolve();
  let watcher: { dispose(): Promise<void> };
  try {
    watcher = await watchProject(project, flags, (report) => {
      reloading = reloading.then(() => reload(report).then(() => undefined, (error: unknown) => out.warn(String(error))));
    });
  } catch (error) {
    removeDevLink(paths);
    throw error;
  }
  const stopTail = flags.tail === false ? () => undefined : tailLogs(paths.logs, (text) => process.stdout.write(text));
  out.info("watching for changes; press Ctrl+C to stop");
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      stopTail();
      try {
        await watcher.dispose();
        await reloading;
      } finally {
        if (removeDevLink(paths)) out.info(`unlinked ${project.manifest.id}`);
        finish();
      }
    })());
  if (signal?.aborted) await stop();
  else signal?.addEventListener("abort", () => void stop(), { once: true });
  return { paths, stop, done };
}
