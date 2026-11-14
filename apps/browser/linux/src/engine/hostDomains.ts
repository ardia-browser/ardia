import { app, desktopCapturer, powerMonitor, webContents as allContents } from "electron";
import { totalmem } from "node:os";
import { dataDirectory } from "../paths";
import { appWindowIds } from "../windows";
import { defineModule } from "../bridge";
import { defineDomain } from "./domains";
import { allGuests, guestOf } from "./guests";
import { configurePageScripts, type PageScriptConfig } from "./pageScriptBridge";
import { popupWindowCount } from "./popupWindows";

const PEEK_KEYS = ["alt", "shift", "off"];
const SPLIT_KEYS = ["alt", "altShift"];

const TASK_TYPES: Record<string, string> = {
  Browser: "browser",
  Tab: "renderer",
  Utility: "utility",
  Zygote: "zygote",
  "Sandbox helper": "sandboxHelper",
  GPU: "gpu",
  "Pepper Plugin": "plugin",
  "Pepper Plugin Broker": "plugin",
};

function systemState() {
  return {
    onBattery: powerMonitor.isOnBatteryPower(),
    batteryLevel: null,
    lowPowerMode: false,
    memoryPressure: "normal",
    physicalMemory: totalmem(),
  };
}

function tasks() {
  const guestsByPid = new Map<number, string[]>();
  for (const contents of allContents.getAllWebContents()) {
    const guest = guestOf(contents);
    if (!guest?.tabId || contents.isDestroyed()) continue;
    const pid = contents.getOSProcessId();
    guestsByPid.set(pid, [...(guestsByPid.get(pid) ?? []), guest.tabId]);
  }
  return app.getAppMetrics().map((metric) => {
    const tabIds = guestsByPid.get(metric.pid) ?? [];
    return {
      id: metric.pid,
      pid: metric.pid,
      type: tabIds.length ? "renderer" : (TASK_TYPES[metric.type] ?? "unknown"),
      title: metric.name || metric.serviceName || metric.type,
      killable: tabIds.length > 0,
      cpu: metric.cpu.percentCPUUsage,
      processors: 1,
      memory: metric.memory.workingSetSize * 1024,
      gpuMemory: 0,
      tabIds,
    };
  });
}

defineDomain("engine", {
  info: () => ({
    pid: process.pid,
    dataDirectory: dataDirectory(),
    engine: "electron",
    chromiumVersion: process.versions.chrome,
    liveBrowsers: appWindowIds().length,
    popupWindows: popupWindowCount(),
    chromeWindows: appWindowIds().length,
  }),
  components: () => [],
  tasks: () => tasks(),
  systemState: () => systemState(),
  batterySaver: () => ({ state: 0, active: false }),
  trimMemory: () => ({ ok: true }),
  openTaskManager: () => ({ ok: false }),
  cliControlStatus: () => ({ state: "off", connections: 0, generation: 0, file: "" }),
  setCliControl: () => ({ state: "off", connections: 0, generation: 0, file: "" }),
  setCliActiveTab: () => ({ state: "off", connections: 0, generation: 0, file: "" }),
  cliTabTargets: () => ({}),
  isTracing: () => false,
});

defineDomain("tabs", {
  routeLinkTabs: () => ({}),
  stripCommand: () => null,
  strips: () => ({ rev: 0, cmd: null, strips: [] }),
  lastTabPolicy: () => ({ closesWindow: true }),
  reportCommits: () => null,
});

defineDomain("windows", {
  list: () => [],
});

const configure = (change: Partial<PageScriptConfig>) => {
  configurePageScripts(change, allGuests());
  return null;
};

defineDomain("webView", {
  setPeekModifier: (args) => configure(PEEK_KEYS.includes(String(args.modifier)) ? { peek: args.modifier as PageScriptConfig["peek"] } : {}),
  setSplitLinkModifier: (args) => configure(SPLIT_KEYS.includes(String(args.modifier)) ? { split: args.modifier as PageScriptConfig["split"] } : {}),
  setPeekOtherSiteTabs: (args) => configure({ peekOtherSites: Array.isArray(args.tabIds) ? args.tabIds.filter((id): id is string => typeof id === "string") : [] }),
  setSelectionPopover: (args) => configure({ selectionPopover: args.enabled === true }),
  setDisplayMediaPicker: (args) => configure({ displayMediaPicker: args.enabled === true }),
  setCommandScrollZoom: () => null,
  setLittleArdiaOpensNewTabLinks: () => null,
  setAutoPictureInPicture: () => null,
  setVideoUpscaling: () => null,
  setVideoUpscalingTestConditions: () => null,
  videoUpscalingState: () => null,
});

defineDomain("media", {
  displayMediaSources: async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    return sources.map((source) => ({ id: source.id, kind: source.id.startsWith("screen") ? "screen" : "window", name: source.name, width: 0, height: 0 }));
  },
  screenRecordingAllowed: () => true,
  requestScreenRecording: () => true,
  watchCastRoutes: () => null,
  changeCaptureSource: () => false,
  stopCapture: () => false,
  showCastDialog: () => false,
});

defineModule("ArdiaEngine", {
  sync: { inputIdleSeconds: () => powerMonitor.getSystemIdleTime() },
});
