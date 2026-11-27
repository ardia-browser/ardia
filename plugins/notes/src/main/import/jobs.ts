import { fromBase64, randomHex } from "../../shared/bytes";
import { importSource, type ImportJob, type ImportPick, type ImportSourceId } from "../../shared/importSources";
import { allPages, archivePage, getPage } from "../../shared/model";
import { ardiaFileStore, type FilesApi, type FoldersApi, type FileStore } from "../files";
import { IMPORT_LIMITS, ImportCancelled, ImportError } from "./limits";
import { LayeredVfs, singleVfs, storeAccess, storeVfs, type Spool, type VFile, type Vfs } from "./vfs";
import { writePlan, type Plan, type Sink } from "./write";
import { filesPlan } from "./sources/files";
import { notionPlan } from "./sources/notion";
import { evernotePlan } from "./sources/evernote";
import { joplinPlan, keepPlan, roamPlan, simplenotePlan } from "./sources/apps";
import type { RandomAccess } from "./zip";
import { appleNotesPlan, type AppleNotesApi } from "./sources/appleNotesApp";
import { importNotionRecords, notionRecordId, readRecordsJson, type RecordsReader } from "./sources/notionRecords";
import type { NotionRecords } from "../../shared/notionRecords";
import { readImports, recordImport } from "./write";

export type PickedFile = { id: string; name: string; size: number };

type Staged = { name: string; next: number; size: number; at: number };

const UPLOAD_ROOT = "import-uploads";
const UPLOAD_TTL = 60 * 60 * 1000;
const UPLOADS_OPEN = 4;

export function stagedName(raw: string): string | null {
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\/\\:]/g, "-").replace(/^[.\s]+/, "").trim().slice(0, 200);
  if (!name) return null;
  return name;
}

export type ImportHost = {
  files: FilesApi;
  folders: FoldersApi | null;
  pickFiles?: (options: { multiple?: boolean }) => Promise<PickedFile[]>;
  appleNotes?: AppleNotesApi & { request(): Promise<boolean> };
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  notionLive?: { takeRecords(): { records: NotionRecords; release(): Promise<void> } | null };
};

export type ImportDeps = {
  host: ImportHost;
  now(): number;
  log(level: "error" | "warn" | "info", text: string): void;
  target(workspace: string): Promise<Sink>;
  opened(workspace: string, page: string): void;
  keepsFolder?(id: string): boolean;
};

type RecordsInput = { records: NotionRecords; reader: RecordsReader };

type Input = { vfs: Vfs; access: (path: string, size: number) => RandomAccess | null; release: () => Promise<void>; notesApp?: AppleNotesApi; records?: RecordsInput };

export const RECORDS_FILE = "notion-records.json";

const READ_CHUNK = 4 * 1024 * 1024;

export function storeReader(store: FileStore, base = ""): RecordsReader {
  const at = (path: string) => (base ? `${base}/${path}` : path).replace(/\/+/g, "/").replace(/^\//, "");
  return {
    async read(path) {
      if (path.split("/").includes("..")) throw new ImportError(`${path} isn't in the import.`);
      const full = at(path);
      const stat = await store.stat(full);
      if (!stat.found) throw new ImportError(`${path} isn't in the import.`);
      if (stat.size > IMPORT_LIMITS.attachmentBytes) throw new ImportError(`${path} is too big to import.`);
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < stat.size; offset += READ_CHUNK) {
        const res = await store.read(full, { offset, length: Math.min(READ_CHUNK, stat.size - offset) });
        if (!res.found) throw new ImportError(`${path} went away while it was being read.`);
        parts.push(res.data);
      }
      if (parts.length === 1) return parts[0]!;
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    },
  };
}

export function vfsReader(vfs: Vfs, base: string): RecordsReader {
  const sizes = new Map(vfs.files.map((f) => [f.path, f.size]));
  return {
    read: (path) => {
      if (path.split("/").includes("..")) throw new ImportError(`${path} isn't in the import.`);
      return vfs.read(base ? `${base}/${path}` : path, IMPORT_LIMITS.attachmentBytes);
    },
    size: (path) => sizes.get(base ? `${base}/${path}` : path) ?? 0,
  };
}

export function recordsFileIn(vfs: Vfs): string | null {
  const found = vfs.files.filter((f) => f.path === RECORDS_FILE || f.path.endsWith(`/${RECORDS_FILE}`)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  return found?.path ?? null;
}

type Running = { job: ImportJob; cancelled: boolean; quit?: boolean; done?: Promise<void> };

export const RUNNING_IMPORT_KEY = "importRunning";

type RunningRecord = { id: string; source: ImportSourceId; workspace: string; root: string | null; roots?: string[]; title: string; startedAt: number };

export const INTERRUPTED_IMPORT = "The import stopped when Notes did, so what it had made so far went to the trash. Start it again.";

function runningRecord(value: unknown): RunningRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[0-9a-f]{12}$/.test(r.id) || typeof r.workspace !== "string" || typeof r.startedAt !== "number") return null;
  if (!importSource(r.source as ImportSourceId)) return null;
  return {
    id: r.id,
    source: r.source as ImportSourceId,
    workspace: r.workspace,
    root: typeof r.root === "string" ? r.root : null,
    roots: Array.isArray(r.roots) ? r.roots.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{12}$/.test(x)).slice(0, 2000) : [],
    title: typeof r.title === "string" ? r.title : "",
    startedAt: r.startedAt,
  };
}

export async function planFor(source: ImportSourceId, vfs: Vfs): Promise<Plan> {
  switch (source) {
    case "notion":
      return notionPlan(vfs);
    case "evernote":
      return evernotePlan(vfs);
    case "roam":
      return roamPlan(vfs);
    case "keep":
      return vfs.files.some((f) => f.path.toLowerCase().endsWith(".json")) ? keepPlan(vfs) : filesPlan(vfs, "markdown");
    case "joplin":
      return joplinPlan(vfs);
    case "simplenote":
      return simplenotePlan(vfs);
    case "obsidian":
    case "logseq":
    case "bear":
    case "craft":
    case "apple-notes":
      return filesPlan(vfs, source);
    default:
      return filesPlan(vfs, "markdown");
  }
}

export function storeSpool(store: FileStore, prefix: string): Spool {
  let n = 0;
  const made: string[] = [];
  return {
    async create() {
      const name = `${prefix}-${n++}.bin`;
      made.push(name);
      let size = 0;
      let buffer: Uint8Array[] = [];
      let buffered = 0;
      const flush = async () => {
        if (!buffered) return;
        const joined = new Uint8Array(buffered);
        let at = 0;
        for (const b of buffer) {
          joined.set(b, at);
          at += b.length;
        }
        buffer = [];
        buffered = 0;
        if (size === 0) await store.write(name, joined);
        else await store.append(name, joined);
        size += joined.length;
      };
      return {
        async append(chunk) {
          buffer.push(chunk);
          buffered += chunk.length;
          if (buffered >= 2 * 1024 * 1024) await flush();
        },
        async done() {
          await flush();
          if (size === 0) await store.write(name, new Uint8Array(0));
          return storeAccess(store, name, size);
        },
      };
    },
    async clear() {
      for (const name of made.splice(0)) await store.remove(name).catch(() => false);
    },
  };
}

export class Imports {
  private readonly jobs = new Map<string, Running>();
  private readonly staged = new Map<string, Staged>();
  private latest: string | null = null;
  private recovery: Promise<void> | null = null;
  private recordWrites: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ImportDeps) {}

  recover(): Promise<void> {
    this.recovery ??= this.archiveInterrupted().catch((error) => this.deps.log("warn", `import: the interrupted import couldn't be cleaned up: ${String(error)}`));
    return this.recovery;
  }

  private async archiveInterrupted() {
    const record = runningRecord(await this.deps.host.storage.get(RUNNING_IMPORT_KEY));
    if (!record) return;
    const now = this.deps.now();
    const job: ImportJob = { id: record.id, source: record.source, workspace: record.workspace, state: "failed", files: 0, filesDone: 0, pages: 0, databases: 0, attachments: 0, skipped: 0, current: "", error: INTERRUPTED_IMPORT, startedAt: record.startedAt, finishedAt: now };
    try {
      const sink = await this.deps.target(record.workspace);
      const made = this.interruptedRoots(sink.tree, record);
      for (const root of made) archivePage(sink.tree, root, sink.by, now);
      if (made.length) {
        await sink.flush();
        job.root = made[0];
      }
      this.deps.log("info", `import ${record.source}: an import that stopped with Notes was ${made.length ? "moved to the trash" : "marked failed"}`);
    } finally {
      if (!this.jobs.has(record.id)) {
        this.jobs.set(record.id, { job, cancelled: false });
        this.latest ??= record.id;
      }
      await this.deps.host.storage.set(RUNNING_IMPORT_KEY, null);
      await this.count(job).catch(() => undefined);
    }
  }

  private interruptedRoots(tree: Sink["tree"], record: RunningRecord): string[] {
    const known = [...(record.root ? [record.root] : []), ...(record.roots ?? [])];
    if (known.length)
      return known.filter((id) => {
        const page = getPage(tree, id);
        return !!page && !page.deleted && page.archivedAt === 0;
      });
    if (!record.title) return [];
    const made = allPages(tree).filter((p) => p.parent === "" && !p.deleted && p.archivedAt === 0 && p.title === record.title && p.createdAt >= record.startedAt);
    return made.length === 1 ? [made[0]!.id] : [];
  }

  private remember(record: RunningRecord | null): Promise<void> {
    const storage = this.deps.host.storage;
    this.recordWrites = this.recordWrites.then(() => storage.set(RUNNING_IMPORT_KEY, record)).catch(() => undefined);
    return this.recordWrites;
  }

  status(id?: string): ImportJob | null {
    const key = id ?? this.latest;
    const running = key ? this.jobs.get(key) : undefined;
    return running ? { ...running.job } : null;
  }

  cancel(id: string) {
    const running = this.jobs.get(id);
    if (running && (running.job.state === "reading" || running.job.state === "writing")) running.cancelled = true;
  }

  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.jobs.values()].filter((r) => r.job.state === "reading" || r.job.state === "writing");
    for (const r of active) {
      r.cancelled = true;
      r.quit = true;
    }
    await Promise.all(active.map((r) => r.done?.catch(() => undefined)));
    await this.recordWrites;
  }

  private busy(): boolean {
    return [...this.jobs.values()].some((r) => r.job.state === "reading" || r.job.state === "writing");
  }

  private uploadStore(uploadId: string): FileStore {
    return ardiaFileStore(this.deps.host.files, "data", `${UPLOAD_ROOT}/${uploadId}`);
  }

  private async dropStaged(uploadId: string) {
    const staged = this.staged.get(uploadId);
    this.staged.delete(uploadId);
    if (staged) {
      const store = this.uploadStore(uploadId);
      await store.remove(staged.name).catch(() => false);
      await ardiaFileStore(this.deps.host.files, "data", UPLOAD_ROOT).remove(uploadId).catch(() => false);
    }
  }

  async upload(args: { uploadId: string; i: number; name: string; data: string }): Promise<{ uploadId: string; parts: number; size: number }> {
    const now = this.deps.now();
    for (const [id, s] of [...this.staged]) if (now - s.at > UPLOAD_TTL) await this.dropStaged(id);
    const bytes = fromBase64(args.data);
    let staged = this.staged.get(args.uploadId);
    if (!staged) {
      if (args.i !== 0) throw new ImportError("Send part 0 of this upload first.");
      if (this.staged.size >= UPLOADS_OPEN) throw new ImportError("Too many imports are being uploaded at once; start or drop one first.");
      let name = stagedName(args.name);
      if (!name) throw new ImportError("name is the export's file name, like Export.zip.");
      if (!/\.[A-Za-z0-9]{1,10}$/.test(name) && bytes[0] === 0x50 && bytes[1] === 0x4b) name = `${name}.zip`;
      staged = { name, next: 0, size: 0, at: now };
      this.staged.set(args.uploadId, staged);
    }
    if (args.i < staged.next) return { uploadId: args.uploadId, parts: staged.next, size: staged.size };
    if (args.i > staged.next) throw new ImportError(`Part ${staged.next} of this upload is next, not part ${args.i}.`);
    if (staged.size + bytes.length > IMPORT_LIMITS.spoolBytes) {
      await this.dropStaged(args.uploadId);
      throw new ImportError("That export is bigger than 2 GB.");
    }
    const store = this.uploadStore(args.uploadId);
    if (staged.next === 0) await store.write(staged.name, bytes);
    else await store.append(staged.name, bytes);
    staged.next++;
    staged.size += bytes.length;
    staged.at = now;
    return { uploadId: args.uploadId, parts: staged.next, size: staged.size };
  }

  private stagedInput(uploadId: string): Input {
    const staged = this.staged.get(uploadId);
    if (!staged || staged.next === 0) throw new ImportError("That upload isn't here. Send its parts with import upload first.");
    this.staged.delete(uploadId);
    const store = this.uploadStore(uploadId);
    const file: VFile = { path: staged.name, size: staged.size };
    return {
      vfs: singleVfs(store, staged.name, staged.size),
      access: (path, size) => (path === file.path ? storeAccess(store, staged.name, size) : null),
      release: async () => {
        this.staged.set(uploadId, staged);
        await this.dropStaged(uploadId);
      },
    };
  }

  private async appInput(source: ImportSourceId): Promise<Input | null> {
    const notes = this.deps.host.appleNotes;
    if (source !== "apple-notes") throw new ImportError("Only Apple Notes imports straight from its app.");
    if (!notes) throw new ImportError("This version of Ardia can't read Apple Notes yet. Export your notes to a folder and choose it instead.");
    if (!(await notes.request())) return null;
    return { vfs: { files: [], read: async () => new Uint8Array(0) }, access: () => null, release: async () => undefined, notesApp: notes };
  }

  private accountInput(source: ImportSourceId): Input {
    if (source !== "notion") throw new ImportError("Only Notion imports straight from your account.");
    const ready = this.deps.host.notionLive?.takeRecords();
    if (!ready) throw new ImportError("There's no Notion workspace ready to import. Start one with Import everything.");
    return {
      vfs: { files: [], read: async () => new Uint8Array(0) },
      access: () => null,
      release: () => ready.release(),
      records: { records: ready.records, reader: storeReader(ardiaFileStore(this.deps.host.files, "data")) },
    };
  }

  private async input(pick: ImportPick): Promise<Input | null> {
    const { host } = this.deps;
    if (pick === "folder") {
      if (!host.folders) throw new ImportError("Importing a folder needs folder access.");
      const grant = await host.folders.pick({ prompt: "Import" });
      if (!grant) return null;
      const store = ardiaFileStore(host.files, grant.id);
      const release = async () => {
        if (!this.deps.keepsFolder?.(grant.id)) await host.folders?.forget(grant.id).catch(() => undefined);
      };
      try {
        const vfs = await storeVfs(store);
        if (vfs.placeholders) this.deps.log("info", `import: ${vfs.placeholders} files are still in iCloud and were asked to download`);
        return { vfs, access: (path, size) => storeAccess(store, path, size), release };
      } catch (error) {
        await release();
        throw error;
      }
    }
    if (!host.pickFiles) throw new ImportError("This version of Ardia can't pick a file for plugins yet. Unzip the export and choose its folder instead.");
    const picked = (await host.pickFiles({ multiple: true })).slice(0, 64);
    if (!picked.length) return null;
    const stores = new Map<string, { store: FileStore; name: string; size: number }>();
    const files: VFile[] = [];
    for (const p of picked) {
      let name = p.name;
      for (let n = 2; stores.has(name); n++) name = `${n} ${p.name}`;
      stores.set(name, { store: ardiaFileStore(host.files, p.id), name: p.name, size: p.size });
      files.push({ path: name, size: p.size });
    }
    const vfs: Vfs = {
      files,
      read: (path, max) => {
        const s = stores.get(path);
        if (!s) throw new ImportError(`${path} isn't in the export.`);
        return singleVfs(s.store, s.name, s.size).read(s.name, max);
      },
    };
    return {
      vfs,
      access: (path, size) => {
        const s = stores.get(path);
        return s ? storeAccess(s.store, s.name, size) : null;
      },
      release: async () => undefined,
    };
  }

  async start(workspace: string, source: ImportSourceId, pick: ImportPick, uploadId?: string): Promise<{ job: string } | null> {
    const info = importSource(source);
    if (!info) throw new ImportError("Notes can't import from there.");
    if (this.stopping) throw new ImportError("Notes is closing, so the import didn't start.");
    await this.recover();
    if (this.busy()) throw new ImportError("An import is already running. Wait for it to finish or cancel it.");
    const input = uploadId ? this.stagedInput(uploadId) : pick === "app" ? await this.appInput(source) : pick === "account" ? this.accountInput(source) : await this.input(pick);
    if (!input) return null;
    const id = randomHex(6);
    const job: ImportJob = { id, source, workspace, state: "reading", files: input.vfs.files.length, filesDone: 0, pages: 0, databases: 0, attachments: 0, skipped: 0, current: "", startedAt: this.deps.now() };
    const running: Running = { job, cancelled: false };
    this.jobs.set(id, running);
    this.latest = id;
    for (const [key, r] of this.jobs) if (key !== id && this.jobs.size > 8 && r.job.state !== "reading" && r.job.state !== "writing") this.jobs.delete(key);
    await this.remember({ id, source, workspace, root: null, title: `${info.title} import`, startedAt: job.startedAt });
    running.done = this.run(running, input, info.title).catch((error) => this.deps.log("warn", `import: ${String(error)}`));
    return { job: id };
  }

  private async run(running: Running, input: Input, title: string) {
    const { job } = running;
    const spool = storeSpool(ardiaFileStore(this.deps.host.files, "data", "import-spool"), job.id);
    let root: string | null = null;
    let roots: string[] = [];
    let sink: Sink | null = null;
    let keepRecovery = false;
    const madeRoots = (made: string[]) => {
      roots = made;
      if (made.length) void this.remember({ id: job.id, source: job.source, workspace: job.workspace, root: null, roots: made, title: `${title} import`, startedAt: job.startedAt });
    };
    try {
      if (input.records || (job.source === "notion" && recordsFileIn(input.vfs) === RECORDS_FILE)) {
        roots = await this.runRecords(running, input, (s) => (sink = s), madeRoots);
        return;
      }
      const vfs = await LayeredVfs.build(input.vfs, input.access, spool, (path) => {
        if (running.cancelled) throw new ImportCancelled();
        job.current = path;
      });
      job.files = vfs.files.length;
      job.skipped = vfs.refused;
      if (running.cancelled) throw new ImportCancelled();
      const recordsPath = job.source === "notion" ? recordsFileIn(vfs) : null;
      if (recordsPath) {
        const base = recordsPath.slice(0, Math.max(0, recordsPath.length - RECORDS_FILE.length - 1));
        const text = new TextDecoder().decode(await vfs.read(recordsPath, IMPORT_LIMITS.jsonBytes));
        roots = await this.runRecords(running, { ...input, records: { records: readRecordsJson(text), reader: vfsReader(vfs, base) } }, (s) => (sink = s), madeRoots);
        return;
      }
      const plan = input.notesApp ? await appleNotesPlan(input.notesApp) : await planFor(job.source, vfs);
      if (running.cancelled) throw new ImportCancelled();
      job.state = "writing";
      job.files = Math.min(plan.nodes.length, IMPORT_LIMITS.pages);
      sink = await this.deps.target(job.workspace);
      const target = sink;
      const result = await writePlan(
        plan,
        target,
        { title: `${title} import`, icon: "📥" },
        (p) => {
          job.pages = p.pages;
          job.databases = p.databases;
          job.attachments = p.attachments;
          job.skipped = p.skipped + vfs.refused;
          job.current = p.current;
          job.filesDone = p.done;
          job.files = p.total;
        },
        () => running.cancelled,
        this.deps.now(),
        {
          sync: job.source === "notion" ? { workspace: job.workspace, candidates: readImports(target.tree) } : undefined,
          onRoot: (page) => {
            root = page;
            void this.remember({ id: job.id, source: job.source, workspace: job.workspace, root: page, title: `${title} import`, startedAt: job.startedAt });
          },
        },
      );
      if (result.recordId) {
        recordImport(target.tree, { id: result.recordId, source: job.source, at: this.deps.now(), roots: [result.root], pages: result.pageIds, by: target.by, files: result.files });
        await target.flush();
      }
      job.root = result.root;
      job.conflicts = result.conflicts;
      job.state = "done";
      job.current = "";
      this.deps.opened(job.workspace, result.root);
    } catch (error) {
      if (running.quit) {
        job.state = "failed";
        job.error = INTERRUPTED_IMPORT;
        keepRecovery = true;
      } else if (error instanceof ImportCancelled) job.state = "cancelled";
      else {
        job.state = "failed";
        job.error = error instanceof ImportError ? error.message : `The import stopped: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
        this.deps.log("warn", `import ${job.source}: ${String(error)}`);
      }
      const made = roots.length ? roots : root ? [root] : [];
      const target = sink as Sink | null;
      if (made.length && target && !running.quit) {
        try {
          for (const id of made) archivePage(target.tree, id, target.by, this.deps.now());
          await target.flush();
        } catch {
          keepRecovery = true;
        }
      }
    } finally {
      job.finishedAt = this.deps.now();
      await (sink as Sink | null)?.settle?.().catch(() => undefined);
      if (!keepRecovery) await this.remember(null);
      await spool.clear().catch(() => undefined);
      await input.release().catch(() => undefined);
      await this.count(job).catch(() => undefined);
    }
  }

  private async runRecords(running: Running, input: Input, onSink: (sink: Sink) => void, onRoots: (roots: string[]) => void): Promise<string[]> {
    const { job } = running;
    let records = input.records;
    if (!records) {
      const text = new TextDecoder().decode(await input.vfs.read(RECORDS_FILE, IMPORT_LIMITS.jsonBytes));
      records = { records: readRecordsJson(text), reader: vfsReader(input.vfs, "") };
    }
    job.state = "writing";
    job.files = Object.keys(records.records.blocks).length;
    const sink = await this.deps.target(job.workspace);
    onSink(sink);
    const recordId = notionRecordId(records.records.spaceId);
    const previous = readImports(sink.tree).find((r) => r.id === recordId);
    const result = await importNotionRecords(records.records, sink, records.reader, {
      workspace: job.workspace,
      files: previous?.files,
      now: this.deps.now(),
      cancelled: () => running.cancelled,
      progress: (p) => {
        job.pages = p.pages;
        job.databases = p.databases;
        job.attachments = p.attachments;
        job.skipped = p.skipped;
        job.current = p.current;
        job.filesDone = p.done;
        job.files = p.total;
      },
      onRoots,
    });
    recordImport(sink.tree, { id: recordId, source: job.source, at: this.deps.now(), roots: result.roots, pages: result.pageIds, by: sink.by, files: result.files });
    await sink.flush();
    job.pages = result.pages;
    job.databases = result.databases;
    job.attachments = result.attachments;
    job.skipped = result.skipped;
    job.conflicts = result.conflicts;
    if (result.roots[0]) job.root = result.roots[0];
    job.roots = result.roots;
    job.state = "done";
    job.current = "";
    if (result.roots[0]) this.deps.opened(job.workspace, result.roots[0]);
    return result.roots;
  }

  private async count(job: ImportJob) {
    const storage = this.deps.host.storage;
    const stats = ((await storage.get<Record<string, number>>("importStats")) ?? {}) as Record<string, number>;
    const bump = (key: string, by = 1) => {
      stats[key] = (typeof stats[key] === "number" ? stats[key]! : 0) + by;
    };
    bump(`${job.source}.${job.state}`);
    bump(`${job.source}.pages`, job.pages);
    bump(`${job.source}.databases`, job.databases);
    bump(`${job.source}.attachments`, job.attachments);
    if (job.conflicts) bump(`${job.source}.conflicts`, job.conflicts);
    await storage.set("importStats", stats);
  }
}
