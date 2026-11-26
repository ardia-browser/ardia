import { applyTreePatch, type TreeOp } from "@ardia/plugin-sdk/protocol";
import { checkPluginNode } from "../../lib/pluginNodes";
import type { PluginNode } from "../../lib/pluginProtocol";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { setPluginSurfaceTree, surfaceKey, surfaceRevs as revs, usePluginSurfaces } from "./surfaces";

const MAX_OPS = 2000;

export function noteSurfaceRev(plugin: string, surfaceId: string, rev: unknown) {
  const key = surfaceKey(plugin, surfaceId);
  if (typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0) revs.set(key, rev);
  else revs.delete(key);
}

export function patchSurfaces(plugin: string, targets: string[], params: Record<string, unknown>): Body {
  const { base, rev, ops } = params;
  if (typeof base !== "number" || typeof rev !== "number" || !Number.isSafeInteger(base) || !Number.isSafeInteger(rev) || rev <= base) return failure("bad_request", "surface.patch needs whole numbers base and rev, with rev after base.");
  if (!Array.isArray(ops) || ops.length > MAX_OPS) return failure("bad_request", `ops is a list of up to ${MAX_OPS} patch ops.`);
  const trees = usePluginSurfaces.getState().trees;
  const patched: [string, PluginNode][] = [];
  for (const target of targets) {
    const key = surfaceKey(plugin, target);
    const current = trees[key];
    if (!current || revs.get(key) !== base) {
      notePlugin("plugin_surface_patch_failures");
      return failure("failed", `surface ${target} is at another revision; send the whole tree.`);
    }
    let next: unknown;
    try {
      next = applyTreePatch(current as never, ops as TreeOp[]);
    } catch (error) {
      notePlugin("plugin_surface_patch_failures");
      return failure("bad_request", `the patch doesn't apply: ${(error as Error).message}`);
    }
    const checked = checkPluginNode(next);
    if (!checked.ok) return failure("bad_request", `the patched tree ${checked.problem}.`);
    patched.push([target, checked.tree]);
  }
  for (const [target, tree] of patched) {
    setPluginSurfaceTree(plugin, target, tree);
    revs.set(surfaceKey(plugin, target), rev);
  }
  notePlugin("plugin_surface_patches");
  return { result: { ok: true } };
}

export function forgetSurfaceRevs(plugin: string) {
  for (const key of [...revs.keys()]) if (key.startsWith(`${plugin}:`)) revs.delete(key);
}
