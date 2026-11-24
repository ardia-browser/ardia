import { at, DEFAULT_MAIN_MB, DEFAULT_SIDECAR_MB, flag, integer, isArgument, isPluginPath, LIMITS, matching, NAME, NAME_RULE, object, only, pluginFile, text, type Check } from "./pluginChecks";

export type ProcessSpec = { run: string[]; memoryMB: number };
export type MainSpec = { entry: string; memoryMB: number };
export type ProgramSpec = { name: string; path: string; afterUpdate: string[][]; example: string | null; claim: boolean };

export function sidecarOf(c: Check, path: string, value: unknown): ProcessSpec | null {
  if (value === undefined) return null;
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["run", "memoryMB"]);
  const run = doc.run;
  const okArgs = Array.isArray(run) && run.length > 0 && run.length <= LIMITS.argv && run.every(isArgument);
  if (!okArgs) {
    c.problems.push(`${path}.run must be a list of 1 to ${LIMITS.argv} arguments, the program first`);
    return null;
  }
  const program = run[0] as string;
  if (!program.startsWith("/") && program.includes("/") && !isPluginPath(program)) c.problems.push(`${path}.run[0] must be a file in the plugin's folder, an absolute path or a program name`);
  const memoryMB = integer(c, `${path}.memoryMB`, doc.memoryMB, LIMITS.memoryMB, DEFAULT_SIDECAR_MB);
  return { run: run as string[], memoryMB };
}

export function mainOf(c: Check, entry: unknown, memory: unknown): MainSpec | null {
  if (entry === undefined) {
    if (memory !== undefined) c.problems.push("memoryMB only goes with main");
    return null;
  }
  const file = pluginFile(c, "main", entry, "a JavaScript file inside the plugin's folder, like dist/index.js", undefined);
  if (file && !/\.(m?js|cjs)$/i.test(file)) c.problems.push("main must be a .js, .mjs or .cjs file");
  const memoryMB = integer(c, "memoryMB", memory, LIMITS.memoryMB, DEFAULT_MAIN_MB);
  return file ? { entry: file, memoryMB } : null;
}

export function program(c: Check, path: string, value: unknown): ProgramSpec | null {
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["name", "path", "afterUpdate", "example", "claim"]);
  const name = matching(c, `${path}.name`, doc.name, NAME, NAME_RULE);
  const file = typeof doc.path === "string" && isPluginPath(doc.path) ? doc.path : (c.problems.push(`${path}.path must be a file in the plugin's folder, like bin/tool`), null);
  const [most, argv] = LIMITS.afterUpdate;
  const okAfter = (a: unknown) => Array.isArray(a) && a.length > 0 && a.length <= argv && a.every(isArgument);
  const after = doc.afterUpdate === undefined ? [] : Array.isArray(doc.afterUpdate) && doc.afterUpdate.length <= most && doc.afterUpdate.every(okAfter) ? (doc.afterUpdate as string[][]) : (c.problems.push(`${at(path, "afterUpdate")} must be a list of at most ${most} argument lists of 1 to ${argv}`), null);
  const example = text(c, `${path}.example`, doc.example, LIMITS.example, false);
  const claim = flag(c, `${path}.claim`, doc.claim);
  return name && file && after ? { name, path: file, afterUpdate: after, example, claim } : null;
}
