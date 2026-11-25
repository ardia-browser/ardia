import type { MeadowIntro, MeadowPageConfig } from "@ardia/shaders";
import { symbolLayers, symbolNudge } from "../../../demo/src/shims/web/symbols/data";
import { symbolMarkup, type SymbolWeight } from "../../../demo/src/shims/web/symbols/render";
import { MEADOW_HANDOFF, MEADOW_INK, MEADOW_PAGE_API, MEADOW_PAGE_CONFIG_ID } from "../../../shaders/src/meadowPage/config";
import { nearestPoster } from "../../../shaders/src/meadowPage/posters";
import { MEADOW_PAGE_BODY, MEADOW_PAGE_HEAD, MEADOW_PAGE_SCRIPT, MEADOW_POSTERS } from "../../../shaders/windows/meadow/page";

const WEIGHTS: readonly SymbolWeight[] = ["light", "regular", "medium", "semibold", "bold"];
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAGE_URL_START = "data:text/html;base64,";

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

export function base64InThrees(text: string): string {
  const bytes = utf8Bytes(text);
  while (bytes.length % 3) bytes.push(0x20);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const group = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out.push(BASE64[(group >> 18) & 63]!, BASE64[(group >> 12) & 63]!, BASE64[(group >> 6) & 63]!, BASE64[group & 63]!);
  }
  return out.join("");
}

function muteIcon(intro: MeadowIntro, name: string, id: string): string {
  const layers = symbolLayers(name);
  if (!layers) return "";
  const weight = WEIGHTS.find((known) => known === intro.mute.iconWeight) ?? "regular";
  const { iconSize, iconBox } = intro.mute;
  return symbolMarkup(layers, { pointSize: iconSize, weight, width: iconBox, height: iconBox, color: intro.colors.buttonText, id, nudge: symbolNudge(name, weight, iconSize) });
}

export function meadowPageConfig(intro: MeadowIntro, night: boolean): MeadowPageConfig {
  return {
    intro,
    night,
    ink: MEADOW_INK,
    muteIcons: { muted: muteIcon(intro, intro.mute.mutedIcon, "muted"), playing: muteIcon(intro, intro.mute.playingIcon, "playing") },
    handoff: MEADOW_HANDOFF,
  };
}

function firstPaint(background: string, night: boolean, aspect: number): string {
  const poster = night ? null : nearestPoster(MEADOW_POSTERS, aspect);
  const picture = poster ? ` url(${poster.uri}) 50% ${poster.horizon * 100}% / cover no-repeat` : "";
  return `<style>html{background:${background}}body{background:${background}${picture}}</style>`;
}

const scriptSafe = (json: string) => json.replace(/</g, "\\u003c");

export function meadowPageUrl(intro: MeadowIntro, night: boolean, aspect: number): string {
  const config = scriptSafe(JSON.stringify(meadowPageConfig(intro, night)));
  const head = `${firstPaint(intro.colors.background, night, aspect)}<script type="application/json" id="${MEADOW_PAGE_CONFIG_ID}">${config}</script>`;
  return `${PAGE_URL_START}${MEADOW_PAGE_HEAD}${base64InThrees(head)}${MEADOW_PAGE_BODY}#${night ? "night" : "day"}`;
}

export const withoutFragment = (url: string) => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

let scripts = "";

export function meadowScriptsCode(): string {
  scripts ||= `if (!window.${MEADOW_PAGE_API}) { const script = document.createElement("script"); script.textContent = ${JSON.stringify(MEADOW_PAGE_SCRIPT)}; document.body.appendChild(script); } post("result", JSON.stringify(!!window.${MEADOW_PAGE_API}));`;
  return scripts;
}
