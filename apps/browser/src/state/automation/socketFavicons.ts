import { faviconsFor } from "../../platform/favicons";
import { withoutFragment } from "../../lib/url";
import { cacheKey, resolveFavicon } from "../favicons/favicons";
import type { MethodSpec } from "./socketCatalog";
import { obj, PROFILE } from "./socketSchema";
import { profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function pageOf(value: unknown): string {
  let url: URL | null = null;
  try {
    url = new URL(value as string);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new OpError("bad_request", `${String(value)} isn't a web address like https://example.com/.`);
  return withoutFragment(value as string);
}

const iconOf = (uri: string | null) => {
  const data = uri ? DATA_URI.exec(uri) : null;
  return data ? { mime: data[1]!, data: data[2]! } : null;
};

async function favicon(params: Record<string, unknown>) {
  const url = pageOf(params.url);
  const profile = profileArg(params.profile);
  const cached = resolveFavicon(url, null, profile);
  const known = cached?.profileId === profile ? iconOf(cached.uri) : null;
  if (known) return { url, profile, found: true, ...known };
  const looked = await faviconsFor(cacheKey(profile), [url]);
  const stored = iconOf(looked.pages.get(url)?.uri ?? null);
  return stored ? { url, profile, found: true, ...stored } : { url, profile, found: false, mime: null, data: null };
}

export const FAVICON_METHODS: MethodSpec[] = [
  {
    name: "favicons.get",
    mutates: false,
    description: t(`A page's icon as Ardia keeps it: the image as base64, from the app's cache or the profile's icon database`),
    params: obj({ url: { type: "string", description: "A page address like https://example.com/" }, profile: PROFILE }, ["url"]),
    result: t(`{url, profile, found, mime, data}`),
    run: favicon,
  },
];
