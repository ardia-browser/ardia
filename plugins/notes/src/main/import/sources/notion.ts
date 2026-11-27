import { find, findAll, htmlBlocks, parseDom, textContent, type HNode } from "../html";
import { para, type Block, type Column, type ColumnType, type ImportNode } from "../ir";
import { IMPORT_LIMITS } from "../limits";
import { parseMarkdown } from "../markdown";
import { dirOf, joinPath, LinkIndex, stemOf } from "../resolve";
import { decodeText, extOf, type Vfs } from "../vfs";
import { parseDate, type Plan } from "../write";
import { printOf } from "../rebase";
import { parseCsv } from "./csv";

const NOTION_ID = /\s+([0-9a-f]{32})$/i;

export const notionTitle = (stem: string) => stem.replace(NOTION_ID, "").trim() || "Untitled";

const keyOf = (path: string) => path.replace(/(_all)?\.(md|html?|csv)$/i, "");

function guessType(name: string, values: string[]): ColumnType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return "text";
  const lower = name.toLowerCase();
  if (filled.every((v) => /^(yes|no)$/i.test(v))) return "checkbox";
  if (filled.every((v) => /^-?[\d,]+(\.\d+)?%?$/.test(v) || /^[$€£¥₹]-?[\d,]+(\.\d+)?$/.test(v))) return "number";
  if (filled.every((v) => /^https?:\/\/\S+$/i.test(v))) return "url";
  if (filled.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) return "email";
  if (filled.every((v) => v.split(/\s+→\s+/).every((p) => parseDate(p) !== null) && /\d{4}/.test(v))) return "date";
  if (lower === "status") return "select";
  if (/^(assign|owner|person|people|created by|last edited by)/.test(lower)) return "person";
  if (/(files|attachments|media)/.test(lower)) return "files";
  const distinct = new Set(filled);
  const tokens = filled.flatMap((v) => v.split(/,\s*/));
  const distinctTokens = new Set(tokens);
  if (filled.some((v) => v.includes(", ")) && distinctTokens.size <= Math.max(3, tokens.length * 0.7) && [...distinctTokens].every((t) => t.length <= 60)) return "multi_select";
  if (/^(tags|labels|categories)$/.test(lower)) return "multi_select";
  if (distinct.size <= Math.max(2, Math.min(30, filled.length * 0.6)) && [...distinct].every((v) => v.length <= 60 && !v.includes("\n")) && filled.length > distinct.size) return "select";
  return "text";
}

function stripLeadingTitle(blocks: Block[], title: string): Block[] {
  const first = blocks[0];
  if (first?.type === "heading" && Number(first.props?.level) === 1) {
    const text = (first.content ?? []).map((c) => (c.t === "text" || c.t === "ref" ? c.text : "")).join("").trim();
    if (!title || text === title || notionTitle(text) === title) return blocks.slice(1);
  }
  return blocks;
}

function stripPropertyLines(md: string, columns: string[]): string {
  if (!columns.length) return md;
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (/^#\s/.test(lines[i] ?? "")) i++;
  const start = i;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const names = new Set(columns.map((c) => c.toLowerCase()));
  let end = i;
  while (end < lines.length) {
    const m = /^([^:]{1,120}):\s?(.*)$/.exec(lines[end]!);
    if (!m || !names.has(m[1]!.trim().toLowerCase())) break;
    end++;
  }
  if (end === i) return md;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function htmlIcon(dom: HNode): string {
  const header = find(dom, (n) => n.tag === "header");
  const icon = header ? find(header, (n) => (n.attrs.class ?? "").split(/\s+/).includes("page-header-icon")) : null;
  return icon ? textContent(icon).trim().slice(0, 16) : "";
}

export async function notionPlan(vfs: Vfs): Promise<Plan> {
  const files = vfs.files;
  const index = new LinkIndex(files);
  const nodes = new Map<string, ImportNode>();
  const csvs = files.filter((f) => extOf(f.path) === "csv");
  const allCsv = new Set(csvs.filter((f) => /_all\.csv$/i.test(f.path)).map((f) => keyOf(f.path)));
  const pages = files.filter((f) => /\.(md|html?)$/i.test(f.path) && !/(^|\/)index\.html$/i.test(f.path));
  const parentKeyOf = (key: string): string | null => {
    for (let d = dirOf(key); d; d = dirOf(d)) {
      if (nodes.has(d)) return d;
      const db = rowDirs.get(d);
      if (db) return db;
    }
    return null;
  };
  let warnings = 0;
  let complete = true;
  const dbColumns = new Map<string, string[]>();
  const dirsWithFiles = new Set<string>();
  for (const f of files) for (let d = dirOf(f.path); d; d = dirOf(d)) dirsWithFiles.add(d);
  const pageKeys = new Set(pages.map((f) => keyOf(f.path)));
  const rowDirs = new Map<string, string>();
  const rowsDirOf = (key: string): string | null => {
    if (dirsWithFiles.has(key)) return key;
    if (!NOTION_ID.test(stemOf(key))) return null;
    const dir = dirOf(key);
    const plain = joinPath(dir, notionTitle(stemOf(key)));
    return plain && dirsWithFiles.has(plain) && !pageKeys.has(plain) && !rowDirs.has(plain) ? plain : null;
  };
  const isDatabaseCsv = (path: string, key: string) => /_all\.csv$/i.test(path) || allCsv.has(key) || NOTION_ID.test(stemOf(key)) || pageKeys.has(key) || rowsDirOf(key) !== null;
  for (const csv of csvs) {
    const key = keyOf(csv.path);
    if (allCsv.has(key) && !/_all\.csv$/i.test(csv.path)) continue;
    if (nodes.has(key) && nodes.get(key)!.kind === "database") continue;
    if (!isDatabaseCsv(csv.path, key)) continue;
    let rows: string[][];
    try {
      rows = parseCsv(decodeText(await vfs.read(csv.path, IMPORT_LIMITS.textBytes)), IMPORT_LIMITS.rows + 1, IMPORT_LIMITS.columns);
    } catch {
      warnings++;
      complete = false;
      continue;
    }
    const header = rows[0] ?? [];
    if (!header.length) continue;
    const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    const names = header.map((h, i) => h.trim() || `Column ${i + 1}`);
    const columns: Column[] = names.map((name, i) => ({ name, type: i === 0 ? "text" : guessType(name, body.map((r) => r[i] ?? "")) }));
    dbColumns.set(key, names);
    const db: ImportNode = { key, parent: null, title: notionTitle(stemOf(key)), kind: "database", icon: "", columns, path: csv.path, blocks: [] };
    nodes.set(key, db);
    index.addPage(db, [csv.path, key, `${key}.md`, `${key}.html`]);
    const rowsDir = rowsDirOf(key);
    if (rowsDir !== null && rowsDir !== key) {
      rowDirs.set(rowsDir, key);
      dbColumns.set(rowsDir, names);
    }
    const rowFiles = rowsDir === null ? [] : pages.filter((f) => dirOf(f.path) === rowsDir);
    const matched = matchRows(body.map((r) => (r[0] ?? "").trim() || "Untitled"), rowFiles.map((f) => f.path));
    const csvRows = body.map((r) => {
      const cells: Record<string, string> = {};
      names.forEach((name, i) => {
        if (i > 0) cells[name] = r[i] ?? "";
      });
      return { title: (r[0] ?? "").trim() || "Untitled", cells };
    });
    const csvIds = rowIdentities(csvRows.map((row, n) => (matched[n] ? null : row)));
    body.forEach((_r, n) => {
      const { title, cells } = csvRows[n]!;
      const file = matched[n] ?? null;
      const rowKey = file ? keyOf(file) : `${key}/#row:${csvIds[n]}`;
      const row: ImportNode = { key: rowKey, parent: key, title, kind: "page", cells, path: file ?? csv.path, blocks: file ? undefined : [] };
      nodes.set(rowKey, row);
      if (file) index.addPage(row, [file, rowKey]);
    });
    const taken = new Set(matched.filter((m): m is string => !!m));
    for (const f of rowFiles) {
      if (taken.has(f.path) || nodes.has(keyOf(f.path))) continue;
      const row: ImportNode = { key: keyOf(f.path), parent: key, title: notionTitle(stemOf(f.path)), kind: "page", cells: {}, path: f.path };
      nodes.set(row.key, row);
      index.addPage(row, [f.path, row.key]);
    }
  }
  for (const f of pages) {
    if (!/\.html?$/i.test(f.path)) continue;
    const key = keyOf(f.path);
    if (nodes.has(key) || !dirsWithFiles.has(key)) continue;
    let dom: HNode;
    try {
      dom = parseDom(decodeText(await vfs.read(f.path, IMPORT_LIMITS.textBytes)));
    } catch {
      complete = false;
      continue;
    }
    const table = find(dom, (n) => n.tag === "table" && (n.attrs.class ?? "").includes("collection-content"));
    if (!table) continue;
    const head = find(table, (n) => n.tag === "thead");
    const names = (head ? findAll(head, (n) => n.tag === "th") : []).map((th, i) => textContent(th).trim() || `Column ${i + 1}`).slice(0, IMPORT_LIMITS.columns);
    const bodyRows = findAll(find(table, (n) => n.tag === "tbody") ?? table, (n) => n.tag === "tr").slice(0, IMPORT_LIMITS.rows);
    const cellsOf = bodyRows.map((tr) => findAll(tr, (n) => n.tag === "td"));
    const columns: Column[] = names.map((name, i) => ({ name, type: i === 0 ? "text" : guessType(name, cellsOf.map((c) => (c[i] ? textContent(c[i]!).trim() : ""))) }));
    const db: ImportNode = { key, parent: null, title: notionTitle(stemOf(key)), kind: "database", columns, path: f.path, blocks: [] };
    db.load = loader(vfs, index, f.path, db, []);
    db.blocks = undefined;
    nodes.set(key, db);
    index.addPage(db, [f.path, key]);
    const htmlRows = cellsOf.map((cells) => {
      const first = cells[0];
      const link = first ? find(first, (x) => x.tag === "a") : null;
      let href = link?.attrs.href ?? "";
      try {
        href = decodeURIComponent(href);
      } catch {}
      const file = href ? joinPath(dirOf(f.path), href) : null;
      const title = (first ? textContent(first).trim() : "") || "Untitled";
      const values: Record<string, string> = {};
      names.forEach((name, i) => {
        if (i > 0) values[name] = cells[i] ? textContent(cells[i]!).replace(/\s+/g, " ").trim() : "";
      });
      return { file: file && index.hasFile(file) ? file : null, title, cells: values, link: file };
    });
    const htmlIds = rowIdentities(htmlRows.map((row) => (row.file ? null : row)));
    htmlRows.forEach(({ file: linked, title, cells: values, link }, n) => {
      const file = link;
      const rowKey = linked ? keyOf(linked) : `${key}/#row:${htmlIds[n]}`;
      const row: ImportNode = { key: rowKey, parent: key, title, kind: "page", cells: values, path: file ?? f.path, blocks: rowKey.includes("/#row") ? [] : undefined };
      nodes.set(rowKey, row);
      if (file) index.addPage(row, [file, rowKey]);
    });
  }
  const sorted = [...pages].sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1));
  for (const f of sorted) {
    const key = keyOf(f.path);
    if (nodes.has(key)) {
      const existing = nodes.get(key)!;
      if (existing.blocks === undefined || existing.kind === "database") {
        existing.load = loader(vfs, index, f.path, existing, dbColumns.get(dirOf(key)) ?? []);
        if (existing.kind === "database") existing.blocks = undefined;
      }
      continue;
    }
    if (nodes.size >= IMPORT_LIMITS.pages) break;
    const node: ImportNode = { key, parent: null, title: notionTitle(stemOf(f.path)), kind: "page", path: f.path };
    node.load = loader(vfs, index, f.path, node, []);
    nodes.set(key, node);
    index.addPage(node, [f.path, key]);
  }
  for (const node of nodes.values()) if (node.parent === null) node.parent = parentKeyOf(node.key);
  for (const node of nodes.values()) if (node.kind === "database" && node.load) {
    const load = node.load;
    node.load = async () => (await load()).filter((b) => b.type !== "table");
  }
  for (const node of nodes.values()) if (node.blocks === undefined && !node.load) node.blocks = [];
  const list = [...nodes.values()];
  return {
    nodes: list.length ? list : [{ key: "empty", parent: null, title: "Nothing to import", kind: "page", blocks: [para("No Notion pages were found. Choose the .zip from Export all workspace content.")] }],
    link: (target, from) => index.page(target, from.path ?? from.key),
    asset: (src, from) => index.asset(src, from.path ?? from.key),
    readAsset: (path) => vfs.read(path, IMPORT_LIMITS.attachmentBytes),
    assetSize: (path) => index.size(path),
    assetFingerprint: (path) => {
      const print = vfs.fingerprint?.(path);
      return print ? `${exportRelative(path)}:${print.slice(path.length + 1)}` : null;
    },
    stableKey: (node) => notionStableKey(node.key),
    prefetch: vfs.prefetch ? (paths) => vfs.prefetch!(paths) : undefined,
    warnings,
    complete,
  };
}

const EXPORT_FOLDER = /^Export-[0-9a-f-]{8,}\//i;

const exportRelative = (path: string) => path.replace(EXPORT_FOLDER, "");

export function rowIdentities(rows: ({ title: string; cells: Record<string, string> } | null)[]): string[] {
  const titles = new Map<string, number>();
  for (const row of rows) if (row) titles.set(row.title, (titles.get(row.title) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (!row) return "";
    if (titles.get(row.title) === 1) return `t-${printOf(row.title)}`;
    const content = `c-${printOf(JSON.stringify([row.title, Object.entries(row.cells).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]))}`;
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    return n ? `${content}-${n}` : content;
  });
}

export function notionStableKey(key: string): string | null {
  if (key === "empty") return null;
  const row = /^(.*)\/#row(?::([a-z0-9-]+)|(\d+))$/.exec(key);
  if (row) {
    const table = notionStableKey(row[1]!);
    return table ? (row[2] ? `${table}:row:${row[2]}` : `${table}:row${row[3]}`) : null;
  }
  const id = NOTION_ID.exec(stemOf(key))?.[1];
  return id ? id.toLowerCase() : `path:${exportRelative(key)}`;
}

const looseTitle = (title: string) => title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function matchRows(titles: string[], files: string[]): (string | null)[] {
  const left = files.map((path) => ({ path, title: looseTitle(notionTitle(stemOf(path))), used: false }));
  const matched: (string | null)[] = titles.map(() => null);
  const wanted = titles.map(looseTitle);
  const take = (n: number, fits: (file: { title: string }) => boolean) => {
    const file = left.find((f) => !f.used && fits(f));
    if (!file) return;
    file.used = true;
    matched[n] = file.path;
  };
  wanted.forEach((title, n) => take(n, (f) => f.title === title));
  wanted.forEach((title, n) => {
    if (matched[n] === null && title) take(n, (f) => f.title.length >= 4 && title.startsWith(f.title));
  });
  return matched;
}

function loader(vfs: Vfs, index: LinkIndex, path: string, node: ImportNode, columns: string[]) {
  const fileLink = (url: string) => {
    const asset = index.asset(url, path);
    return asset !== null && !/\.(md|markdown|html?)$/i.test(asset) && index.pageAt(asset) === null && index.pageAt(keyOf(asset)) === null;
  };
  return async (): Promise<Block[]> => {
    const raw = decodeText(await vfs.read(path, IMPORT_LIMITS.textBytes));
    if (/\.html?$/i.test(path)) {
      const dom = parseDom(raw);
      const icon = htmlIcon(dom);
      if (icon) node.icon = icon;
      const blocks = htmlBlocks(dom, raw);
      const collection = findAll(dom, (n) => n.tag === "table" && (n.attrs.class ?? "").includes("collection-content"));
      return collection.length ? blocks.filter((b) => b.type !== "table") : blocks;
    }
    const md = stripPropertyLines(raw, columns);
    return stripLeadingTitle(parseMarkdown(md, { wikilinks: false, fileLink }), node.title);
  };
}
