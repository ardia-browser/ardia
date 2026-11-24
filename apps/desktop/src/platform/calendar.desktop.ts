import type { CalendarAccessRequest, CalendarNative } from "../../../../packages/shell/src/live";
import type { ArdiaHost } from "../host";

const NO_CALENDAR_SERVICE: Pick<CalendarNative, "authorizationStatus" | "requestAccess" | "calendars" | "events"> = {
  authorizationStatus: () => "restricted",
  requestAccess: async (): Promise<CalendarAccessRequest> => ({ granted: false, status: "restricted", error: null, responsible: "self", ms: 0 }),
  calendars: async () => [],
  events: async () => [],
};

export function calendarModuleMethod(_host: ArdiaHost, name: string, method: string): ((...args: never[]) => unknown) | undefined {
  if (name !== "ArdiaCalendar") return undefined;
  switch (method) {
    case "authorizationStatus": return () => NO_CALENDAR_SERVICE.authorizationStatus();
    case "requestAccess": return () => NO_CALENDAR_SERVICE.requestAccess();
    case "calendars": return () => NO_CALENDAR_SERVICE.calendars();
    case "events": return () => NO_CALENDAR_SERVICE.events(0, 0, []);
  }
  return undefined;
}
