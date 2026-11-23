import type { FaviconImage } from "../../favicons";
import type { Profile } from "../wire";

export type FaviconsCalls = {
  "favicons.get": [Profile & { pages: string[]; icons: string[]; size: number }, { pages: Record<string, { png: string; icon: string }>; icons: Record<string, { png: string }> }];
  "favicons.set": [Profile & { page: string; icon: string; png: string }, { stored: boolean }];
  "favicons.fetch": [Profile & { url: string }, FaviconImage | null];
};

export type FaviconsEvents = {};
