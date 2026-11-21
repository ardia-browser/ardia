import type { ConsentToken } from "./client";

export const nativeConsent = (record: { epoch?: unknown } | null | undefined): ConsentToken | null =>
  typeof record?.epoch === "string" && record.epoch !== "" ? (record.epoch as ConsentToken) : null;
