import { TITLES, writeSession } from "./sessions-lib.mjs";

writeSession("session-meet-auto-pip.json", {
  tabs: [
    { id: "call", profileId: "default", url: "https://huddle.example/", title: "Weekly sync · Huddle" },
    { id: "news", profileId: "default", url: "http://dailyledger.example/", title: TITLES.dailyledger },
  ],
  active: "call",
  frame: [0, 33, 1512, 949],
});
