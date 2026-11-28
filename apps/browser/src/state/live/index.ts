import * as alerts from "./alerts";
import * as calendar from "./calendar";
import * as engine from "./engine";
import * as googleAuth from "./googleAuth";
import * as meetingGroups from "./meetingGroups";
import * as shownTabs from "./shownTabs";
import * as sources from "./sources";
import * as store from "./store";

export function startLive() {
  engine.startLiveEngine();
  shownTabs.startLiveShownTabs();
  calendar.startCalendar();
  meetingGroups.startMeetingGroups();
  alerts.startMeetingAlerts();
  if (__DEV__) {
    const hover = require("../sidebar/hover") as typeof import("../sidebar/hover");
    const settings = require("../settings/settingsWindows") as typeof import("../settings/settingsWindows");
    (globalThis as { acLive?: object }).acLive = { alerts, calendar, engine, googleAuth, meetingGroups, sources, store, hover, settings };
  }
}
