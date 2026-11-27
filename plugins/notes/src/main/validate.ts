import { IMPORT_SOURCE_IDS, STARTER_IDS } from "../shared/importSources";
import type { ExtraOpName, OpName } from "../shared/protocol";
import { TEMPLATE_IDS } from "../shared/templates";
import { COUNT_EVENTS } from "../shared/templates/counts";

type Check = (value: unknown, field: string) => unknown;

const fail = (field: string, what: string): never => {
  throw new Error(`${field} must be ${what}.`);
};

const PAGE_ID = /^[0-9a-f]{12}$/;
const WS_ID = /^[0-9a-f]{12,32}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const text =
  (max: number): Check =>
  (v, f) =>
    typeof v === "string" && v.length <= max ? v : fail(f, `text of at most ${max} characters`);
const matching =
  (re: RegExp, what: string): Check =>
  (v, f) =>
    typeof v === "string" && re.test(v) ? v : fail(f, what);
const page = matching(PAGE_ID, "a page id");
const pageOrTop: Check = (v, f) => (v === "" ? "" : page(v, f));
const workspace = matching(WS_ID, "a workspace id");
const oneOf =
  (...values: string[]): Check =>
  (v, f) =>
    typeof v === "string" && values.includes(v) ? v : fail(f, `one of ${values.join(", ")}`);
const bool: Check = (v, f) => (typeof v === "boolean" ? v : fail(f, "true or false"));
const int =
  (min: number, max: number): Check =>
  (v, f) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v : fail(f, `a whole number from ${min} to ${max}`);
const optional =
  (check: Check): Check & { optional: true } =>
    Object.assign((v: unknown, f: string) => (v === undefined ? undefined : check(v, f)), { optional: true as const });
const nullable =
  (check: Check): Check =>
  (v, f) =>
    v === null ? null : check(v, f);
const json =
  (maxBytes: number): Check =>
  (v, f) => {
    if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return fail(f, "an object");
    let size = 0;
    try {
      size = JSON.stringify(v).length;
    } catch {
      return fail(f, "plain data");
    }
    return size <= maxBytes ? v : fail(f, `at most ${maxBytes} bytes`);
  };

type Shape = Record<string, Check>;

const SHAPES: Record<OpName | ExtraOpName, Shape> = {
  createPage: { workspace, parent: pageOrTop, kind: oneOf("page", "database"), title: optional(text(2000)), icon: optional(text(300)), after: optional(page), props: optional(json(64 * 1024)), template: optional(page) },
  duplicatePage: { workspace, page },
  movePage: { workspace, page, parent: pageOrTop, after: optional(nullable(page)), toWorkspace: optional(workspace) },
  archivePage: { workspace, page },
  restorePage: { workspace, page },
  deletePage: { workspace, page },
  search: { query: text(500), workspace: optional(workspace), limit: optional(int(1, 200)), titlesOnly: optional(bool) },
  resolve: { path: text(4096) },
  uploadPart: { uploadId: matching(UPLOAD_ID, "an upload id"), i: int(0, 10_000), data: (v, f) => (typeof v === "string" && v.length <= 64_000 && BASE64.test(v) ? v : fail(f, "base64 of at most 64000 characters")) },
  upload: { workspace, name: text(255), type: text(200), uploadId: matching(UPLOAD_ID, "an upload id") },
  file: { workspace, ref: matching(/^(file:)?[0-9a-f]{64}$/, "a file reference") },
  history: { workspace, page },
  restoreVersion: { workspace, page, version: text(120) },
  versionState: { workspace, page, version: text(120) },
  createWorkspace: { name: text(200) },
  createSharedWorkspace: { name: text(200) },
  joinSharedWorkspace: {},
  shareWorkspace: { workspace },
  sharePage: { workspace, page },
  stopSharingPage: { workspace },
  renameWorkspace: { workspace, name: text(200), icon: optional(text(300)) },
  leaveWorkspace: { workspace },
  openUrl: { url: text(4096) },
  setMe: { name: optional(text(200)), color: optional(text(32)) },
  backlinks: { workspace, page },
  exportFile: { name: text(300), text: text(3_000_000) },
  importStart: { workspace, source: oneOf(...IMPORT_SOURCE_IDS), pick: optional(oneOf("file", "folder", "app", "account")), uploadId: optional(matching(/^[A-Za-z0-9_-]{8,64}$/, "an upload id")) },
  agentStatus: {},
  appIcon: { path: matching(/^\/(System\/)?Applications\/[^\u0000]{1,200}\.app$/, "an app in /Applications or /System/Applications"), size: optional(int(16, 256)) },
  openArdiaSettings: { pane: oneOf("plugins", "advanced") },
  agentDemo: { workspace },
  agentDemoStatus: { job: matching(/^[0-9a-f]{12}$/, "a demo id") },
  importUpload: { uploadId: matching(/^[A-Za-z0-9_-]{8,64}$/, "an upload id"), i: int(0, 100_000), name: text(200), data: (v, f) => (typeof v === "string" && v.length <= 1_400_000 && v.length % 4 === 0 && BASE64.test(v) ? v : fail(f, "padded base64 of at most 1,400,000 characters")) },
  importStatus: { job: optional(matching(/^[0-9a-f]{12}$/, "an import id")) },
  importCancel: { job: matching(/^[0-9a-f]{12}$/, "an import id") },
  notionAccount: { fresh: optional(bool) },
  notionImport: { space: matching(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "a Notion workspace id") },
  notionImportStatus: {},
  notionImportCancel: {},
  applyStarter: { workspace, starter: oneOf(...STARTER_IDS) },
  useTemplate: { workspace, template: oneOf(...TEMPLATE_IDS), parent: optional(pageOrTop), into: optional(page) },
  countEvent: { event: oneOf(...COUNT_EVENTS) },
  counts: {},
};

export function isOp(op: string): boolean {
  return Object.hasOwn(SHAPES, op);
}

export function validArgs(op: string, args: unknown): Record<string, unknown> {
  if (!isOp(op)) throw new Error(`Notes can't ${op.slice(0, 40)}.`);
  const shape = SHAPES[op as OpName];
  const given = args === undefined || args === null ? {} : args;
  if (typeof given !== "object" || Array.isArray(given)) throw new Error("args must be an object.");
  const out: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(shape)) {
    const value = Object.hasOwn(given, field) ? (given as Record<string, unknown>)[field] : undefined;
    const checked = check(value, field);
    if (checked !== undefined) out[field] = checked;
  }
  return out;
}
