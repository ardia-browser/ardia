import { definePlugin, type Ardia } from "@ardia/plugin-sdk";
import { Notes, type Host } from "./notes";
import { makeHandlers } from "./tools";

function hostFor(ardia: Ardia): Host {
  const console_ = (globalThis as { console?: { error?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; log?: (...a: unknown[]) => void } }).console;
  return {
    files: ardia.files,
    folders: ardia.folders,
    pickFiles: (options) => ardia.files.pick(options),
    controlStatus: () => ardia.app.controlStatus(),
    openArdiaSettings: (pane) => ardia.app.openSettings(pane),
    appIcon: (path, size) => ardia.app.icon(path, { size }),
    appleNotes: {
      request: () => ardia.appleNotes.request(),
      folders: () => ardia.appleNotes.folders(),
      notes: (folder, options) => ardia.appleNotes.notes(folder, options),
    },
    sites: ardia.sites,
    timeZone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    })(),
    seedWelcome: false,
    storage: {
      get: (key) => ardia.storage.get(key),
      set: (key, value) => ardia.storage.set(key, value),
    },
    setting: (key) => ardia.settings.get(key),
    post: (view, message) => ardia.pages.post(view, message),
    openPage: async (path) => {
      await ardia.pages.open({ path });
    },
    openUrl: async (url) => {
      await ardia.tabs.open(url, { activate: true });
    },
    log: (level, text) => {
      if (level === "error") console_?.error?.("[notes]", text);
      else if (level === "warn") console_?.warn?.("[notes]", text);
      else console_?.log?.("[notes]", text);
    },
  };
}

let notes: Notes | null = null;

void definePlugin({
  activate: (ardia) => {
    notes = new Notes(hostFor(ardia));
    void notes.start().catch((error) => hostFor(ardia).log?.("error", `Notes didn't start: ${String(error)}`));
  },
  deactivate: async () => {
    await notes?.stop();
    notes = null;
  },
  commands: {
    "new-page": async () => {
      if (!notes) return null;
      return { path: await notes.newPage() };
    },
    search: async (input: unknown) => {
      await notes?.openSearch(typeof input === "string" ? input : undefined);
      return null;
    },
  },
  tools: makeHandlers(() => notes?.access() ?? null),
  omnibox: async (query, call) => {
    if (!notes) return [];
    return notes.omnibox(query, call.name);
  },
  onPageMessage: (message, view) => notes?.onPageMessage(message, view),
  onSettingsChange: (values) => notes?.onSettings(values),
});
