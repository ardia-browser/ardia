import type { EventSubscription } from "expo-modules-core";
import type { CalendarNative, KeychainNative } from "./generated/native";

export type CalendarAuthorization = "fullAccess" | "writeOnly" | "denied" | "restricted" | "notDetermined";

export type SystemCalendar = {
  id: string;
  title: string;
  color: string;
  account: string;
  accountType: "local" | "exchange" | "calDAV" | "subscribed" | "birthdays" | "other";
  owned: boolean;
};

export type CalendarParticipant = { name: string; email: string; status: "accepted" | "declined" | "tentative" | "pending"; me: boolean };

export type SystemCalendarEvent = {
  id: string;
  occurrence: string;
  calendarId: string;
  color: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  notes: string;
  url: string;
  cancelled: boolean;
  declined: boolean;
  organizer: CalendarParticipant | null;
  attendees: CalendarParticipant[];
};

export type CalendarAccessRequest = {
  granted: boolean;
  status: CalendarAuthorization;
  error: string | null;
  responsible: "self" | "other" | "unknown";
  ms: number;
};

export type { CalendarNative };

export type KeychainReadResult = { status: "ok"; value: string } | { status: "missing" } | { status: "error"; reason: string };

export type { KeychainNative };
