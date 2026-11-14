import { app, session as sessions, type Session } from "electron";
import { join } from "node:path";
import { defineModule } from "../bridge";
import { partitionOf, profileOfPartition } from "./partitions";
import { chromeUserAgent } from "./userAgent";

const PAGE_PRELOAD = "page-preload.js";
const RESTORES_HISTORY = "about:blank#ardia-restores-history";

type SessionSetup = (session: Session, profile: string) => void;

const profiles = new WeakMap<Session, string>();
const setups = new Set<SessionSetup>();

export const profileOfSession = (session: Session): string => profiles.get(session) ?? "";

export function onPageSession(setup: SessionSetup): void {
  setups.add(setup);
}

export function pageSession(profile: string): Session {
  const session = sessions.fromPartition(partitionOf(profile));
  if (!profiles.has(session)) {
    profiles.set(session, profile);
    session.setUserAgent(chromeUserAgent(), app.getLocale());
    for (const setup of setups) setup(session, profile);
  }
  return session;
}

const knownProfiles = new Set<string>();

export const knownPageSessions = (): { session: Session; profile: string }[] =>
  [...knownProfiles].map((profile) => ({ session: pageSession(profile), profile }));

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() === "webview") return;
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    const profile = profileOfPartition(params.partition ?? "");
    if (profile === null) {
      event.preventDefault();
      return;
    }
    if (params.src === RESTORES_HISTORY) params.src = "";
    knownProfiles.add(profile);
    pageSession(profile);
    webPreferences.preload = join(__dirname, PAGE_PRELOAD);
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.spellcheck = true;
    webPreferences.transparent = false;
    webPreferences.navigateOnDragDrop = true;
  });
});

defineModule("ArdiaLinuxPages", {
  sync: { partitionOf: (profile: string) => partitionOf(profile) },
});
