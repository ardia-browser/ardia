import { useEffect } from "react";
import { AppState } from "react-native";
import { create } from "zustand";
import { getPasskeyAccess, NO_PASSKEY_ACCESS, type PasskeyAccess } from "../engines/passkeys";
import type { VaultProviderState } from "../../platform/vaults";
import { openExternalURL } from "../../platform/app";
import type { PasskeyExtension } from "./passkeySources";

export type SystemRoute = "available" | "needsRelease" | "denied" | "unknown";

export const systemRouteOf = (access: PasskeyAccess): SystemRoute => (!access.entitled ? "needsRelease" : access.status === "denied" ? "denied" : "available");

export const openPasskeyAccessSettings = () => void openExternalURL("x-apple.systempreferences:com.apple.preference.security");

export const useSystemRoute = create<{ route: SystemRoute }>()(() => ({ route: "unknown" }));

let previewRoute: SystemRoute | null = null;

export function previewSystemRoute(route: SystemRoute | null) {
  previewRoute = route;
  if (route) useSystemRoute.setState({ route });
  else refreshSystemRoute();
}

export function refreshSystemRoute() {
  if (previewRoute) return;
  void getPasskeyAccess()
    .catch(() => NO_PASSKEY_ACCESS)
    .then((access) => previewRoute || useSystemRoute.setState({ route: systemRouteOf(access) }));
}

export function useSystemRouteWatch(): SystemRoute {
  useEffect(() => {
    refreshSystemRoute();
    const watch = AppState.addEventListener("change", (state) => state === "active" && refreshSystemRoute());
    return () => watch.remove();
  }, []);
  return useSystemRoute((s) => s.route);
}

const isSignedIn = (p: VaultProviderState) => p.state === "unlocked" || p.state === "locked";

export type DelegatedManager = { id: string; name: string; via: "system" | "extension"; status: "ready" | SystemRoute | "extensionOff"; extension: string | null };

function readyRoute(p: VaultProviderState, route: SystemRoute, extensions: readonly PasskeyExtension[]): DelegatedManager | null {
  for (const r of p.capabilities.passkeysVia ?? []) {
    if (r.via === "extension") {
      const found = extensions.find((e) => r.extensions.includes(e.id));
      if (found) return { id: p.id, name: p.name, via: "extension", status: "ready", extension: found.name };
    } else if (route === "available") {
      return { id: p.id, name: p.name, via: "system", status: "ready", extension: null };
    }
  }
  return null;
}

export function delegatedManagers(providers: readonly VaultProviderState[], route: SystemRoute, extensions: readonly PasskeyExtension[]): DelegatedManager[] {
  return providers.flatMap((p): DelegatedManager[] => {
    const first = p.capabilities.passkeysVia?.[0];
    if (!first || !isSignedIn(p)) return [];
    const ready = readyRoute(p, route, extensions);
    if (ready) return [ready];
    if (first.via === "system") return [{ id: p.id, name: p.name, via: "system", status: route, extension: null }];
    return [{ id: p.id, name: p.name, via: "extension", status: "extensionOff", extension: null }];
  });
}

export const systemSources = (managers: readonly DelegatedManager[]) => managers.filter((m) => m.via === "system" && m.status === "ready");

export function delegatedLine(manager: DelegatedManager): string {
  if (manager.via === "extension") return manager.status === "ready" ? `Sign in through the ${manager.extension} extension. Ardia lists them when a site asks.` : `They sign in through the ${manager.name} extension, which is off or missing.`;
  if (manager.status === "ready") return `In the ${manager.name} app. Ardia offers them through macOS when a site asks.`;
  if (manager.status === "denied") return `Off: turn Ardia on in System Settings › Privacy & Security › Passkeys Access for Web Browsers.`;
  if (manager.status === "needsRelease") return "Only Ardia's signed release from ardia.dev can reach them.";
  return "Checking whether macOS lets Ardia use them…";
}
