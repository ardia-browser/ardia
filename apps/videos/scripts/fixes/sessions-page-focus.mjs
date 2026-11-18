import { TITLES, writeSession } from "./sessions-lib.mjs";

writeSession("session-page-focus.json", {
  tabs: [
    { id: "news", profileId: "default", url: "http://dailyledger.example/", title: TITLES.dailyledger },
    { id: "cookies", profileId: "default", url: "http://crumbs.example/", title: TITLES.crumbs },
  ],
  active: "news",
  frame: [80, 60, 1180, 860],
});
