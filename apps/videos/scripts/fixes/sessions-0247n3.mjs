import { DARK, PERSONAL, TITLES, ensureMedia, hostOf, writeSession } from "./sessions-lib.mjs";

ensureMedia([
  ["tide.example/img/tide.mp4", ["-f", "lavfi", "-i", "gradients=s=1280x720:d=6:speed=0.02:n=3:c0=0x1d4e89:c1=0x3fb8af:c2=0xf4d35e", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=6", "-af", "volume=0.2", "-t", "6", "-c:v", "libx264", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart"]],
]);

const TITLES_HERE = { ...TITLES, files: "Field Kit — Downloads", width: "Page width", tide: "Morning tide — Clips", mail: "Inbox — Mailbox", chat: "General — Pinecone", forum: "Threadly · The best sourdough starter?", trails: "Ridge Trail Map" };
const T = (id, url, extra = {}) => ({ id, profileId: "default", url, title: TITLES_HERE[hostOf(url)] ?? hostOf(url), ...extra });
const tile = (id, url, extra = {}) => T(id, url, { pinned: true, pinnedUrl: url, ...extra });
const row = (id, url, extra = {}) => tile(id, url, { pinnedAsRow: true, ...extra });
const FRAME = [80, 60, 1100, 720];
const TABS = [T("t1", "http://docpad.example/"), T("t2", "http://lexicon.example/"), T("t3", "http://crumbs.example/"), T("t4", "http://dailyledger.example/"), T("t5", "http://forum.example/")];

function build(file, { tabs, active, frame = FRAME, settings = {} }) {
  writeSession(file, { profiles: [PERSONAL], tabs, active, frame, settings: { ...DARK, ...settings } });
}

build("session-0247n3-downloads.json", { tabs: [T("d1", "http://files.example/"), ...TABS.slice(0, 3)], active: "d1" });

build("session-0247n3-tabs.json", {
  tabs: [tile("p1", "http://moodwall.example/"), tile("p2", "http://trails.example/", { favicon: "http://trails.example/favicon.svg" }), row("r1", "http://docpad.example/", { url: "http://docpad.example/packing", title: "Packing list — Docpad" }), ...TABS],
  active: "t1",
});

build("session-0247n3-hidden.json", { tabs: TABS, active: "t1", settings: { autoHideTabs: true } });

build("session-0247n3-edge.json", { tabs: TABS, active: "t1", frame: [0, 60, 1100, 720], settings: { autoHideTabs: true } });

build("session-0247n3-width.json", { tabs: [T("w1", "http://width.example/"), ...TABS.slice(0, 3)], active: "w1" });

build("session-0247n3-player.json", { tabs: [T("v1", "http://tide.example/"), ...TABS.slice(0, 3)], active: "v1" });

build("session-0247n3-pip.json", { tabs: [T("v1", "http://tide.example/"), ...TABS.slice(0, 3)], active: "v1", frame: [0, 33, 1920, 1047] });
