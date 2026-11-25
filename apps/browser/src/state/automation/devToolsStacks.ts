import { originalPositionFor, SourceMapResolver, type Original } from "./devToolsSourceMaps";

export const MAX_CAUSE_DEPTH = 16;
export const MAX_FRAMES = 64;
const MAX_TEXT = 4096;

export const CAUSE_CHAIN_FUNCTION =
  "function(){const out=[];const seen=new Set();let e=this;let more=true;while(more&&out.length<16&&!seen.has(e)){if(e!==null&&typeof e==='object')seen.add(e);let name='',message='',stack=null;try{name=e===null||e===undefined?'':String(e.name??'')}catch{}try{message=e===null?'null':e===undefined?'undefined':String(e.message??e)}catch{}try{stack=e!==null&&e!==undefined&&typeof e.stack==='string'?e.stack.slice(0,16384):null}catch{}out.push({name,message,stack});try{more=e!==null&&typeof e==='object'&&'cause' in e;e=more?e.cause:undefined}catch{more=false}}return out}";

type Fields = Record<string, unknown>;

export type Frame = { functionName: string | null; url: string; line: number; column: number; async: string | null };
export type ResolvedFrame = Frame & { original: Original | null };
export type ChainLink = { name: string | null; message: string | null; frames: Frame[] };
export type ResolvedLink = { name: string | null; message: string | null; frames: ResolvedFrame[] };

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isFields(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const text = (value: unknown, max = MAX_TEXT): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

const LOCATION = /^((?:[a-z][\w+.-]*:)?\S+?):(\d+):(\d+)$/i;
const FRAME_PREFIX = /^\s*at (?:(async) )?/;

function frameOfLine(line: string): Frame | null {
  const prefix = FRAME_PREFIX.exec(line);
  if (!prefix) return null;
  const body = line.slice(prefix[0].length).trimEnd();
  let functionName: string | null = null;
  let location = body;
  if (body.endsWith(")")) {
    const open = body.lastIndexOf(" (");
    if (open > 0) {
      functionName = body.slice(0, open);
      location = body.slice(open + 2, -1);
    } else if (body.startsWith("(")) location = body.slice(1, -1);
  }
  let match = LOCATION.exec(location);
  if (!match && functionName !== null) {
    const opens = [...body.matchAll(/ \(/g)].map((m) => m.index!);
    for (const at of opens) {
      match = LOCATION.exec(body.slice(at + 2, -1));
      if (match) {
        functionName = body.slice(0, at);
        break;
      }
    }
  }
  if (!match) return null;
  const lineNo = Number(match[2]), column = Number(match[3]);
  if (!Number.isSafeInteger(lineNo) || !Number.isSafeInteger(column) || lineNo < 1 || column < 1) return null;
  return { functionName: functionName ? functionName.slice(0, 512) : null, url: match[1]!.slice(0, 2048), line: lineNo, column, async: prefix[1] ? "await" : null };
}

export function framesOfStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(0, 512)) {
    const frame = frameOfLine(line.slice(0, 4096));
    if (!frame) continue;
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function framesOfCdp(stackTrace: unknown): Frame[] {
  const frames: Frame[] = [];
  let current = stackTrace;
  let async: string | null = null;
  for (let depth = 0; isFields(current) && depth < 32 && frames.length < MAX_FRAMES; depth++) {
    const callFrames = field(current, "callFrames");
    for (const frame of Array.isArray(callFrames) ? callFrames : []) {
      const url = text(field(frame, "url"), 2048);
      const line = whole(field(frame, "lineNumber"));
      const column = whole(field(frame, "columnNumber"));
      if (!url || line === null || column === null) continue;
      frames.push({ functionName: text(field(frame, "functionName"), 512) || null, url, line: line + 1, column: column + 1, async });
      if (frames.length >= MAX_FRAMES) break;
    }
    const parent = field(current, "parent");
    async = text(field(parent, "description"), 128) || "async";
    current = parent;
  }
  return frames;
}

function messageOf(description: string | null): { name: string | null; message: string | null } {
  if (!description) return { name: null, message: null };
  const head = description.split("\n")[0]!;
  const match = /^([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(head);
  return match ? { name: match[1]!, message: match[2]! } : { name: null, message: head };
}

const meaningful = (link: ChainLink) => link.name !== null || link.message !== null || link.frames.length > 0;

export function chainOf(input: unknown): ChainLink[] {
  return rawChainOf(input).filter(meaningful);
}

function rawChainOf(input: unknown): ChainLink[] {
  const details = field(input, "exceptionDetails") ?? (field(input, "stackTrace") !== undefined && field(input, "exception") !== undefined ? input : undefined);
  if (isFields(details)) {
    const description = text(field(field(details, "exception"), "description"));
    const { name, message } = messageOf(description ?? text(field(details, "text")));
    const cdpFrames = framesOfCdp(field(details, "stackTrace"));
    const head: ChainLink = { name: text(field(field(details, "exception"), "className"), 256) ?? name, message, frames: cdpFrames.length ? cdpFrames : description ? framesOfStack(description) : [] };
    const causes = field(input, "causes");
    return [head, ...(Array.isArray(causes) ? linksOfList(causes.slice(1)) : [])];
  }
  if (Array.isArray(input)) return linksOfList(input);
  const links: ChainLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = field(input, "error") ?? input;
  let more = current !== undefined;
  while (more && links.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    if (!isFields(current)) {
      if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") links.push({ name: null, message: String(current).slice(0, MAX_TEXT), frames: [] });
      break;
    }
    seen.add(current);
    links.push(linkOf(current));
    more = Object.hasOwn(current, "cause");
    current = current.cause;
  }
  return links;
}

function linkOf(value: Fields): ChainLink {
  const stack = text(field(value, "stack"), 65536);
  const parsed = messageOf(stack);
  return { name: text(field(value, "name"), 256) ?? parsed.name, message: text(field(value, "message")) ?? parsed.message, frames: stack ? framesOfStack(stack) : [] };
}

const linksOfList = (list: unknown[]): ChainLink[] => list.filter(isFields).slice(0, MAX_CAUSE_DEPTH).map(linkOf);

export function resolveChain(chain: ChainLink[], resolver: SourceMapResolver): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];
  for (const link of chain) {
    const frames: ResolvedFrame[] = [];
    for (const frame of link.frames) {
      const map = resolver.mapFor(frame.url);
      frames.push({ ...frame, original: map ? originalPositionFor(map, frame.line - 1, frame.column - 1) : null });
    }
    resolved.push({ ...link, frames });
  }
  return resolved;
}
