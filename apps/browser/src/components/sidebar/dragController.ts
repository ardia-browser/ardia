import { layout } from "../ui/theme";
import { Animated, type GestureResponderEvent, type View } from "react-native";
import { NO_DROP } from "../../state/drag/drops";
import { dropTabs } from "../../state/pins/actions";
import { movingTabsFrom } from "../../state/sidebar/current";
import type { TabPlacement } from "../../state/pins/placing";
import { SLIDE } from "../tabstrip/tokens";
import { beginTabDrag, cancelTabDrag, endTabDrag, setDragPicture, updateTabDrag } from "../../state/drag/tabDrag";
import { dropTabsInProfile, dropTabsInProfileOnceConfirmed, tabDropAsksFirst } from "../../state/browser/actions";
import { noteDragWithoutDrop, noteSidebarDrop } from "../../state/telemetry/tabPresses";
import { dropTabOnRow } from "../../state/splits/actions";
import { arrangeLive } from "../../state/sidebar/pinnedOrder";
import { suppressHover } from "../../state/sidebar/hover";
import { closeFolderPanel } from "../../state/sidebar/tileFolderUi";
import { dragMarksOf, markDrag } from "../../state/sidebar/dragMarks";
import { boxed, type Drop, EDGE, type Item, measure, tabCell, tailKey } from "./dragModel";
import { DragTargeting } from "./dragTargeting";
import { type DragSession, newDragSession, NO_TARGET } from "./dragGeometry";
import { captureEscape } from "../../state/drag/dragNative";
import { entryKey } from "../../state/sidebar/entryKey";
import { endHeldTabPress } from "../../state/sidebar/heldTabPress";
import { tabPlace } from "../../state/sidebar/actions";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class DragController extends DragTargeting {
  create(key: string): Item {
    return { key, kind: "row", tabIds: [], section: "list", view: null, header: null, gap: new Animated.Value(0), frame: null, headerFrame: null };
  }

  get active() {
    return !!this.session?.sources.length;
  }

  async begin(key: string, x: number, y: number) {
    const item = this.items.get(key);
    if (!item || item.kind === "tail") return;
    const lead = tabCell(item) ? item.tabIds[0] : undefined;
    const moving = lead ? movingTabsFrom(lead) : [];
    const sources = moving.length > 1 ? [...this.items.values()].filter((i) => tabCell(i) && i.tabIds.some((id) => moving.includes(id))) : [item];
    this.stopTimers();
    const session = (this.session = newDragSession(sources, { x, y }, this.scrollY, this.pageId));
    this.token = {};
    suppressHover(true);
    session.escapable = true;
    captureEscape("sidebarDrag", true);
    let seq = 0;
    if (tabCell(item)) {
      const single = sources.length === 1 ? (item.tabIds[0] ?? null) : null;
      seq = beginTabDrag(single, [...new Set(sources.flatMap((i) => i.tabIds))]);
    }
    const measured = await this.measureAll(session);
    if (this.session !== session) return;
    const frame = (measured ? item.frame : null) ?? { x, y, w: 176, h: 33 };
    const grab = (session.grab = { x: x - frame.x, y: y - frame.y });
    const count = new Set(sources.flatMap((s) => s.tabIds)).size;
    const height = boxed(item) ? Math.min(frame.h, item.headerFrame?.h ?? 33) : frame.h;
    if (seq) setDragPicture(seq, () => [session.pointer.x - grab.x, session.pointer.y - grab.y, frame.w, height], [x, y]);
    session.ghost = {
      item,
      count,
      width: frame.w,
      height,
      grab,
      position: new Animated.ValueXY({ x: frame.x - this.rootFrame.x, y: frame.y - this.rootFrame.y }),
    };
    this.setLanding(null);
    this.setSources(new Set(sources.map((s) => s.key)));
    this.setGhost(session.ghost);
    this.startTargeting(session);
  }

  async beginExternal(count: number, x: number, y: number) {
    if (this.active && !this.session!.external) return;
    this.reset();
    this.setGhost(null);
    const session = (this.session = newDragSession([this.create("external")], { x, y }, this.scrollY));
    session.external = Math.max(1, count);
    this.token = {};
    suppressHover(true);
    await this.measureAll(session);
    if (this.session !== session) return;
    this.setLanding(null);
    this.startTargeting(session);
  }

  showPage(pageId: string) {
    if (this.pageId === pageId) return;
    this.pageId = pageId;
    if (this.session) void this.turnPage(this.session);
  }

  rowsArrived() {
    if (this.session?.turned) void this.turnPage(this.session);
  }

  protected startTargeting(session: DragSession) {
    if (session.turn) return;
    session.measured = true;
    this.move(session.pointer.x, session.pointer.y);
  }

  protected async turnPage(session: DragSession) {
    const turn = (session.turn = {});
    if (!session.turned) session.movedFromHome = this.movedKeys(session.sources);
    session.turned = true;
    session.measured = false;
    this.stopTimers();
    this.forgetTarget(session);
    await nextFrame();
    if (this.session !== session || session.turn !== turn) return;
    if (!(await this.measureAll(session))) return;
    for (const source of session.sources) source.frame = source.headerFrame = null;
    session.turn = null;
    if (session.ghost || session.external) this.startTargeting(session);
  }

  finishExternal(commit: boolean): TabPlacement | null {
    const session = this.session;
    if (!session?.external) return null;
    const drop = session.measured ? session.drop : NO_DROP;
    this.reset();
    this.token = null;
    this.setLanding(null);
    return commit && drop.type === "tabs" ? drop.placement : null;
  }

  async tilesLaidOut() {
    const session = this.session;
    const pass = session?.measuring;
    const frame = await measure(this.regions.get("tiles") ?? null);
    if (!session || this.session !== session || session.measuring !== pass) return;
    session.regionFrames.set("tiles", frame);
    if (session.measured) this.retarget();
  }

  protected async measureAll(session: DragSession): Promise<boolean> {
    const pass = (session.measuring = {});
    const items = [...this.items.values()];
    const regions = [...this.regions];
    const [rootFrame, viewport, itemFrames, regionFrames] = await Promise.all([
      measure(this.root),
      measure(this.scroll as unknown as View),
      Promise.all(items.map((i) => Promise.all([measure(i.view), measure(i.header)]))),
      Promise.all(regions.map(([, view]) => measure(view))),
    ]);
    if (this.session !== session || session.measuring !== pass) return false;
    this.rootFrame = rootFrame ?? this.rootFrame;
    session.viewport = viewport;
    session.startScrollY = this.scrollY;
    items.forEach((i, n) => ([i.frame, i.headerFrame] = itemFrames[n]!));
    regions.forEach(([name], n) => session.regionFrames.set(name, regionFrames[n]!));
    session.gridBase = items.some((i) => i.kind === "tile") ? (session.regionFrames.get("tiles") ?? null) : null;
    session.gridGrowth = 0;
    return true;
  }

  move(x: number, y: number) {
    const session = this.session;
    if (session) session.pointer = { x, y };
    updateTabDrag(x, y);
    if (!session || (!session.ghost && !session.external)) return;
    if (session.ghost) session.ghost.position.setValue({ x: this.ghostX(x), y: y - session.grab.y - this.rootFrame.y });
    if (!session.measured) return;
    this.autoScroll(y);
    this.retarget();
  }

  end(commit: boolean, release: GestureResponderEvent | null = null) {
    const session = this.session;
    if (session?.external) return void this.finishExternal(false);
    if (!session?.sources.length) return endHeldTabPress([], null);
    const { sources, drop, ghost, measured, into } = session;
    const splitDrop = commit ? endTabDrag() : (cancelTabDrag(), false);
    const marks = dragMarksOf(this.marks);
    const leftPanel = sources[0]?.section === "folder" && marks.folderAway;
    const dragged = sources.flatMap((i) => i.tabIds);
    const places = dragged.map(tabPlace).join();
    const elsewhere = this.crossingTo(session);
    const asksFirst = !!elsewhere && tabDropAsksFirst(dragged, elsewhere);
    const spot =
      !splitDrop && !asksFirst && measured && ghost && sources.length === 1 && sources[0]!.kind !== "tile" && sources[0]!.section !== "folder" && !into && drop.type !== "split" && drop.type !== "folder"
        ? this.landingSpot(commit ? drop : NO_DROP)
        : null;
    const dropped = commit && !splitDrop && measured && sources.length > 0;
    if (dropped && drop.type === "none") noteDragWithoutDrop();
    if (dropped && drop.type === "split") {
      const made = dropTabOnRow(dragged[0]!, drop.targetId, drop.side);
      if (made) noteSidebarDrop(drop.side === "left" ? "split_left" : "split_right");
      if (made?.adopted === "row") noteSidebarDrop("split_pinned");
      else if (made?.adopted === "list") noteSidebarDrop("split_unpinned");
    } else if (dropped) {
      const kind = marks.tile ? "tile" : marks.line ? "line" : null;
      if (kind && drop.type !== "none") noteSidebarDrop(kind);
      if (elsewhere) this.dropElsewhere(dragged, ghost?.item.tabIds[0], elsewhere, drop, asksFirst);
      else {
        dropTabs(dragged, drop);
        if (drop.sequence) arrangeLive(drop.sequence);
      }
    }
    this.reset();
    const moved = dragged.map(tabPlace).join() !== places;
    const stayed = commit && !splitDrop && !into && !elsewhere && !moved;
    endHeldTabPress(dragged, stayed ? release : null);
    if (leftPanel) closeFolderPanel();
    if (!spot || !ghost) {
      this.token = null;
      this.setLanding(null);
      this.setGhost(null);
      return;
    }
    const token = (this.token = {});
    this.setLanding(moved ? ghost.item.key : null);
    this.setGhost({ ...ghost, landing: true });
    const done = () => {
      if (this.token !== token) return;
      this.token = null;
      this.setLanding(null);
      this.setGhost(null);
    };
    if (__DEV__) this.landed = spot && { key: ghost.item.key, x: spot.x, y: spot.y };
    Animated.spring(ghost.position, { toValue: { x: spot.x - this.rootFrame.x, y: spot.y - this.rootFrame.y }, ...SLIDE }).start(done);
  }

  protected dropElsewhere(dragged: string[], lead: string | undefined, profileId: string, drop: Drop, asksFirst: boolean) {
    if (drop.type === "none") return;
    const leadFirst = lead ? [lead, ...dragged.filter((id) => id !== lead)] : dragged;
    const arrange = (moved: boolean) => {
      if (moved && drop.sequence) arrangeLive(drop.sequence);
    };
    if (asksFirst) void dropTabsInProfileOnceConfirmed(leadFirst, profileId, drop).then(arrange);
    else arrange(dropTabsInProfile(leadFirst, profileId, drop));
  }

  protected stopTimers() {
    clearInterval(this.session?.scrollTimer);
    this.clearHold();
  }

  protected reset() {
    const session = this.session;
    this.stopTimers();
    this.closeGaps();
    this.session = null;
    if (session?.escapable) captureEscape("sidebarDrag", false);
    suppressHover(false);
    this.setSources(new Set());
    markDrag(this.marks, NO_TARGET);
  }

  protected landingSpot(drop: Drop): { x: number; y: number } | null {
    const { sources, gapKey } = this.drag;
    const source = sources[0]!;
    if (drop.type === "tabs" && drop.placement.pinned && !drop.placement.row) return null;
    const target = drop.type !== "none" && gapKey ? this.items.get(gapKey) : undefined;
    const home = this.at(source.frame, this.still(source));
    const to = target && this.at(target.frame, this.still(target));
    if (!target?.frame || !to) return home && { x: home.x, y: home.y };
    const group = source.parentGroup ? this.items.get(entryKey("group", source.parentGroup)) : undefined;
    const insideGroup = !!source.parentGroup && (target.parentGroup === source.parentGroup || target.key === tailKey({ group: source.parentGroup }));
    const emptied = !!group?.frame && group !== target && !insideGroup && group.tabIds.every((id) => source.tabIds.includes(id));
    const leaving = emptied ? group! : source;
    const above = !!leaving.frame && leaving.frame.y < target.frame.y;
    const container = target.kind === "tail" ? [...this.items.values()].find((i) => i !== source && i.kind !== "tail" && i.frame && i.section === target.section && i.parentGroup === target.parentGroup) : target;
    return {
      x: (container?.frame && this.at(container.frame, this.still(container))?.x) ?? to.x,
      y: to.y + (target.kind === "tail" ? layout.rowGap : 0) - (above ? leaving.frame!.h + layout.rowGap : 0),
    };
  }

  protected autoScroll(y: number) {
    const session = this.drag;
    const v = session.viewport;
    const speed = !v ? 0 : y < v.y + EDGE ? -Math.ceil((v.y + EDGE - y) / 4) : y > v.y + v.h - EDGE ? Math.ceil((y - (v.y + v.h - EDGE)) / 4) : 0;
    clearInterval(session.scrollTimer);
    session.scrollTimer = undefined;
    if (!speed || !this.scroll) return;
    session.scrollTimer = setInterval(() => {
      const next = Math.max(0, this.scrollY + speed);
      if (next === this.scrollY) return;
      this.scroll?.scrollTo({ y: next, animated: false });
      this.scrollY = next;
      this.retarget();
    }, 16);
  }

  protected ghostX(x: number): number {
    const left = x - this.drag.grab.x - this.rootFrame.x;
    const source = this.drag.sources[0];
    const home = source?.frame;
    if (!home || !source || !boxed(source)) return left;
    return home.x - this.rootFrame.x;
  }
}
