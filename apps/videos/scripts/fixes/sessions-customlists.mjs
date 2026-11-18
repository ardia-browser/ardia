import { DARK, TITLES, writeSession } from "./sessions-lib.mjs";

writeSession("session-customlists.json", {
  tabs: [{ id: "t1", profileId: "default", url: "http://dailyledger.example/", title: TITLES.dailyledger }],
  active: "t1",
  frame: [80, 60, 720, 460],
  settings: { ...DARK, showAdvancedSettings: true },
});
