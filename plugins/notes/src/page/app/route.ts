import { pageIdFromPath } from "../../shared/model";

export type Route =
  | { kind: "root" }
  | { kind: "home" }
  | { kind: "page"; page: string; block: string | null; view: string | null; peek: string | null }
  | { kind: "search"; query: string }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "missing"; path: string };

export function parseRoute(path: string): Route {
  const [pathname = "/", search = ""] = path.split("?");
  const params = new URLSearchParams(search.split("#")[0]);
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  if (!first || first === "index.html") return { kind: "root" };
  if (first === "home") return { kind: "home" };
  if (first === "search") return { kind: "search", query: params.get("q") ?? "" };
  if (first === "trash") return { kind: "trash" };
  if (first === "settings") return { kind: "settings" };
  const page = pageIdFromPath(pathname);
  if (!page) return { kind: "missing", path };
  return { kind: "page", page, block: params.get("block"), view: params.get("v"), peek: params.get("p") };
}

export function withParams(path: string, params: Record<string, string | null | undefined>): string {
  const [pathname = "/", search = ""] = path.split("?");
  const out = new URLSearchParams(search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") out.delete(k);
    else out.set(k, v);
  }
  const query = out.toString();
  return query ? `${pathname}?${query}` : pathname;
}
