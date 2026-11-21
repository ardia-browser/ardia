import { displayHost, hostOf } from "@ardia/core";
import { memo, useState } from "react";
import { Image, View } from "react-native";
import { faviconFailed, useAppearanceDark, useFavicon, useFaviconTheme } from "../../state/favicons/favicons";
import { radius, Surface, Symbol, useTheme, weight } from "../ui";
import { CapCenteredLetter } from "../glyph/CapCenteredLetter";
import { bundledSiteIcon } from "./siteIcons";

export const Favicon = memo(function Favicon({
  url,
  favicon,
  size = 16,
  profileId,
  direct,
  grayscale = false,
  opacity = 1,
  fallbackColor,
}: {
  url: string;
  favicon?: string | null;
  size?: number;
  profileId?: string;
  direct?: boolean;
  grayscale?: boolean;
  opacity?: number;
  fallbackColor?: string;
}) {
  const theme = useTheme();
  useAppearanceDark();
  const cached = useFavicon(url, direct ? null : favicon, profileId);
  const resolved = direct && favicon ? { uri: favicon, profileId: "" } : cached;
  const shape = useFaviconTheme(theme.dark || direct ? "" : url, favicon, profileId);
  const white = shape?.kind === "template" && !!shape.stroke;
  const [broken, setBroken] = useState<string | null>(null);
  if (!url && !resolved) return <NewTabIcon size={size} opacity={opacity} />;
  if (!resolved || broken === resolved.uri) return <FaviconFallback url={url} size={size} opacity={opacity} color={fallbackColor} grayscale={grayscale} />;
  const image = (
    <Image
      key={white ? `${resolved.uri} tinted` : resolved.uri}
      source={{ uri: resolved.uri }}
      onError={() => {
        setBroken(resolved.uri);
        if (resolved.profileId) faviconFailed(resolved.profileId, resolved.uri);
      }}
      style={{ width: size, height: size, borderRadius: size > 18 ? radius.control : radius.hair, tintColor: white ? theme.textPrimary : undefined, opacity }}
    />
  );
  return grayscale ? <Surface grayscale style={{ width: size, height: size }}>{image}</Surface> : image;
});

export const SiteFavicon = memo(function SiteFavicon({ host, profileId, size }: { host: string; profileId: string; size?: number }) {
  const theme = useTheme();
  const url = `https://${host}`;
  if (bundledSiteIcon(url, theme.dark) !== undefined) return <Favicon url={url} size={size} />;
  return <Favicon url={url} favicon={`${url}/favicon.ico`} profileId={profileId} size={size} />;
});

export const FaviconFallback = memo(function FaviconFallback({ url, size = 16, opacity = 1, color, grayscale = false }: { url: string; size?: number; opacity?: number; color?: string; grayscale?: boolean }) {
  const theme = useTheme();
  const glyph = color ?? theme.textSecondary;
  const bundled = bundledSiteIcon(url, theme.dark);
  if (bundled !== undefined) {
    const image = <Image source={bundled} style={{ width: size, height: size, borderRadius: size > 18 ? radius.control : radius.hair, opacity }} />;
    return grayscale ? <Surface grayscale style={{ width: size, height: size }}>{image}</Surface> : image;
  }
  const initial = hostInitial(url);
  if (!initial) return <Symbol name="globe" size={size - 2} color={glyph} style={{ width: size, height: size, opacity }} />;
  const tile = Math.round((size * 14) / 16);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", opacity }}>
      <View
        style={{
          width: tile,
          height: tile,
          borderRadius: tile * 0.32,
          borderCurve: "continuous",
          backgroundColor: theme.faviconTile,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CapCenteredLetter box={tile} fontSize={Math.round(tile * 0.64)} fontWeight={weight.semibold} color={glyph}>
          {initial}
        </CapCenteredLetter>
      </View>
    </View>
  );
});

function hostInitial(url: string): string {
  const host = /^(?:https?|ftp):/i.test(url) ? hostOf(url) : "";
  if (!host || /^[\d.]+$|^\[/.test(host)) return "";
  return Array.from(displayHost(host))[0]?.toLocaleUpperCase() ?? "";
}

const NEW_TAB_MARK = require("../../../assets/new-tab-mark.png");

export function NewTabIcon({ size = 16, opacity = 1 }: { size?: number; opacity?: number }) {
  const theme = useTheme();
  return (
    <Image
      key={theme.dark ? "dark" : "light"}
      source={NEW_TAB_MARK}
      style={{ width: size, height: size, tintColor: theme.mark, opacity: (theme.dark ? 0.28 : 0.3) * opacity }}
    />
  );
}
