import { layout } from "../ui/theme";
import { Animated, type GestureResponderEvent, type View } from "react-native";
import { NO_DROP } from "../../state/drag/drops";
import { dropTabs } from "../../state/pins/actions";
import { dragHomeOf, movingTabsFrom, profileBeside } from "../../state/sidebar/current";
import type { TabPlacement } from "../../state/pins/placing";
import { SLIDE } from "../tabstrip/tokens";
import { beginTabDrag, cancelTabDrag, endTabDrag, setDragPicture, updateTabDrag } from "../../state/drag/tabDrag";
import { noteDragProfileSwitch, noteDragWithoutDrop, noteSidebarDrop } from "../../state/telemetry/tabPresses";
import { dropTabOnRow } from "../../state/splits/actions";
import { arrangeLive } from "../../state/sidebar/pinnedOrder";
import { suppressHover } from "../../state/sidebar/hover";
import { closeFolderPanel } from "../../state/sidebar/tileFolderUi";
import { dragMarksOf, markDrag } from "../../state/sidebar/dragMarks";
import { boxed, type Drop, EDGE, type Item, measure, tabCell, tailKey } from "./dragModel";
import { DragTargeting } from "./dragTargeting";
import { edgeAt, edgeStep } from "./dragProfiles";
import { type DragSession, newDragSession } from "./dragGeometry";
import { captureEscape, hapticTick } from "../../state/drag/dragNative";
import { entryKey } from "../../state/sidebar/entryKey";
import { endHeldTabPress } from "../../state/sidebar/heldTabPress";
import { tabPlace } from "../../state/sidebar/actions";
import { dropTabsInProfile, switchProfile } from "../../state/browser/actions";

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
    const session = (this.session = newDragSession(sources, { x, y }, this.scrollY));
    session.shown = this.profile;
    const crossing = sources.every((i) => tabCell(i) && i.section !== "folder");
    session.home = crossing ? dragHomeOf([...new Set(sources.flatMap((i) => i.tabIds))]) : null;
    this.token = {};
    suppressHover(true);
    session.escapable = true;
    captureEscape("sidebarDrag", true);
    let seq = 0;
    if (tabCell(item)) {
      const single = sources.length === 1 ? (item.tabIds[0] ?? null) : null;
      seq = beginTabDrag(single, [...new Set(sources.flatMap((i) => i.tabIds))]);
    }
    await this.measureAll(session);
    if (this.session !== session) return;
    const frame = item.frame ?? { x, y, w: 176, h: 33 };
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
    session.measured = true;
    this.move(session.pointer.x, session.pointer.y);
  }

  async beginExternal(count: number, x: number, y: number) {
    if (this.active && !this.session!.external) return;
    this.reset();
    this.setGhost(null);
    const session = (this.session = newDragSession([this.create("external")], { x, y }, this.scrollY));
    session.shown = this.profile;
    session.external = Math.max(1, count);
    this.token = {};
    suppressHover(true);
    await this.measureAll(session);
    if (this.session !== session) return;
    this.setLanding(null);
    session.measured = true;
    this.move(session.pointer.x, session.pointer.y);
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
    const frame = await measure(this.regions.get("tiles") ?? null);
    if (!session || this.session !== session) return;
    session.regionFrames.set("tiles", frame);
    this.retarget();
  }

  protected async measureAll(session: DragSession) {
    const [rootFrame, viewport] = await Promise.all([measure(this.root), measure(this.scroll as unknown as View)]);
    this.rootFrame = rootFrame ?? this.rootFrame;
    session.viewport = viewport;
    session.startScrollY = this.scrollY;
    await Promise.all(
      [...this.items.values()].map(async (i) => {
        [i.frame, i.headerFrame] = await Promise.all([measure(i.view), measure(i.header)]);
      }),
    );
    for (const [name, view] of this.regions) session.regionFrames.set(name, await measure(view));
    const grid = [...this.items.values()].some((i) => i.kind === "tile");
    session.gridBase = grid ? (session.regionFrames.get("tiles") ?? null) : null;
    session.gridGrowth = 0;
    if (session.home) await this.profiles.measure();
  }

  profileShown(profileId: string) {
    this.profile = profileId;
    const session = this.session;
    if (!session || session.shown === profileId) return;
    const was = session.shown;
    session.shown = profileId;
    if (was === null) return;
    if (!session.home && !session.external) return this.abandon();
    if (session.home) noteDragProfileSwitch(session.hopping?.id === profileId ? session.hopping.by : null);
    session.hopping = null;
    void this.remeasure(session);
  }

  abandon() {
    if (!this.active || this.session!.external) return;
    this.end(false);
    this.token = null;
    this.setLanding(null);
    this.setGhost(null);
  }

  protected async remeasure(session: DragSession) {
    this.stopTimers();
    for (const i of this.items.values()) {
      i.gap.stopAnimation();
      i.gap.setValue(0);
    }
    Object.assign(session, { measured: false, gapKey: null, pitch: 0, into: null, dropKey: "", drop: NO_DROP, overProfile: null });
    markDrag(this.marks, { dropInto: null, split: null, line: null, tile: null, row: null, pins: false, pinCount: 0, pinBefore: null, folderTarget: null, folderAway: false });
    session.regionFrames.clear();
    const run = ++session.measures;
    await this.measureAll(session);
    if (this.session !== session || session.measures !== run) return;
    session.measured = true;
    this.move(session.pointer.x, session.pointer.y);
  }

  protected aimProfile(x: number, y: number) {
    const session = this.drag;
    const over = session.home ? this.profiles.under(x, y) : null;
    session.overProfile = over;
    if (dragMarksOf(this.marks).overProfiles !== !!over) markDrag(this.marks, { overProfiles: !!over });
    this.profiles.hold(over !== session.shown ? over : null, (id) => {
      const now = this.session;
      if (now !== session || !session.home || session.shown === id) return;
      session.hopping = { id, by: "icon" };
      hapticTick();
      switchProfile(session.home.windowId, id, true);
    });
  }

  protected aimEdge(x: number, y: number) {
    const session = this.drag;
    const side = session.home && !session.overProfile ? edgeAt(this.rootFrame, x, y) : null;
    if (!side) session.edgeSpent = false;
    session.edge = side;
    const beside = side && !session.edgeSpent && session.shown ? profileBeside(session.shown, edgeStep(side)) : null;
    this.edges.hold(beside ? side : null, (held) => {
      const next = this.session === session && session.home && session.shown ? profileBeside(session.shown, edgeStep(held)) : null;
      if (!next || !session.home) return;
      session.edgeSpent = true;
      session.hopping = { id: next, by: "edge" };
      hapticTick();
      switchProfile(session.home.windowId, next, true);
    });
  }

  move(x: number, y: number) {
    const session = this.session;
    if (session) session.pointer = { x, y };
    updateTabDrag(x, y);
    if (!session?.measured || (!session.ghost && !session.external)) return;
    if (session.ghost) session.ghost.position.setValue({ x: this.ghostX(x), y: y - session.grab.y - this.rootFrame.y });
    this.aimProfile(x, y);
    this.aimEdge(x, y);
    this.autoScroll(session.overProfile ? null : y);
    this.retarget();
  }

  interrupt() {
    this.end(false, null, true);
  }

  end(commit: boolean, release: GestureResponderEvent | null = null, interrupted = false) {
    const session = this.session;
    if (session?.external) return void this.finishExternal(false);
    if (!session?.sources.length) return endHeldTabPress([], null);
    const { sources, drop, ghost, measured, into, home, shown, overProfile } = session;
    const crossed = !!home && shown !== home.profileId;
    const toIcon = commit && measured && !!home && !!overProfile && overProfile !== home.profileId ? overProfile : null;
    const elsewhere = crossed || !!toIcon;
    const splitDrop = commit && !toIcon ? endTabDrag() : (cancelTabDrag(), false);
    const marks = dragMarksOf(this.marks);
    const leftPanel = sources[0]?.section === "folder" && marks.folderAway;
    const spot =
      !splitDrop && !elsewhere && measured && ghost && sources.length === 1 && sources[0]!.kind !== "tile" && sources[0]!.section !== "folder" && !into && drop.type !== "split" && drop.type !== "folder"
        ? this.landingSpot(commit ? drop : NO_DROP)
        : null;
    const dragged = sources.flatMap((i) => i.tabIds);
    const places = dragged.map(tabPlace).join();
    const dropped = commit && !splitDrop && measured && sources.length > 0;
    if (dropped && drop.type === "none" && !toIcon) noteDragWithoutDrop();
    if (home && toIcon) void dropTabsInProfile(dragged, toIcon, NO_DROP, home.profileId, true);
    else if (home && crossed) {
      if (dropped && drop.type === "tabs") void dropTabsInProfile(dragged, shown!, drop, home.profileId, false);
      else if (!splitDrop && !interrupted) switchProfile(home.windowId, home.profileId, true);
    } else if (dropped && drop.type === "split") {
      const made = dropTabOnRow(dragged[0]!, drop.targetId, drop.side);
      if (made) noteSidebarDrop(drop.side === "left" ? "split_left" : "split_right");
      if (made?.adopted === "row") noteSidebarDrop("split_pinned");
      else if (made?.adopted === "list") noteSidebarDrop("split_unpinned");
    } else if (dropped) {
      const kind = marks.tile ? "tile" : marks.line ? "line" : null;
      if (kind && drop.type !== "none") noteSidebarDrop(kind);
      dropTabs(dragged, drop);
      if (drop.sequence) arrangeLive(drop.sequence);
    }
    this.reset();
    const moved = dragged.map(tabPlace).join() !== places;
    const stayed = commit && !splitDrop && !into && !moved && !elsewhere;
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

  protected stopTimers() {
    clearInterval(this.session?.scrollTimer);
    this.clearHold();
    this.profiles.release();
    this.edges.release();
  }

  protected reset() {
    const session = this.session;
    this.stopTimers();
    for (const i of this.items.values()) {
      i.gap.stopAnimation();
      i.gap.setValue(0);
    }
    this.session = null;
    if (session?.escapable) captureEscape("sidebarDrag", false);
    suppressHover(false);
    this.setSources(new Set());
    markDrag(this.marks, { dropInto: null, split: null, line: null, tile: null, row: null, pins: false, pinCount: 0, pinBefore: null, folderTarget: null, folderAway: false, profileHold: null, overProfiles: false, edgeHold: null });
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

  protected autoScroll(y: number | null) {
    const session = this.drag;
    const v = session.viewport;
    const speed = !v || y === null ? 0 : y < v.y + EDGE ? -Math.ceil((v.y + EDGE - y) / 4) : y > v.y + v.h - EDGE ? Math.ceil((y - (v.y + v.h - EDGE)) / 4) : 0;
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
