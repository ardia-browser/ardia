import { layout } from "../ui/theme";
import { currentSettings } from "../../state/browser/current";
import { NO_DROP, type DragSource } from "../../state/drag/drops";
import { descendantGroupIds, resolveDropNow, splitsOnRowNow, tabsMovableTo } from "../../state/sidebar/current";
import { tabDragOutside } from "../../state/drag/tabDrag";
import { dragMarksOf, markDrag } from "../../state/sidebar/dragMarks";
import { folderPanel } from "../../state/sidebar/tileFolderUi";
import { overPins, pinGrid, pinGridHeight } from "./pinZone";
import { boxed, type Drop, FOLDER_HOLD_MS, folderOf, inside, type Item, pinnedBlock, spring, tabCell } from "./dragModel";
import { aimAt, type Pointing } from "./dragZones";
import { DragGeometry } from "./dragGeometry";
import { hapticTick } from "../../state/drag/dragNative";
import { entryKey } from "../../state/sidebar/entryKey";

export class DragTargeting extends DragGeometry {
  protected clearHold() {
    const hold = this.session?.hold;
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.timer = undefined;
    hold.key = null;
    hold.ready = null;
  }

  protected holdOver(target: Item) {
    const session = this.drag;
    const { hold } = session;
    if (hold.key === target.key) return;
    this.clearHold();
    hold.key = target.key;
    if (folderOf(target)) return void (hold.ready = target.key);
    if (!currentSettings().topAppFolders) return;
    hold.timer = setTimeout(() => {
      if (this.session !== session || hold.key !== target.key || !session.sources.length) return;
      hold.ready = target.key;
      this.retarget();
    }, FOLDER_HOLD_MS);
  }

  protected byY = (a: Item, b: Item) => this.at(a.frame, this.still(a))!.y - this.at(b.frame, this.still(b))!.y || a.frame!.x - b.frame!.x;

  protected movedKeys(sources: Item[]): string[] {
    return sources
      .filter((s) => s.frame)
      .sort(this.byY)
      .flatMap((s) => (s.kind === "group" || s.kind === "live" || s.kind === "split" ? [s.key] : s.tabIds.map((id) => entryKey("tab", id))));
  }

  protected retarget() {
    const session = this.drag;
    const { x, y } = session.pointer;
    const { sources, external, regionFrames } = session;
    const source = sources[0]!;
    const sourceKeys = new Set(sources.map((s) => s.key));
    const subtree = source.kind === "group" ? new Set([source.groupId, ...descendantGroupIds(source.groupId)]) : null;
    const live = [...this.items.values()].filter(
      (i) => !sourceKeys.has(i.key) && i.frame && !(subtree && ((i.parentGroup && subtree.has(i.parentGroup)) || (i.kind === "group" && subtree.has(i.groupId)))),
    );
    const cy = (i: Item) => {
      const f = this.shown(i);
      return f.y + Math.min(f.h, i.headerFrame?.h ?? f.h) / 2;
    };
    const { byY } = this;
    const dragged = new Set(sources.flatMap((s) => s.tabIds));
    const firstTab = (i: Item | undefined) => i?.tabIds.find((id) => !dragged.has(id)) ?? null;
    const tabsDrag = source.kind === "row" || source.kind === "tile";
    const elsewhere = this.crossingTo(session);
    const splits = this.splitView && tabsDrag && !external && !elsewhere && sources.length === 1 && dragged.size === 1 && !folderOf(source);
    const count = external || (folderOf(source) ? 1 : dragged.size);
    const rowPitch = (boxed(source) ? source.foldedHeight() : layout.rowHeight * (source.kind === "split" ? 1 : Math.max(1, session.ghost?.count ?? external ?? 1))) + layout.rowGap;
    const blocks = live.filter(pinnedBlock).sort(byY);
    const moved = session.turned ? session.movedFromHome : this.movedKeys(sources);
    const dragSource: DragSource = {
      kind: source.kind === "group" || source.kind === "split" || source.kind === "live" ? source.kind : "tab",
      groupId: source.kind === "group" ? source.groupId : undefined,
      folderId: folderOf(source),
      external: !!external,
    };

    const sidebar = session.viewport ?? this.rootFrame;
    const tiles = this.at(regionFrames.get("tiles") ?? null, this.tilesFixed);
    const balanced = currentSettings().balancedTopApps;
    const away = x > sidebar.x + sidebar.w + 40 || x < sidebar.x - 40 || tabDragOutside();
    const cells = live.filter((i) => i.kind === "tile").sort(byY);
    const { gridBase } = session;
    const overTiles = !away && tabsDrag && !!tiles && (gridBase ? overPins(y, this.pinFloor(live, tiles), this.pinning) : inside(tiles, x, y, 6));
    if (gridBase)
      session.gridGrowth = Math.min(pinGridHeight(cells.length + (overTiles ? count : 0), gridBase.w, layout.pinnedHeight, balanced), this.tilesFixed ? this.tilesRoom : Infinity) - gridBase.h;
    const list = this.at(regionFrames.get("list") ?? null);
    const panel = folderPanel();
    const panelFrame = panel ? (regionFrames.get("folder") ?? null) : null;
    const wasAway = dragMarksOf(this.marks).folderAway;
    const inPanel = !away && !wasAway && tabsDrag && !external && !!panelFrame && inside(panelFrame, x, y);
    const folderAway = source.section === "folder" && !inPanel;
    const canFolder = tabsDrag && !external && !folderOf(source);
    const home = source.section === "tiles" && source.frame ? cells.filter((c) => byY(c, source) < 0).length : null;
    const spot = !away && tabsDrag && overTiles && tiles ? this.pointed(tiles, cells, count, home, x, y, canFolder) : null;
    const target = spot?.part === "centre" ? spot.cell : null;
    if (target) this.holdOver(target);
    else this.clearHold();

    const pointing: Pointing = {
      x,
      y,
      source,
      live,
      cy,
      byY,
      firstTab,
      tabsDrag,
      external: !!external,
      blocks,
      moved,
      away,
      inPanel,
      held: target && session.hold.ready === target.key ? target : null,
      overTiles,
      tiles,
      spot,
      cells,
      count,
      balanced,
      grid: !!gridBase,
      inPinned: !!list && y < list.y,
      kept: { gapKey: session.gapKey, pitch: session.pitch },
      shown: (i) => this.shown(i),
      at: (f) => this.at(f),
      splits,
      splitTarget: () => {
        const hit = this.splitTarget(live, x, y);
        const lead = [...dragged][0];
        return hit && lead && splitsOnRowNow(lead, this.items.get(hit.key)!.tabIds[0]!) ? hit : null;
      },
      overPinnedRows: () => this.overPinnedRows(y),
      leadTab: (key) => this.items.get(key)!.tabIds[0]!,
    };
    const aim = aimAt(pointing);
    const carried = elsewhere === null || (sources.every(tabCell) && tabsMovableTo([...dragged], elsewhere).length > 0);
    const resolved = carried ? resolveDropNow(dragSource, aim.spot) : NO_DROP;
    const drop: Drop = resolved.type !== "none" && aim.sequence ? { ...resolved, sequence: aim.sequence } : resolved;
    const dropped = drop.type !== "none";
    const gapKey = dropped ? aim.gapKey : null;
    const pitch = aim.pitch ?? rowPitch;
    const into = dropped ? (aim.into ?? null) : null;
    const split = drop.type === "split" ? (aim.split ?? null) : null;
    const folderTarget = aim.folderTarget ?? null;
    const line = dropped && !into && drop.type !== "split" && (drop.type !== "folder" || inPanel) && gapKey ? this.lineAt(this.items.get(gapKey)) : null;

    const listRow = live.find((i) => i.kind === "row" && i.section === "list" && !i.parentGroup)?.frame ?? list;
    const row = source.kind === "tile" && !folderOf(source) && !overTiles && dropped && listRow ? { w: listRow.w, h: layout.rowHeight } : null;
    const marks = dragMarksOf(this.marks);
    if (folderAway !== marks.folderAway) markDrag(this.marks, { folderAway });
    if (JSON.stringify(line) !== JSON.stringify(marks.line)) markDrag(this.marks, { line });
    if (JSON.stringify(row) !== JSON.stringify(marks.row)) markDrag(this.marks, { row });
    const key = JSON.stringify(drop);
    if (key === session.dropKey && gapKey === session.gapKey) return;
    if (session.dropKey && drop.type !== "none") hapticTick();
    session.dropKey = key;
    session.drop = drop;
    session.into = into;
    const pins = drop.type === "tabs" && drop.placement.pinned && !drop.placement.row;
    const held = drop.type === "folder" && !inPanel;
    const tile = (pins || held) && source.kind === "row" && tiles ? { w: pinGrid(cells.length + count, tiles.w, balanced).width, h: layout.pinnedHeight } : null;
    markDrag(this.marks, { dropInto: into, split, tile, folderTarget, pins: pins || held, pinCount: pins || held ? count : 0, pinBefore: pins || held ? gapKey : null });
    if (gapKey !== session.gapKey) {
      const prev = session.gapKey && this.items.get(session.gapKey);
      if (prev && this.opensGap(prev)) spring(prev.gap, 0).start();
      const next = gapKey && this.items.get(gapKey);
      if (next && this.opensGap(next)) spring(next.gap, pitch).start();
      session.gapKey = gapKey;
      session.pitch = pitch;
    }
  }
}
