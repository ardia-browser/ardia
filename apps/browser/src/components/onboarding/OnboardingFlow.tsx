import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import { WheelArea, WindowDragRegion } from "../ui";
import { space } from "../ui/tokens";
import { trafficLightsDrawn } from "../../lib/windowChrome";
import { useWindowFullScreen, useWindowId } from "../../state/browser/hooks";
import { useTrafficLightsCenterY } from "../../state/windows/nativeWindow";
import { QUESTIONS, useOnboarding, type QuestionId } from "../../state/onboarding/onboarding";
import { isWebDemo } from "../../state/onboarding/demoSteps";
import { sectionIndexOf, useSections, type OnboardingSection } from "../../state/onboarding/sections";
import { RedoCancel } from "./Parts";
import { PreviewStage } from "./PreviewStage";
import { SectionScroller, sectionKey, type SectionScrollerHandle } from "./SectionScroller";
import { createFlowSlots, createMockFocus, FlowPreviewShownContext, FlowSlotsContext, MockFocusContext, useFlowShown, useFlowSlots, type FlowShown } from "./sectionContext";
import { onboardingFlow } from "./tokens";
import { ThemeGradient } from "./ThemeGradient";
import { SourceStep } from "./SourceStep";
import { LayoutStep, TabsStep } from "./LayoutSteps";
import { LookStep } from "./LookStep";
import { SearchPrivacyStep } from "./PrivacyStep";
import { PinnedTabsStep } from "./PinnedTabsStep";
import { HomeStep } from "./HomeStep";
import { PluginsStep } from "./PluginsStep";
import { OutroStep } from "./OutroStep";
import { SetupCodeOutro } from "./SetupCodeOutro";

const FLOW_KEYS = [{ key: "ArrowUp" }, { key: "ArrowDown" }, { key: "PageUp" }, { key: "PageDown" }];
const KEY_DIRECTION: Record<string, 1 | -1> = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 };
const TEXT_FIELD = /^(INPUT|TEXTAREA|SELECT)$/;
const LOOK_QUESTIONS = new Set<QuestionId>(QUESTIONS.look.map((q) => q.id).concat("color", "style"));

function fromTextField(event: object) {
  const target = (event as { target?: unknown }).target;
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  return TEXT_FIELD.test(element.tagName ?? "") || !!element.isContentEditable;
}

function renderSection(section: OnboardingSection) {
  if (LOOK_QUESTIONS.has(section.id)) return <LookStep />;
  switch (section.step) {
    case "source":
      return <SourceStep />;
    case "layout":
      return <LayoutStep />;
    case "tabs":
      return <TabsStep />;
    case "look":
      return <LookStep />;
    case "searchPrivacy":
      return <SearchPrivacyStep />;
    case "pins":
      return <PinnedTabsStep />;
    case "home":
      return <HomeStep />;
    case "plugins":
      return <PluginsStep />;
    case "outro":
      return isWebDemo ? <SetupCodeOutro /> : <OutroStep />;
  }
}

export function OnboardingFlow() {
  const sections = useSections();
  const step = useOnboarding((s) => s.step);
  const sub = useOnboarding((s) => s.sub);
  const active = sectionIndexOf(sections, step, sub);
  const activeSection = sections[active];
  const [slots] = useState(createFlowSlots);
  const [focus] = useState(createMockFocus);
  const activeKey = activeSection ? sectionKey(activeSection) : null;
  useLayoutEffect(() => focus.show(activeKey), [activeKey]);
  const [width, setWidth] = useState(0);
  const scroller = useRef<SectionScrollerHandle>(null);
  const keys = useRef<View>(null);
  const showPreview = width >= onboardingFlow.previewBelow;

  useEffect(() => {
    keys.current?.focus();
  }, [active]);

  return (
    <FlowSlotsContext.Provider value={slots}>
      <MockFocusContext.Provider value={focus}>
        <WheelArea style={{ flex: 1 }} onStep={(direction) => scroller.current?.move(direction, "wheel")}>
          <View
            ref={keys}
            focusable
            enableFocusRing={false}
            keyDownEvents={FLOW_KEYS}
            onKeyDown={(e: NativeSyntheticEvent<{ key: string }>) => {
              const direction = KEY_DIRECTION[e.nativeEvent.key];
              if (direction && !fromTextField(e.nativeEvent)) scroller.current?.move(direction, "key");
            }}
            mouseDownCanMoveWindow={false}
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            style={{ flex: 1, flexDirection: "row", justifyContent: showPreview ? "flex-start" : "center" }}
          >
            <ThemeGradient />
            <View style={{ width: Math.min(onboardingFlow.column, width || onboardingFlow.column) }}>
              <FlowHeader />
              <FlowPreviewShownContext.Provider value={showPreview}>
                <SectionScroller ref={scroller} sections={sections} active={active} render={renderSection} />
              </FlowPreviewShownContext.Provider>
              <ActionBar />
            </View>
            {showPreview ? <PreviewStage /> : null}
          </View>
        </WheelArea>
      </MockFocusContext.Provider>
    </FlowSlotsContext.Provider>
  );
}

function centeredOnLights(lightsY: number | null): ViewStyle | null {
  if (lightsY === null) return null;
  const shift = Math.max(-onboardingFlow.titleBar / 2, Math.min(onboardingFlow.titleBar / 2, 2 * lightsY - onboardingFlow.titleBar));
  return shift > 0 ? { paddingTop: shift } : { paddingBottom: -shift };
}

function FlowHeader() {
  const windowId = useWindowId();
  const fullScreen = useWindowFullScreen(windowId);
  const lightsY = useTrafficLightsCenterY(trafficLightsDrawn() && !fullScreen ? windowId : null);
  return (
    <View style={[{ height: onboardingFlow.titleBar, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: onboardingFlow.columnPad }, centeredOnLights(lightsY)]}>
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      <RedoCancel />
    </View>
  );
}

function ActionBar() {
  const shown = useFlowShown();
  const slots = useFlowSlots();
  const last = useRef<FlowShown | null>(null);
  if (last.current !== shown) {
    last.current = shown;
    slots.forward.run = null;
  }
  return (
    <View style={{ height: onboardingFlow.barHeight, flexDirection: "row", alignItems: "center", gap: space.ml, paddingHorizontal: onboardingFlow.columnPad }}>
      {shown?.actions}
    </View>
  );
}
