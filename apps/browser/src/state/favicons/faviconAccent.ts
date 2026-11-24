import { useEffect } from "react";
import { create } from "zustand";
import { iconAccent } from "../../platform/favicons";
import { useResolvedFaviconUri } from "./faviconHooks";
import { faviconHeld, onPrivateIconsDropped } from "./favicons";
import { takeRequest } from "./privateLookups";

const KEPT = 64;

export const useFaviconAccents = create<{ byUri: Record<string, string | null> }>()(() => ({ byUri: {} }));

const asking = new Map<string, symbol>();

onPrivateIconsDropped((unheld) => {
  for (const uri of [...asking.keys()].filter(unheld)) asking.delete(uri);
  const { byUri } = useFaviconAccents.getState();
  if (Object.keys(byUri).some(unheld)) useFaviconAccents.setState({ byUri: Object.fromEntries(Object.entries(byUri).filter(([uri]) => !unheld(uri))) });
});

function remember(uri: string, accent: string | null) {
  const kept = Object.entries(useFaviconAccents.getState().byUri).filter(([key]) => key !== uri).slice(-(KEPT - 1));
  useFaviconAccents.setState({ byUri: { ...Object.fromEntries(kept), [uri]: accent } });
}

export function askFaviconAccent(uri: string) {
  if (asking.has(uri) || !faviconHeld(uri)) return;
  const request = Symbol(uri);
  asking.set(uri, request);
  void iconAccent(uri)
    .catch(() => null)
    .then((found) => {
      if (takeRequest(asking, uri, request) && faviconHeld(uri)) remember(uri, found ?? null);
    });
}

export function useFaviconAccent(url: string, profileId?: string): string | null | undefined {
  const uri = useResolvedFaviconUri(url, null, profileId);
  const accent = useFaviconAccents((a) => (uri ? a.byUri[uri] : null));
  useEffect(() => {
    if (uri && accent === undefined) askFaviconAccent(uri);
  }, [uri, accent]);
  return accent;
}
