import { nativeModule, type RecordingResult, type ReportEvent, type UploadReply } from "@ardia/shell";

export type { RecordingResult, ReportEvent, UploadReply };

let bound: ReturnType<typeof nativeModule<"ArdiaReport">> | null = null;
const Report = () => (bound ??= nativeModule("ArdiaReport"));

export type ReportPost = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; text: string }>;
export type ReportPlatform = { recording: boolean; post: ReportPost };

const postWithFetch: ReportPost = async (url, body, headers, timeoutMs) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: abort.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
};

let reportPlatform: ReportPlatform = { recording: true, post: postWithFetch };

export const setReportPlatform = (platform: Partial<ReportPlatform>) => void (reportPlatform = { ...reportPlatform, ...platform });
export const recordsReports = () => reportPlatform.recording;
export const postReportJson: ReportPost = (url, body, headers, timeoutMs) => reportPlatform.post(url, body, headers, timeoutMs);

const isPending = (answer: unknown): answer is Promise<unknown> => typeof (answer as { then?: unknown } | null | undefined)?.then === "function";
const ignoreFailure = (answer: unknown) => {
  if (isPending(answer)) answer.then(undefined, () => {});
};

export const draftDirectory = (): string | Promise<string> => Report().draftDirectory();
export const fileSize = (path: string): number => {
  const size: unknown = Report().fileSize(path);
  if (typeof size === "number") return size;
  ignoreFailure(size);
  return -1;
};
export const removeReportFile = (path: string) => ignoreFailure(Report().removeFile(path));
export const startWindowRecording = (windowId: string, includePages: boolean, path: string, maxSeconds: number, fps: number | null = null, maxPixelWidth: number | null = null) =>
  Report().startRecording(windowId, includePages, path, maxSeconds, fps, maxPixelWidth);
export const stopWindowRecording = () => Report().stopRecording();
export const cancelWindowRecording = () => Report().cancelRecording();
export const recordingThumbnail = (path: string, out: string) => Report().recordingThumbnail(path, out);
export const gzipFile = (source: string, destination: string, removeSource: boolean) => Report().gzipFile(source, destination, removeSource);
export const gzipText = (text: string, destination: string) => Report().gzipText(text, destination);
export const uploadFile = (id: string, url: string, method: string, headers: Record<string, string>, path: string) =>
  Report().upload(id, url, method, headers, path);
export const cancelUploads = () => ignoreFailure(Report().cancelUploads());
export const onReportEvent = (listener: (event: ReportEvent) => void) => Report().addListener("onReport", listener);
