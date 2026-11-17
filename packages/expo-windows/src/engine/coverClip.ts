import { createContext, type Ref } from "react";
import type { NativeMethods } from "react-native";
import { setCover, type Box } from "./covers";

export type Measurable = Pick<NativeMethods, "measureInWindow">;

export type CoverClip = { node: () => Measurable | null; watch(listener: () => void): () => void };

export const CoverClips = createContext<readonly CoverClip[]>([]);

export const PageCovering = createContext(true);

export function assignRef<Node>(target: Ref<Node> | undefined, node: Node | null) {
  if (typeof target === "function") target(node);
  else if (target) target.current = node;
}

export function coverClip(node: () => Measurable | null): CoverClip & { moved(): void } {
  const listeners = new Set<() => void>();
  return {
    node,
    watch(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    moved() {
      for (const listener of [...listeners]) listener();
    },
  };
}

export function watchClips(clips: readonly CoverClip[], listener: () => void): () => void {
  const unwatch = clips.map((clip) => clip.watch(listener));
  return () => unwatch.forEach((stop) => stop());
}

export function clipBox(box: Box, clips: readonly Box[]): Box | null {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  for (const clip of clips) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

const boxOf = (node: Measurable) => new Promise<Box>((resolve) => node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height })));

export function coverMeasurer(windowId: string, id: string, radius: number, node: () => Measurable | null, clips: readonly CoverClip[], covering = true) {
  let stopped = false;
  type Pass = { own: Measurable; clipNodes: Measurable[]; dirty: boolean; done: Promise<void>; cancel(): void };
  let active: Pass | null = null;
  const clipNodesNow = () => clips.map((clip) => clip.node()).filter((clip): clip is Measurable => !!clip);
  const same = (a: readonly Measurable[], b: readonly Measurable[]) => a.length === b.length && a.every((item, i) => item === b[i]);
  const measure = (): Promise<void> => {
    const own = node();
    if (!own || stopped || !covering) {
      active?.cancel();
      if (!covering) setCover(windowId, id, null);
      return Promise.resolve();
    }
    const clipNodes = clipNodesNow();
    if (active) {
      if (active.own === own && same(active.clipNodes, clipNodes)) {
        active.dirty = true;
        return active.done;
      }
      active.cancel();
    }
    let finish!: () => void;
    let released = false;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const pass: Pass = { own, clipNodes, dirty: false, done, cancel() {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      if (active === pass) active = null;
      finish();
    } };
    const complete = (boxes?: Box[]) => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      if (active === pass) active = null;
      if (!stopped && node() === own && same(clipNodes, clipNodesNow()) && boxes) {
        const visible = clipBox(boxes[0]!, boxes.slice(1));
        setCover(windowId, id, visible && { ...visible, radius });
      }
      if (!stopped && pass.dirty) void measure().then(finish);
      else finish();
    };
    const timeout = setTimeout(() => complete(), 100);
    active = pass;
    void Promise.all([own, ...clipNodes].map(boxOf)).then(complete, () => complete());
    return done;
  };
  return {
    measure,
    stop() {
      stopped = true;
      active?.cancel();
    },
  };
}
