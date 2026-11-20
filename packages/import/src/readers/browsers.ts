import type { Family } from "./model";

export type Browser = {
  id: string;
  name: string;
  family: Family;
  dataDirectory: string;
  rootIsProfile?: boolean;
  sidebar?: "arc" | "zen";
};

export const isChromiumBased = (b: Browser) => b.family === "chromium" || b.family === "arc";
