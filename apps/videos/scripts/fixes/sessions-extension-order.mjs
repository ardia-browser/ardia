import { TITLES, writeSession } from "./sessions-lib.mjs";

writeSession("session-extension-order.json", {
  tabs: [
    { id: "news", profileId: "default", url: "http://dailyledger.example/", title: TITLES.dailyledger },
    { id: "cookies", profileId: "default", url: "http://crumbs.example/", title: TITLES.crumbs },
  ],
  active: "news",
  frame: [0, 33, 1512, 949],
});
