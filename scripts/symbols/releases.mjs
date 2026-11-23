import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildMap, parseMap, serializeMap } from "./symbol-map.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAG = /^(v\d+\.\d+\.\d+(-nightly\.\d+)?|engine-[0-9a-f]{12})$/;
const UUIDS_ASSET = /^[A-Za-z0-9._-]+-uuids\.txt$/;
const MAP_ASSET = /^[A-Za-z0-9._-]+-symbol-map\.tsv\.gz$/;
const DWARF_PATH = /^[A-Za-z0-9 ._()+-]+\.dSYM\/Contents\/Resources\/DWARF\/[A-Za-z0-9 ._()+-]+$/;

export function parseUuids(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const [uuid, arch, rel] = line.split("\t");
    if (UUID.test(uuid ?? "") && /^[a-z0-9_]+$/.test(arch ?? "") && DWARF_PATH.test(rel ?? "") && !rel.split("/").includes("..")) rows.push({ uuid, arch, rel });
  }
  return rows;
}

export function readMapFile(path) {
  const raw = readFileSync(path);
  return parseMap((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
}

export class SymbolStore {
  constructor({ cache, repo, fetch = globalThis.fetch, token, mapDirs = [], log = () => {}, tar = "tar" }) {
    this.cache = cache;
    this.repo = repo;
    this.fetch = fetch;
    this.token = token;
    this.mapDirs = mapDirs;
    this.log = log;
    this.tar = tar;
    this.loaded = new Map();
    this.index = null;
    for (const dir of ["maps", "uuids", "work"]) mkdirSync(join(cache, dir), { recursive: true });
  }

  mapPath(uuid) {
    return join(this.cache, "maps", `${uuid}.map.gz`);
  }

  loadCached(uuid) {
    if (this.loaded.has(uuid) || !existsSync(this.mapPath(uuid))) return;
    try {
      this.loaded.set(uuid, readMapFile(this.mapPath(uuid)));
    } catch (error) {
      this.log(`dropping the unreadable cached map for ${uuid}: ${error.message}`);
      rmSync(this.mapPath(uuid), { force: true });
    }
  }

  saveMap(map) {
    const path = this.mapPath(map.uuid);
    writeFileSync(`${path}.part`, gzipSync(serializeMap(map)));
    renameSync(`${path}.part`, path);
  }

  async get(url, api) {
    const headers = { "User-Agent": "ardia-symbolicate-frames" };
    if (api) headers.Accept = "application/vnd.github+json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(300_000) });
        if (res.ok) return res;
        if (res.status < 500 || attempt >= 3) throw Object.assign(new Error(`GET ${url}: HTTP ${res.status}`), { final: true });
      } catch (error) {
        if (error.final || attempt >= 3) throw error;
      }
      await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }

  assetUrl(tag, name) {
    return `https://github.com/${this.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  }

  importMapDirs() {
    for (const dir of this.mapDirs) {
      for (const name of readdirSync(dir)) {
        if (!/\.(map|map\.gz|tsv|tsv\.gz)$/.test(name)) continue;
        try {
          const map = readMapFile(join(dir, name));
          if (!existsSync(this.mapPath(map.uuid))) this.saveMap(map);
        } catch (error) {
          this.log(`skipping ${join(dir, name)}: ${error.message}`);
        }
      }
    }
  }

  async releaseIndex() {
    if (this.index) return this.index;
    const index = new Map();
    for (let page = 1; page <= 20; page++) {
      let releases;
      try {
        releases = await (await this.get(`https://api.github.com/repos/${this.repo}/releases?per_page=100&page=${page}`, true)).json();
      } catch (error) {
        if (!index.size) throw error;
        this.log(`release listing stopped at page ${page}, using the ${index.size} images found so far: ${error.message}`);
        return index;
      }
      if (!Array.isArray(releases) || !releases.length) break;
      for (const release of releases) {
        const tag = String(release?.tag_name ?? "");
        if (!TAG.test(tag)) continue;
        const names = (release.assets ?? []).map((a) => String(a?.name ?? ""));
        for (const name of names.filter((n) => MAP_ASSET.test(n))) await this.importMapAsset(tag, name);
        for (const name of names.filter((n) => UUIDS_ASSET.test(n))) {
          const archive = name.replace(/-uuids\.txt$/, "-symbols.tar.xz");
          if (!names.includes(archive)) continue;
          let text;
          try {
            text = await this.uuidsText(tag, name);
          } catch (error) {
            this.log(`skipping ${tag}/${name}: ${error.message}`);
            continue;
          }
          for (const row of parseUuids(text)) index.set(row.uuid, [...(index.get(row.uuid) ?? []), { ...row, tag, archive }]);
        }
      }
    }
    this.index = index;
    return index;
  }

  async uuidsText(tag, name) {
    const path = join(this.cache, "uuids", `${tag}--${name}`);
    if (existsSync(path)) return readFileSync(path, "utf8");
    const text = await (await this.get(this.assetUrl(tag, name))).text();
    writeFileSync(path, text);
    return text;
  }

  async importMapAsset(tag, name) {
    const marker = join(this.cache, "uuids", `${tag}--${name}.seen`);
    if (existsSync(marker) && existsSync(this.mapPath(readFileSync(marker, "utf8").trim()))) return;
    try {
      const raw = Buffer.from(await (await this.get(this.assetUrl(tag, name))).arrayBuffer());
      const map = parseMap(gunzipSync(raw).toString("utf8"));
      if (!existsSync(this.mapPath(map.uuid))) this.saveMap(map);
      writeFileSync(marker, map.uuid);
    } catch (error) {
      this.log(`skipping ${tag}/${name}: ${error.message}`);
    }
  }

  async buildFromRelease(entries) {
    const { tag, archive } = entries[0];
    const work = join(this.cache, "work", tag);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "x"), { recursive: true });
    try {
      const file = join(work, archive);
      this.log(`downloading ${tag}/${archive}`);
      const res = await this.get(this.assetUrl(tag, archive));
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      const rels = [...new Set(entries.map((e) => e.rel))];
      const run = spawnSync(this.tar, ["-xJf", file, "-C", join(work, "x"), "--", ...rels], { encoding: "utf8", maxBuffer: 1 << 24 });
      if (run.status !== 0) throw new Error(`couldn't unpack ${rels.join(", ")} from ${archive}: ${(run.stderr || run.error?.message || "").trim()}`);
      rmSync(file, { force: true });
      for (const entry of entries) {
        const dwarf = join(work, "x", entry.rel);
        if (!lstatSync(dwarf).isFile()) throw new Error(`${entry.rel} in ${archive} isn't a regular file`);
        const map = buildMap(readFileSync(dwarf), entry.uuid);
        this.saveMap(map);
        this.loaded.set(map.uuid, map);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async maps(uuids) {
    this.importMapDirs();
    const missing = [];
    for (const uuid of uuids) {
      this.loadCached(uuid);
      if (this.loaded.get(uuid)?.source !== "dsym") missing.push(uuid);
    }
    let index = null;
    if (missing.length) {
      try {
        index = await this.releaseIndex();
      } catch (error) {
        this.log(`couldn't list releases, using cached maps only: ${error.message}`);
      }
    }
    for (const uuid of missing) this.loadCached(uuid);
    if (index) {
      const failed = new Set();
      for (let round = 0; round < 8; round++) {
        const byArchive = new Map();
        for (const uuid of missing) {
          if (this.loaded.get(uuid)?.source === "dsym") continue;
          const entry = (index.get(uuid) ?? []).find((e) => !failed.has(`${e.tag}/${e.archive}`));
          if (!entry) continue;
          const key = `${entry.tag}/${entry.archive}`;
          byArchive.set(key, [...(byArchive.get(key) ?? []), entry]);
        }
        if (!byArchive.size) break;
        for (const [key, entries] of byArchive) {
          try {
            await this.buildFromRelease(entries);
          } catch (error) {
            failed.add(key);
            this.log(`no symbols from ${key}: ${error.message}`);
          }
        }
      }
    }
    return new Map(uuids.filter((u) => this.loaded.has(u)).map((u) => [u, this.loaded.get(u)]));
  }
}
