import { defineDesktopHost } from "../define.ts";

export const desktopHost = defineDesktopHost({
  routeOrder: ["engine", "tabs", "downloads", "history", "bookmarks", "favicons", "extensions", "search", "permissions"],
  deadlines: {
    "ArdiaAutofill.cardNumber": 180000,
    "ArdiaCalendar.objects": 120000,
    "ArdiaCalendar.sources": 60000,
    "ArdiaLive.connect": 180000,
    "ArdiaLive.disconnect": 180000,
    "ArdiaLive.request": 180000,
    "ArdiaPasswords.export": 900000,
    "ArdiaPasswords.reveal": 180000,
    "ArdiaPasswords.unlock": 180000,
    "ArdiaPasswords.update": 180000,
    "ArdiaSync.status": 180000,
  },
});
