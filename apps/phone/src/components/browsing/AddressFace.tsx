import type { Ref } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedProps, useAnimatedStyle } from "react-native-reanimated";
import { destination, destinationAddresses, destinationStandsIn } from "../../state/browse/destination";
import { pageBarPreviewShown } from "../../state/browse/deckPull";
import { usePageBusy } from "../../state/page/hooks";
import { chromeInk, Favicon, floatingBarLayout, Symbol, usePressStyle } from "../ui";
import { privateMark } from "../ui/IncognitoSpecs";
import { spokenAddress, type BarAddress } from "./FloatingBar";
import { NotSecureLock } from "./NotSecureLock";

type Props = { address: BarAddress | null; dark: boolean; testIDPrefix: string; style: StyleProp<ViewStyle>; onPress: () => void; onPressIn?: () => void; pressRef?: Ref<ViewInstance> };

export type SpokenValue = Partial<{ accessibilityValue: { text: string } }>;

type PressStyle = ReturnType<typeof usePressStyle>;

function PressableWithPressStyle({ pressStyle, style: _animatedStyle, ...rest }: Omit<PressableProps, "style"> & { style?: unknown; pressStyle: PressStyle; ref?: Ref<ViewInstance> }) {
  return <Pressable {...rest} style={pressStyle} />;
}

const AnimatedPressable = Animated.createAnimatedComponent(PressableWithPressStyle);

export function AddressFace({ address, dark, testIDPrefix, style, onPress, onPressIn, pressRef, spoken }: Props & { spoken?: SpokenValue }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const pressStyle = usePressStyle("text", { style });
  const busy = usePageBusy(address?.tabId ?? null);
  const glyphs = <AddressGlyphs address={address} ink={ink} testIDPrefix={testIDPrefix} />;
  if (spoken)
    return (
      <AnimatedPressable ref={pressRef as never} accessibilityRole="button" accessibilityLabel="Address" accessibilityValue={{ text: spokenAddress(address) }} accessibilityState={{ busy }} accessibilityHint="Opens search with this page’s address." onPress={onPress} onPressIn={onPressIn} animatedProps={spoken} style={pressStyle as never} pressStyle={pressStyle}>
        {glyphs}
      </AnimatedPressable>
    );
  return (
    <Pressable ref={pressRef} accessibilityRole="button" accessibilityLabel="Address" accessibilityValue={{ text: spokenAddress(address) }} accessibilityState={{ busy }} accessibilityHint="Opens search with this page’s address." onPress={onPress} onPressIn={onPressIn} style={pressStyle}>
      {glyphs}
    </Pressable>
  );
}

function AddressGlyphs({ address, ink, testIDPrefix }: { address: BarAddress | null; ink: { secondary: string; notSecure: string; foreground: string }; testIDPrefix: string }) {
  return (
    <>
      {address?.isPrivate ? <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID={`${testIDPrefix}NotSecure`} size={floatingBarLayout.siteIcon} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={floatingBarLayout.siteIcon} />
      ) : null}
      <Text testID={`${testIDPrefix}Host`} maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
        {address?.host ?? ""}
      </Text>
    </>
  );
}

export function AddressLeaf({ address, dark, testIDPrefix, style }: { address: Props["address"]; dark: boolean; testIDPrefix: string; style?: Props["style"] }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  return (
    <View style={[styles.leaf, style]} pointerEvents="none">
      {address?.isPrivate ? <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID={`${testIDPrefix}NotSecure`} size={floatingBarLayout.siteIcon} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={floatingBarLayout.siteIcon} />
      ) : null}
      <Text testID={`${testIDPrefix}Host`} maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
        {address?.host ?? ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  leaf: { flexDirection: "row", alignItems: "center" },
  leafStack: { flex: 1, flexDirection: "row" },
  privateGlyph: { overflow: "hidden" },
  hostField: { padding: 0, margin: 0 },
  host: { flexShrink: 1, fontSize: floatingBarLayout.hostText },
});

const AnimatedHost = Animated.createAnimatedComponent(TextInput);

export function DestinationFallbackLeaf({ shownId, leafId, dark, style }: { shownId: string; leafId: string | null; dark: boolean; style?: Props["style"] }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const shows = useAnimatedStyle(() => {
    const lifted = destination.id.value;
    const previewShown = pageBarPreviewShown.value;
    return { opacity: destinationStandsIn(lifted, shownId, previewShown) && lifted !== leafId ? 1 : 0 };
  }, [shownId, leafId]);
  const privateGlyph = useAnimatedStyle(() => {
    const lifted = destination.id.value;
    const table = destinationAddresses.value;
    return { opacity: table[lifted]?.isPrivate ? 1 : 0, width: table[lifted]?.isPrivate ? floatingBarLayout.privateSymbol : 0 };
  });
  const host = useAnimatedProps(() => {
    const lifted = destination.id.value;
    const table = destinationAddresses.value;
    return { text: table[lifted]?.host ?? "" } as Record<string, string>;
  });
  return (
    <Animated.View testID="floatingBarDestinationLeaf" collapsable={false} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[StyleSheet.absoluteFill, styles.leafStack, shows]}>
      <View style={[styles.leaf, style]} pointerEvents="none">
        <Animated.View style={[styles.privateGlyph, privateGlyph]}>
          <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} />
        </Animated.View>
        <AnimatedHost testID="floatingBarDestinationHost" editable={false} caretHidden underlineColorAndroid="transparent" maxFontSizeMultiplier={floatingBarLayout.maxTextScale} animatedProps={host} style={[styles.host, styles.hostField, { color: ink.foreground }]} />
      </View>
    </Animated.View>
  );
}
