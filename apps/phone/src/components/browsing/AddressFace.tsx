import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { usePageBusy } from "../../state/page/hooks";
import { chromeInk, Favicon, floatingBarLayout, Symbol, usePressStyle } from "../ui";
import { privateMark } from "../ui/IncognitoSpecs";
import { spokenAddress, type BarAddress } from "./FloatingBar";
import { NotSecureLock } from "./NotSecureLock";

type Props = { address: BarAddress | null; dark: boolean; testIDPrefix: string; style: StyleProp<ViewStyle>; onPress: () => void; onPressIn?: () => void };

export function AddressFace({ address, dark, testIDPrefix, style, onPress, onPressIn }: Props) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const pressStyle = usePressStyle("text", { style });
  const busy = usePageBusy(address?.tabId ?? null);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Address" accessibilityValue={{ text: spokenAddress(address) }} accessibilityState={{ busy }} accessibilityHint="Opens search with this page’s address." onPress={onPress} onPressIn={onPressIn} style={pressStyle}>
      {address?.isPrivate ? <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID={`${testIDPrefix}NotSecure`} size={floatingBarLayout.siteIcon} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={floatingBarLayout.siteIcon} />
      ) : null}
      <Text testID={`${testIDPrefix}Host`} maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
        {address?.host ?? ""}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { flexShrink: 1, fontSize: floatingBarLayout.hostText },
});
