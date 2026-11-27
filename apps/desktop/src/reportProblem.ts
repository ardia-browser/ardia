import { systemInfo } from "../../browser/src/platform/app";
import { diagnostics } from "../../browser/src/state/commands/appCommands";
import { openUrls } from "../../browser/src/state/browser/actions";
import { useBrowser } from "../../browser/src/state/browser/store";
import { capture, consentNow } from "../../browser/src/state/telemetry/client";
import { openReport as openReportSheet } from "../../browser/src/state/report/actions";
import { setReportPlatform } from "../../browser/src/platform/report";
import { ardiaHost, type ArdiaHost } from "./host.ts";
import { hostReportPost, servesReportSheet } from "./hostReport.ts";

export const BUG_FORM_URL = "https://github.com/ardia-browser/ardia/issues/new";
export const BUG_FORM_TEMPLATE = "bug_report.yml";
export const REPORT_URL_MAX_CHARS = 8000;
export const LINUX_REPORT_TEMPLATE = "What happened?\n\n\nWhat did you expect?\n\n\n---\n";

const FORM_APPS: Readonly<Record<string, string>> = { Windows: "Windows", Linux: "Linux" };
const TRIM_STEP_CHARS = 256;

type ReportSource = "menu" | "check_in";
type ReportPage = { url: string; trimmed: boolean };

const configuredPage = () => {
  const configured = systemInfo().feedbackURL;
  return configured && /^https:\/\//i.test(configured) && configured.includes("%s") ? configured : null;
};

export const sendsFromSheet = (host: ArdiaHost | undefined = ardiaHost) => servesReportSheet(host) && !configuredPage();

export function adoptHostReports(host: ArdiaHost | undefined = ardiaHost) {
  const post = hostReportPost(host);
  setReportPlatform(post ? { recording: false, post } : { recording: false });
}

adoptHostReports();

const isLeadingSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

function shortened(text: string): string {
  let end = Math.max(0, text.length - TRIM_STEP_CHARS);
  if (end > 0 && isLeadingSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function fitted(body: string, page: (text: string) => string): ReportPage {
  let text = body;
  let url = page(text);
  while (url.length > REPORT_URL_MAX_CHARS && text.includes("\n")) {
    text = text.slice(0, text.lastIndexOf("\n"));
    url = page(text);
  }
  while (url.length > REPORT_URL_MAX_CHARS && text) {
    text = shortened(text);
    url = page(text);
  }
  return { url, trimmed: text !== body };
}

const formQuery = (fields: Readonly<Record<string, string>>) =>
  Object.entries(fields)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");

export function bugFormPage(body: string, version: string, osBuild: string): ReportPage {
  const app = FORM_APPS[osBuild] ?? "Something else";
  return fitted(body, (text) => `${BUG_FORM_URL}?${formQuery({ template: BUG_FORM_TEMPLATE, version, app, "what-happened": text })}`);
}

async function reportPage(): Promise<ReportPage> {
  const body = `${LINUX_REPORT_TEMPLATE}${await diagnostics()}`;
  const configured = configuredPage();
  if (configured) return fitted(body, (text) => configured.replace("%s", encodeURIComponent(text)));
  const info = systemInfo();
  return bugFormPage(body, info.appVersion, info.osBuild);
}

export function openReport(windowId: string | null, source: ReportSource = "menu", host: ArdiaHost | undefined = ardiaHost): Promise<void> {
  const target = windowId && useBrowser.getState().windows[windowId]?.kind !== "small" ? windowId : null;
  if (!target) return Promise.resolve();
  if (sendsFromSheet(host)) {
    openReportSheet(target, source);
    return Promise.resolve();
  }
  const consent = consentNow();
  return reportPage().then(({ url, trimmed }) => {
    capture("report_sheet_opened", { source, form: "issue_page", trimmed }, consent);
    openUrls([url], target);
  });
}
