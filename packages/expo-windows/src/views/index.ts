import { ActivitySpinner } from "./ActivitySpinner";
import { Breathe } from "./Breathe";
import { ClipView } from "./ClipView";
import { ThemeSwatch, WindowBackdrop } from "./backdrop";
import { DockSelection } from "./DockSelection";
import { EdgeFadeMask } from "./EdgeFadeMask";
import { FadeLabel } from "./FadeLabel";
import { FolderIcon } from "./FolderIcon";
import { ContextMenuArea, FileDrop, MagnifyArea, MouseArea, OutsidePressArea, WindowProfile } from "./inputAreas";
import { GlassEffect, GlassGroup, PopoverBubble, VisualEffect } from "./materials";
import { PageCoverGate } from "./PageCoverGate";
import { PeekStage } from "./PeekStage";
import type { ViewByName } from "./shared";
import { Surface } from "./Surface";
import { SvgIcon } from "./SvgIcon";
import { SwipeArea } from "../pager/SwipeArea";
import { MeadowPage } from "../meadow/MeadowPage";

export { OutsidePressRoot } from "./inputAreas";

export const viewsDrawnInJs = new Map<string, ViewByName>([
  ["ArdiaSurface", Surface],
  ["ArdiaClipView", ClipView],
  ["ArdiaPageCoverGate", PageCoverGate],
  ["ArdiaPeekStage", PeekStage],
  ["ArdiaFadeLabel", FadeLabel],
  ["ArdiaEdgeFadeMask", EdgeFadeMask],
  ["ArdiaActivitySpinner", ActivitySpinner],
  ["ArdiaBreathe", Breathe],
  ["ArdiaVisualEffect", VisualEffect],
  ["ArdiaGlassEffect", GlassEffect],
  ["ArdiaGlassGroup", GlassGroup],
  ["ArdiaPopoverBubble", PopoverBubble],
  ["ArdiaWindowBackdrop", WindowBackdrop],
  ["ArdiaContextMenuArea", ContextMenuArea],
  ["ArdiaOutsidePressArea", OutsidePressArea],
  ["ArdiaFileDrag", MouseArea],
  ["ArdiaMagnifyArea", MagnifyArea],
  ["ArdiaFileDrop", FileDrop],
  ["ArdiaThemeSwatch", ThemeSwatch],
  ["ArdiaDockSelection", DockSelection],
  ["ArdiaFolderIcon", FolderIcon],
  ["ArdiaSvgIcon", SvgIcon],
  ["ArdiaWindowProfile", WindowProfile],
  ["ArdiaSwipe", SwipeArea],
  ["ArdiaMeadowPage", MeadowPage],
]);
