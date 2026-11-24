import { PERSONAL, TITLES, WORK, writeSession } from "./sessions-lib.mjs";

const T = (id, url) => ({ id, profileId: "default", url, title: TITLES[new URL(url).hostname.split(".")[0]] });

writeSession("session-atc-pattern.json", { profiles: [PERSONAL, WORK], tabs: [T("t1", "http://docpad.example/")], active: "t1", frame: [80, 60, 720, 460] });
