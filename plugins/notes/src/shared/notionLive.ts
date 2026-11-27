export type NotionRole = "owner" | "admin" | "member" | "guest" | "unknown";

export type NotionSpace = { id: string; name: string; icon: string; role: NotionRole; canImport: boolean; reason?: string };

export type NotionAccount =
  | { state: "unsupported" }
  | { state: "unavailable"; reason: string }
  | { state: "signedOut" }
  | { state: "signedIn"; user: { id: string; name: string; email: string }; spaces: NotionSpace[] };

export type NotionCrawlStage = "idle" | "reading" | "downloading" | "cancelling" | "ready" | "failed" | "cancelled";

export type NotionCrawl = {
  stage: NotionCrawlStage;
  spaceId: string;
  spaceName: string;
  pagesFound: number;
  pagesRead: number;
  blocks: number;
  databases: number;
  rows: number;
  filesFound: number;
  filesDone: number;
  filesSkipped: number;
  skipped: number;
  error?: string;
  note?: string;
  startedAt: number;
};

export const NOTION_LOGIN_URL = "https://app.notion.com/login";
