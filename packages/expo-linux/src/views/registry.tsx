import { forwardRef, useEffect, type ComponentType } from "react";
import { View, type ViewProps } from "react-native";
import * as engine from "../engine/modules";
import { noteMissing } from "../missing";
import { ActivitySpinner } from "../web/motion/ActivitySpinner";
import { DockSelection, GlassEffect, GlassGroup, OutsidePressArea, VisualEffect } from "../web/chrome";
import { FadeLabel } from "../web/FadeLabel";
import { SwipeArea } from "../web/Pager";
import { Symbol } from "../web/Symbol";
import { WindowDragRegion } from "../windows/dragRegion";
import { ContextMenuArea, MouseArea, PopoverBubble, Surface } from "./adapters";
import { FileDrop } from "./fileDrop";
import { PowerUp, WindowBackdrop } from "./shaders";

type ViewByName = ComponentType<never> & { displayName?: string };

const engineViews: Record<string, ViewByName> = (engine as { engineViews?: Record<string, ViewByName> }).engineViews ?? {};

const PlainView = forwardRef<View, ViewProps>(function PlainView(props, ref) {
  return <View {...props} ref={ref} />;
});

const drawnOnLinux: Record<string, ViewByName> = {
  ArdiaSymbol: Symbol as ViewByName,
  ArdiaFadeLabel: FadeLabel as ViewByName,
  ArdiaActivitySpinner: ActivitySpinner as ViewByName,
  ArdiaSurface: Surface as ViewByName,
  ArdiaVisualEffect: VisualEffect as ViewByName,
  ArdiaGlassEffect: GlassEffect as ViewByName,
  ArdiaGlassGroup: GlassGroup as ViewByName,
  ArdiaPopoverBubble: PopoverBubble as ViewByName,
  ArdiaDockSelection: DockSelection as ViewByName,
  ArdiaOutsidePressArea: OutsidePressArea as ViewByName,
  ArdiaContextMenuArea: ContextMenuArea as ViewByName,
  ArdiaFileDrag: MouseArea as ViewByName,
  ArdiaAppWindows: WindowDragRegion as ViewByName,
  ArdiaSwipe: SwipeArea as ViewByName,
  ArdiaWindowBackdrop: WindowBackdrop as ViewByName,
  ArdiaPowerUp: PowerUp as ViewByName,
  ArdiaClipView: PlainView as ViewByName,
  ArdiaWindowProfile: PlainView as ViewByName,
  ArdiaFileDrop: FileDrop as ViewByName,
  ArdiaMagnifyArea: PlainView as ViewByName,
};

const views = new Map<string, ViewByName>();

function placeholderFor(name: string): ViewByName {
  return forwardRef<View, ViewProps>(function Placeholder(props, ref) {
    useEffect(() => noteMissing(`<${name}>`), []);
    return <View {...props} pointerEvents={props.pointerEvents ?? "box-none"} ref={ref} />;
  }) as ViewByName;
}

export function viewNamed<Props>(name: string): ComponentType<Props> {
  let made = views.get(name);
  if (!made) {
    made = engineViews[name] ?? drawnOnLinux[name] ?? placeholderFor(name);
    made.displayName ??= name;
    views.set(name, made);
  }
  return made as unknown as ComponentType<Props>;
}
