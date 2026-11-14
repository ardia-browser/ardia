import { net } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { defineModule, emit } from "../bridge";
import { dataDirectory } from "../paths";
import { cancelRecording, isRecording, recordingThumbnail, startRecording, stopRecording } from "./reportRecording";

const uploads = new Map<string, { abort: () => void }>();

function draftDirectory(): string {
  const folder = join(dataDirectory(), "Reports", "draft");
  mkdirSync(folder, { recursive: true });
  return folder;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

async function gzipFile(source: string, destination: string, removeSource: boolean): Promise<number> {
  const packed = gzipSync(readFileSync(source));
  writeFileSync(destination, packed);
  if (removeSource) rmSync(source, { force: true });
  return packed.length;
}

async function gzipText(text: string, destination: string): Promise<number> {
  const packed = gzipSync(Buffer.from(String(text), "utf8"));
  writeFileSync(destination, packed);
  return packed.length;
}

const UPLOAD_PROGRESS_MS = 100;

function upload(id: string, url: string, method: string, headers: Record<string, string>, path: string): Promise<{ status: number; body: string; error: string | null }> {
  if (!existsSync(path)) return Promise.resolve({ status: 0, body: "", error: "missing file" });
  const data = readFileSync(path);
  const total = data.length;
  return new Promise((resolve) => {
    const request = net.request({ url, method: method || "PUT", redirect: "follow" });
    for (const [name, value] of Object.entries(headers ?? {})) request.setHeader(name, value);
    let reported = -1;
    const report = () => {
      const progress = request.getUploadProgress();
      const sent = progress.started ? Math.min(total, progress.current) : 0;
      if (sent === reported) return;
      reported = sent;
      emit("ArdiaReport", "onReport", { type: "upload", id, sent, total });
    };
    const ticker = setInterval(report, UPLOAD_PROGRESS_MS);
    const done = (result: { status: number; body: string; error: string | null }) => {
      clearInterval(ticker);
      if (!uploads.has(id)) return;
      if (result.status) {
        reported = -1;
        emit("ArdiaReport", "onReport", { type: "upload", id, sent: total, total });
      }
      uploads.delete(id);
      resolve(result);
    };
    uploads.set(id, { abort: () => request.abort() });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), error: null }));
      response.on("error", () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"), error: "the response broke off" }));
    });
    request.on("error", (error) => done({ status: 0, body: "", error: error.message }));
    request.on("abort", () => done({ status: 0, body: "", error: "cancelled" }));
    request.end(data);
  });
}

defineModule("ArdiaReport", {
  sync: {
    draftDirectory,
    fileSize,
    removeFile: (path: string) => rmSync(path, { force: true, recursive: true }),
    isRecording,
    cancelUploads: () => {
      for (const abort of uploads.values()) abort.abort();
      uploads.clear();
    },
  },
  async: {
    gzipFile,
    gzipText,
    upload,
    startRecording,
    stopRecording,
    cancelRecording,
    recordingThumbnail,
  },
});
