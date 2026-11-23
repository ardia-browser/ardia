import { useEffect, type ComponentType } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ActivitySpinner, space, VisualEffect, WindowDragRegion } from "../ui";
import { PageToolbar } from "../pages/PageLayout";
import { ChooseBody, ChooseFooter } from "./steps/ChooseStep";
import { DoneBody, DoneFooter } from "./steps/DoneStep";
import { ProfilesBody, ProfilesFooter } from "./steps/ProfilesStep";
import { ProgressBody, ProgressFooter } from "./steps/ProgressStep";
import { AccessBody, AccessFooter, SafariBody, SafariFooter } from "./steps/SafariStep";
import { UnlockBody, UnlockFooter } from "./steps/UnlockStep";
import { startImport, useImportFlow, type ImportFlow, type ImportStepName } from "../../state/import/flow";
import { useImportDevHandle } from "./importDevHandle";
import { importLayout, importMotion } from "./tokens";
import { useSettingsColors } from "../settings/useSettingsColors";
import { WINDOW_CONTROLS, windowControlsWidth } from "../../lib/windowChrome";
import { markCaptionRegions } from "../../state/windows/controls";
import { IMPORT_WINDOW_ID } from "../../state/settings/settingsWindows";
import { WindowControls } from "../window/WindowControls";
import { LeadingWindowControls } from "../window/LeadingWindowControls";
import { useWindowChrome } from "../../state/windows/windowButtons";

const CONTROLS_ROOM = WINDOW_CONTROLS.edge + windowControlsWidth(2) + WINDOW_CONTROLS.gap;

type StepView = ComponentType<{ flow: ImportFlow }>;

function Loading() {
  return <ActivitySpinner style={LOADING} />;
}

const STEPS: Record<ImportStepName, { Body: StepView; Footer: StepView | null }> = {
  loading: { Body: Loading, Footer: null },
  choose: { Body: ChooseBody, Footer: ChooseFooter },
  profiles: { Body: ProfilesBody, Footer: ProfilesFooter },
  unlock: { Body: UnlockBody, Footer: UnlockFooter },
  safari: { Body: SafariBody, Footer: SafariFooter },
  access: { Body: AccessBody, Footer: AccessFooter },
  progress: { Body: ProgressBody, Footer: ProgressFooter },
  done: { Body: DoneBody, Footer: DoneFooter },
};

export function ImportWindow() {
  const look = useSettingsColors();
  useWindowChrome();
  const flow = useImportFlow();
  useEffect(() => startImport(importMotion.doneDelay), []);
  useImportDevHandle(flow);
  useEffect(() => markCaptionRegions(IMPORT_WINDOW_ID, [[0, 0, CONTROLS_ROOM, importLayout.dragRegion]]), []);
  const { Body, Footer } = STEPS[flow.step.name];
  return (
    <View style={{ flex: 1, backgroundColor: look.windowFill }}>
      <VisualEffect material="windowBackground" blendingMode="behindWindow" style={StyleSheet.absoluteFill} />
      <WindowDragRegion style={{ position: "absolute", left: 0, right: 0, top: 0, height: importLayout.dragRegion }} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: importLayout.padX, paddingTop: importLayout.padTop, paddingBottom: space.xxl }}>
        <Body flow={flow} />
      </ScrollView>
      <PageToolbar size="footer" divider>
        {Footer ? <Footer flow={flow} /> : null}
      </PageToolbar>
      <WindowControls windowId={IMPORT_WINDOW_ID} centerY={importLayout.dragRegion / 2} size={WINDOW_CONTROLS.small} maximizable={false} />
      <LeadingWindowControls windowId={IMPORT_WINDOW_ID} centerY={importLayout.dragRegion / 2} size={WINDOW_CONTROLS.small} maximizable={false} />
    </View>
  );
}

const LOADING = { width: importLayout.loadingSpinner, height: importLayout.loadingSpinner, marginTop: importLayout.loadingTop, alignSelf: "center" } as const;
