import { openInspection, type InspectionSession } from "./devToolsSession";
import { generatedPositionFor, isDataUrl, SourceMapResolver } from "./devToolsSourceMaps";
import { STOPPED } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export const MAX_EXPRESSION = 2000;
export const MAX_LOGPOINTS_PER_CONNECTION = 50;
export const SCRIPTS_SETTLE_MS = 250;
export const MAX_HELD_SCRIPTS = 20_000;
export const MAX_HELD_MAP_BYTES = 32 * 1024 * 1024;
export const MAX_HELD_FRAMES = 1_000;

type Fields = Record<string, unknown>;
type Script = { url: string; sourceMapURL: string | null; frameId: string | null; contextId: number | null; startLine: number; startColumn: number };
type ScriptBook = { scripts: Map<string, Script>; frames: Set<string>; frameContexts: Map<string, number>; mapBytes: number };
type Logpoint = { id: string; tabId: string; breakpointId: string; url: string; line: number; column: number | null; original: { source: string; line: number; column: number | null } | null };
type Held = { session: InspectionSession; book: ScriptBook; logpoints: Map<string, Logpoint>; pending: number; stop: () => void };

const held = new Map<number, Map<string, Held>>();
const opening = new Map<string, Promise<Held>>();
const reserved = new Map<number, number>();
let nextId = 0;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 2048): string | null => (typeof value === "string" ? value.slice(0, max) : null);

export function checkedExpression(value: string, what: string): string {
  if (!value.trim()) throw new OpError("bad_request", `${what} can't be empty.`);
  if (value.length > MAX_EXPRESSION) throw new OpError("bad_request", `${what} is longer than ${MAX_EXPRESSION} characters.`);
  if (value.includes("\u0000")) throw new OpError("bad_request", `${what} can't contain a NUL character.`);
  return value;
}

export function logpointCondition(id: string, expression: string, condition: string | null): string {
  const label = JSON.stringify(`[ardia logpoint ${id}]`);
  const guard = condition === null ? "true" : `eval(${JSON.stringify(condition)})`;
  return `(() => { try { if (${guard}) console.log(${label}, eval(${JSON.stringify(expression)})); } catch (e) { try { console.log(${label}, "logpoint error: " + String(e)); } catch (_) {} } return false; })()`;
}

function heldFor(connection: number, tabId: string): Promise<Held> {
  const key = `${connection}:${tabId}`;
  const pending = opening.get(key);
  if (pending) return pending;
  const started = openHeld(connection, tabId).finally(() => opening.delete(key));
  opening.set(key, started);
  return started;
}

async function openHeld(connection: number, tabId: string): Promise<Held> {
  const known = held.get(connection)?.get(tabId);
  if (known && !known.session.isClosed) return known;
  const session = await openInspection(tabId, connection);
  const own = held.get(connection) ?? new Map<string, Held>();
  held.set(connection, own);
  const book = newScriptBook();
  const stop = session.on((method, params) => {
    if (method === "Debugger.scriptParsed") recordScript(book, params);
  });
  const entry: Held = { session, book, logpoints: new Map(), pending: 0, stop };
  own.set(tabId, entry);
  void session.ended.then(() => {
    if (held.get(connection)?.get(tabId) === entry) void release(connection, tabId, entry);
  });
  try {
    await session.send("Debugger.enable", { maxScriptsCacheSize: 0 });
    await session.pause(SCRIPTS_SETTLE_MS);
  } catch (error) {
    await release(connection, tabId, entry);
    throw error;
  }
  return entry;
}

export const newScriptBook = (): ScriptBook => ({ scripts: new Map(), frames: new Set(), frameContexts: new Map(), mapBytes: 0 });

let retainedMapBytes = 0;

export const retainedLogpointMapBytes = () => retainedMapBytes;

function forget(book: ScriptBook, scriptId: string) {
  const script = book.scripts.get(scriptId);
  if (!script) return;
  const bytes = script.sourceMapURL?.length ?? 0;
  book.mapBytes -= bytes;
  retainedMapBytes -= bytes;
  book.scripts.delete(scriptId);
}

export function discardScriptBook(book: ScriptBook) {
  retainedMapBytes -= book.mapBytes;
  book.mapBytes = 0;
  book.scripts.clear();
  book.frameContexts.clear();
  book.frames.clear();
}

export function recordScript(book: ScriptBook, params: Fields) {
  const scriptId = text(params.scriptId, 256);
  const url = text(params.url);
  if (!scriptId || !url) return;
  const aux = isFields(params.executionContextAuxData) ? params.executionContextAuxData : {};
  const frameId = text(aux.frameId, 256);
  const contextId = typeof params.executionContextId === "number" ? params.executionContextId : null;
  const newContext = frameId !== null && contextId !== null && aux.isDefault === true && book.frameContexts.get(frameId) !== contextId;
  if (newContext) for (const [id, script] of [...book.scripts]) if (script.frameId === frameId && script.contextId !== contextId) forget(book, id);
  forget(book, scriptId);
  if (book.scripts.size >= MAX_HELD_SCRIPTS) return;
  if (frameId !== null && !book.frames.has(frameId)) {
    if (book.frames.size >= MAX_HELD_FRAMES) return;
    book.frames.add(frameId);
  }
  if (newContext) book.frameContexts.set(frameId, contextId);
  const offered = typeof params.sourceMapURL === "string" && isDataUrl(params.sourceMapURL) ? params.sourceMapURL : null;
  const sourceMapURL = offered !== null && retainedMapBytes + offered.length <= MAX_HELD_MAP_BYTES ? offered : null;
  const bytes = sourceMapURL?.length ?? 0;
  book.mapBytes += bytes;
  retainedMapBytes += bytes;
  const offset = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  book.scripts.set(scriptId, { url, sourceMapURL, frameId, contextId, startLine: offset(params.startLine), startColumn: offset(params.startColumn) });
}

async function release(connection: number, tabId: string, only?: Held) {
  const own = held.get(connection);
  const entry = own?.get(tabId);
  if (!own || !entry || (only && entry !== only)) {
    if (only) {
      only.stop();
      discardScriptBook(only.book);
      await only.session.close();
    }
    return;
  }
  own.delete(tabId);
  if (!own.size) held.delete(connection);
  entry.stop();
  discardScriptBook(entry.book);
  await entry.session.close();
}

type Target = { url: string; line: number; column: number | null; scriptId: string | null; original: { source: string; line: number; column: number | null } | null };

export function locate(book: ScriptBook, url: string, line: number, column: number | null): Target | null {
  const scripts = [...book.scripts.entries()];
  if (scripts.some(([, s]) => s.url === url)) return { url, line, column, scriptId: null, original: null };
  const resolver = new SourceMapResolver();
  for (const [scriptId, script] of scripts.reverse()) {
    if (!script.sourceMapURL) continue;
    const map = resolver.mapFor(`script:${scriptId}`, script.sourceMapURL);
    const position = map ? generatedPositionFor(map, url, line, column) : null;
    if (position) return { url: script.url, line: position.line + script.startLine + 1, column: position.column + (position.line === 0 ? script.startColumn : 0) + 1, scriptId, original: { source: url, line, column } };
  }
  return null;
}

const heldCount = (connection: number) => [...(held.get(connection)?.values() ?? [])].reduce((sum, h) => sum + h.logpoints.size, 0);

export type SetLogpoint = { connection: number; serving: () => boolean; tabId: string; url: string; line: number; column: number | null; expression: string; condition: string | null };

export async function setLogpoint(request: SetLogpoint) {
  const expression = checkedExpression(request.expression, "expression");
  const condition = request.condition === null ? null : checkedExpression(request.condition, "condition");
  const slots = reserved.get(request.connection) ?? 0;
  if (heldCount(request.connection) + slots >= MAX_LOGPOINTS_PER_CONNECTION) throw new OpError("refused", `A connection can hold at most ${MAX_LOGPOINTS_PER_CONNECTION} logpoints; clear some first.`);
  reserved.set(request.connection, slots + 1);
  let entry: Held | null = null;
  try {
    entry = await heldFor(request.connection, request.tabId);
    entry.pending++;
    if (!request.serving()) throw new OpError("failed", STOPPED);
    const where = locate(entry.book, request.url, request.line, request.column);
    const id = `lp${++nextId}`;
    const target: Target = where ?? { url: request.url, line: request.line, column: request.column, scriptId: null, original: null };
    const conditionCode = logpointCondition(id, expression, condition);
    const reply = target.scriptId
      ? await entry.session.send("Debugger.setBreakpoint", { location: { scriptId: target.scriptId, lineNumber: target.line - 1, ...(target.column !== null ? { columnNumber: target.column - 1 } : {}) }, condition: conditionCode })
      : await entry.session.send("Debugger.setBreakpointByUrl", { url: target.url, lineNumber: target.line - 1, ...(target.column !== null ? { columnNumber: target.column - 1 } : {}), condition: conditionCode });
    const breakpointId = text(reply.breakpointId, 1024);
    if (!breakpointId) throw new OpError("failed", "The tab didn't accept the logpoint.");
    const logpoint: Logpoint = { id, tabId: request.tabId, breakpointId, url: target.url, line: target.line, column: target.column, original: target.original };
    entry.logpoints.set(id, logpoint);
    if (!request.serving()) throw new OpError("failed", STOPPED);
    const locations = isFields(reply.actualLocation) ? 1 : Array.isArray(reply.locations) ? reply.locations.filter(isFields).length : 0;
    return { ...publicView(logpoint), bound: locations > 0, pending: locations === 0, matchedScript: where !== null };
  } catch (error) {
    if (entry && !request.serving()) await release(request.connection, request.tabId, entry);
    throw error;
  } finally {
    const left = (reserved.get(request.connection) ?? 1) - 1;
    if (left > 0) reserved.set(request.connection, left);
    else reserved.delete(request.connection);
    if (entry) {
      entry.pending--;
      if (!entry.logpoints.size && !entry.pending) await release(request.connection, request.tabId, entry);
    }
  }
}

const publicView = (logpoint: Logpoint) => ({ id: logpoint.id, tab: logpoint.tabId, url: logpoint.url, line: logpoint.line, column: logpoint.column, original: logpoint.original, label: `[ardia logpoint ${logpoint.id}]` });

export function listLogpoints(connection: number) {
  return [...(held.get(connection)?.values() ?? [])].flatMap((entry) => [...entry.logpoints.values()].map(publicView));
}

export async function clearLogpoint(connection: number, id: string | null) {
  const own = held.get(connection) ?? new Map<string, Held>();
  let cleared = 0;
  for (const [tabId, entry] of [...own.entries()]) {
    for (const logpoint of [...entry.logpoints.values()]) {
      if (id !== null && logpoint.id !== id) continue;
      if (!entry.session.isClosed) await entry.session.send("Debugger.removeBreakpoint", { breakpointId: logpoint.breakpointId });
      entry.logpoints.delete(logpoint.id);
      cleared++;
    }
    if (!entry.logpoints.size && !entry.pending) await release(connection, tabId, entry);
  }
  if (id !== null && !cleared) throw new OpError("bad_request", `There's no logpoint ${id} on this connection.`);
  return { cleared };
}

export async function dropLogpoints(connection: number) {
  for (const [tabId, entry] of [...(held.get(connection)?.entries() ?? [])]) await release(connection, tabId, entry);
}

export async function dropAllLogpoints() {
  for (const connection of [...held.keys()]) await dropLogpoints(connection);
}

export const heldLogpointSessions = () => [...held.values()].reduce((sum, own) => sum + own.size, 0);
