import { useState, type ReactNode } from "react";
import { cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import { settingsUI } from "@ardia/phone-native";
import { PlatformColor, useWindowDimensions, View } from "react-native";
import { Button, ContentUnavailableView, HStack, Image, Label, ProgressView, RNHostView, ShareLink, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityElement, accessibilityHint, accessibilityLabel, buttonStyle, font, foregroundStyle, frame, lineLimit, truncationMode } from "@expo/ui/swift-ui/modifiers";
import { actionWords, listWords } from "../../lib/sharedWords";
import { haptics } from "../../state/app/haptics";
import { Favicon, iconRoles, sfName, type modifierList } from "../ui";
import { loadingContract, useLoadingAnnouncement } from "../ui/ListStates";
import { listRowIconSide, listRowLayout, listRowTitleLines } from "./listSheetTokens";

export { listSheetWords } from "./listSheetWords";

type Modifiers = ReturnType<typeof modifierList>;

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const FILL = Number.MAX_SAFE_INTEGER;

export function useListRowIcon() {
  const { fontScale } = useWindowDimensions();
  return listRowIconSide(fontScale);
}

export const opensPage = (open: () => void) => () => {
  haptics.selection();
  open();
};

export type ListRowLeading = { favicon: { url: string; iconUrl?: string | null } } | { symbol: string };

type ListRowProps = {
  title: string;
  leading: ListRowLeading;
  subtitle?: ReactNode;
  label?: string;
  hint: string;
  titleTruncation?: "middle";
  minHeight?: number;
  rowModifiers?: Modifiers;
  onPress: () => void;
};

export function ListRow({ title, leading, subtitle, label, hint, titleTruncation, minHeight, rowModifiers = [], onPress }: ListRowProps) {
  const { fontScale } = useWindowDimensions();
  const side = listRowIconSide(fontScale);
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  return (
    <Button onPress={onPress} modifiers={[buttonStyle("plain"), accessibilityHint(hint)]}>
      <HStack alignment="center" spacing={listRowLayout.gap} modifiers={[frame({ maxWidth: FILL, minHeight, alignment: "leading" }), ...rowModifiers, accessibilityElement("combine"), ...(label ? [accessibilityLabel(label)] : [])]}>
        {"favicon" in leading ? (
          <RNHostView matchContents>
            <View style={{ width: side, height: side }}>
              <Favicon iconUrl={leading.favicon.iconUrl ?? null} pageUrl={leading.favicon.url} size={side} />
            </View>
          </RNHostView>
        ) : (
          <Image systemName={leading.symbol as never} size={side * listRowLayout.symbolShare} color={PlatformColor("secondaryLabel")} modifiers={[frame({ width: side, height: side }), accessibilityElement("ignore")]} />
        )}
        <VStack alignment="leading" spacing={listRowLayout.lineGap}>
          <Text modifiers={[font({ textStyle: "body" }), lineLimit(listRowTitleLines({ fontScale, titleWidth })), frame({ maxWidth: FILL, alignment: "leading" }), ...settingsUI.modifierList(settingsUI.onWidthChange(setTitleWidth)), ...(titleTruncation ? [truncationMode(titleTruncation)] : [])]}>{title}</Text>
          {typeof subtitle === "string" ? <ListRowSubtitle text={subtitle} /> : subtitle}
        </VStack>
        <Spacer />
      </HStack>
    </Button>
  );
}

export function ListRowSubtitle({ text }: { text: string }) {
  return <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY), lineLimit(listRowLayout.subtitleLines)]}>{text}</Text>;
}

export function LinkMenuItems({ url, onCopy }: { url: string; onCopy: () => void }) {
  return (
    <>
      <Button label={actionWords.copyLink} systemImage={sfName(iconRoles.copyLink)} onPress={onCopy} />
      <ShareLink item={cleanUrl(url)}>
        <Label title={actionWords.share} systemImage={sfName(iconRoles.share)} />
      </ShareLink>
    </>
  );
}

export function ListNoResults({ query, modifiers }: { query: string; modifiers?: Modifiers }) {
  return <ContentUnavailableView title={listWords.noResults} systemImage={sfName(iconRoles.noResults)} description={listWords.noResultsCue(query.trim())} modifiers={modifiers} />;
}

export function ListLoading({ label, modifiers, action }: { label?: string; modifiers?: Modifiers; action?: ReactNode }) {
  const contract = loadingContract(label);
  useLoadingAnnouncement(contract.label);
  return (
    <VStack spacing={listRowLayout.gap} modifiers={[frame({ maxWidth: FILL, maxHeight: FILL }), ...(modifiers ?? [])]}>
      <ProgressView modifiers={[accessibilityLabel(contract.label), accessibilityAddTraits(contract.nativeTraits)]}>
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(SECONDARY)]}>{contract.label}</Text>
      </ProgressView>
      {action}
    </VStack>
  );
}
