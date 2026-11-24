import type { EventSubscription } from "expo-modules-core";
import type { NotificationsNative } from "./generated/native";

export type NotificationPermission = "granted" | "denied" | "notDetermined" | "provisional";

export type NotificationOptions = {
  id?: string;
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  icon?: string;
  tabId?: string;
  windowId?: string;
  origin?: string;
  dismissible?: boolean;
  data?: Record<string, unknown>;
};

type NotificationIconStatus = "none" | "attached" | "invalid_url" | "download_failed" | "empty" | "write_failed" | "attachment_rejected" | "too_large";

export type NotificationPostResult = {
  id?: string;
  icon: NotificationIconStatus;
  iconErrorCode?: number;
  errorDomain?: string;
  errorCode?: number;
};

export type NotificationResponse = {
  id: string;
  action: "click" | "close";
  tabId: string | null;
  windowId: string | null;
  data: unknown;
};

export type { NotificationsNative };
