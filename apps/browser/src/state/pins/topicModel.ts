import { call } from "../../platform/engine";
import { currentEngineProfile, currentProfileOrder } from "../browser/current";
import { DEFAULT_PROFILE_ID } from "../settings/settings";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import bundle from "./webLLMBundle.json";

const MODEL_URL = "https://huggingface.co/mlc-ai/gemma-3-1b-it-q4f16_1-MLC";
const MODEL_PAGE = MODEL_URL;
const MODEL_ID = "gemma-3-1b-it-q4f16_1-MLC";
const WASM_LIB = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_87/base/gemma3-1b-it-q4f16_1_cs512-webgpu.wasm";

export type TopicTab = { id: string; title: string; host: string };
export type TopicGroup = { id: string; name: string };
export type TopicPlan = { files: { tabId: string; groupId: string }[]; newGroups: { tabIds: string[]; name: string }[] };

export const topicModelSupported = () => PLATFORM_FEATURES.topicModel;

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const GROUP_TIMEOUT_MS = 45 * 1000;

type PageState = { pageId: string };
let page: PageState | null = null;
let opening: Promise<PageState> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let busy = 0;

const engineProfileName = () => currentEngineProfile(currentProfileOrder()[0] ?? DEFAULT_PROFILE_ID);

async function openPage(): Promise<PageState> {
  const reply = await call("engine.hiddenPageOpen", { profile: engineProfileName(), url: MODEL_PAGE });
  if (!reply.ok || !reply.pageId) throw new Error(reply.reason ?? "The model page didn't open.");
  return { pageId: reply.pageId };
}

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (busy > 0) return;
    const closing = page;
    page = null;
    if (closing) void call("engine.hiddenPageClose", { pageId: closing.pageId }).catch(() => {});
  }, IDLE_CLOSE_MS);
}

async function ensurePage(): Promise<PageState> {
  armIdleClose();
  if (page) return page;
  opening ??= openPage()
    .then((next) => {
      page = next;
      return next;
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

async function keepAlive<T>(work: () => Promise<T>): Promise<T> {
  busy++;
  try {
    return await work();
  } finally {
    busy--;
    armIdleClose();
  }
}

async function runOnPage(pageId: string, script: string, timeoutMs: number): Promise<unknown> {
  const reply = await call("engine.hiddenPageRun", { pageId, script, timeoutMs });
  if (!reply.ok) throw new Error(reply.reason ?? "The model page had no answer.");
  return reply.json;
}

export type TopicModelProgress = (fraction: number, text: string) => void;

let loadState: { promise: Promise<void> } | null = null;

export async function topicModelReady(): Promise<boolean> {
  if (!topicModelSupported()) return false;
  try {
    const { pageId } = await ensurePage();
    return ((await runOnPage(pageId, "post('result', JSON.stringify({engine: !!globalThis.__ardiaTopicEngine}))", 5000)) as { engine?: boolean }).engine === true;
  } catch {
    return false;
  }
}

export async function ensureTopicModel(onProgress?: TopicModelProgress): Promise<void> {
  if (!topicModelSupported()) throw new Error("This build can't run the topic model.");
  if (loadState?.promise) return loadState.promise;
  const attempt = keepAlive(async () => {
    const { pageId } = await ensurePage();
    if (((await runOnPage(pageId, "post('result', JSON.stringify({engine: !!globalThis.__ardiaTopicEngine}))", 5000)) as { engine?: boolean }).engine === true) return;
    await runOnPage(pageId, `${bundle.source}\nglobalThis.webLLM = webLLM;\npost('result', JSON.stringify({injected: true}));`, 30 * 1000);
    await runOnPage(
      pageId,
      `(async () => {
        globalThis.__ardiaTopicProgress = { loaded: 0, total: 1, text: 'start' };
        try {
          const engine = await webLLM.CreateMLCEngine(${JSON.stringify(MODEL_ID)}, {
            appConfig: {
              model_list: [{ model: ${JSON.stringify(MODEL_URL)}, model_id: ${JSON.stringify(MODEL_ID)}, model_lib: ${JSON.stringify(WASM_LIB)} }],
            },
          }, {
            initProgressCallback: (report) => {
              const reported = typeof report.progress === 'number' && report.progress > 0 ? report.progress : NaN;
              const fromText = /\\(\\s*([0-9]+)\\s*\\/\\s*([0-9]+)\\s*\\)/.exec(report.text || '');
              const fraction = !Number.isNaN(reported) ? reported : fromText ? Number(fromText[1]) / Math.max(1, Number(fromText[2])) : null;
              globalThis.__ardiaTopicProgress = { loaded: fraction === null ? 0 : Math.max(0, Math.min(1, fraction)), total: 1, text: report.text || '' };
            },
          });
          globalThis.__ardiaTopicEngine = engine;
          globalThis.__ardiaTopicProgress = { loaded: 1, total: 1, text: 'done' };
        } catch (error) {
          globalThis.__ardiaTopicProgress = { loaded: 0, total: 1, text: 'error: ' + String((error && error.message) || error) };
        }
      })();
      post('result', JSON.stringify({started: true}));`,
      10 * 1000,
    );
    const started = Date.now();
    for (;;) {
      const state = (await runOnPage(pageId, "post('result', JSON.stringify(globalThis.__ardiaTopicProgress ?? null))", 5000)) as
        | { loaded: number; total: number; text: string }
        | null;
      if (!state) throw new Error("The model never started loading.");
      if (state.text === "done") {
        onProgress?.(1, "Ready");
        return;
      }
      if (state.text.indexOf("error") === 0) throw new Error(String(state.text));
      const fraction = state.total > 0 ? state.loaded / state.total : 0;
      onProgress?.(Math.min(fraction, 0.99), `Downloading… ${Math.round(Math.min(fraction, 0.99) * 100)}%`);
      if (Date.now() - started > DOWNLOAD_TIMEOUT_MS) throw new Error("The model took too long to load.");
      await new Promise((wake) => setTimeout(wake, 500));
    }
  });
  loadState = { promise: attempt };
  attempt.catch(() => {
    loadState = null;
  });
  return attempt;
}

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { tabId: { type: "string" }, groupId: { type: "string" } },
        required: ["tabId", "groupId"],
      },
    },
    newGroups: {
      type: "array",
      items: {
        type: "object",
        properties: { tabIds: { type: "array", items: { type: "string" } }, name: { type: "string" } },
        required: ["tabIds", "name"],
      },
    },
  },
  required: ["files", "newGroups"],
});

function promptFor(tabs: TopicTab[], groups: TopicGroup[]): string {
  const groupLines = groups.length
    ? `Existing groups (file a tab into one of these by its groupId when it fits):\n${groups.map((g) => `- groupId "${g.id}" named "${g.name}"`).join("\n")}`
    : "There are no existing groups; make new groups.";
  const tabLines = tabs.map((t) => `- tabId "${t.id}" — "${t.title}" (${t.host})`).join("\n");
  return `Group these open browser tabs by topic or task.
${groupLines}
Tabs:
${tabLines}

Rules:
- File a tab into an existing group only when its topic matches.
- Make a new group only from 2 or more tabs. Name it with 1 to 3 words in Title Case.
- Leave a tab in no group when it fits nowhere.
- Reply as JSON: { "files": [{ "tabId": string, "groupId": string }], "newGroups": [{ "tabIds": string[], "name": string }] }.`;
}

export function groupByTopic(tabs: TopicTab[], groups: TopicGroup[]): Promise<TopicPlan> {
  return keepAlive(async () => {
    const { pageId } = await ensurePage();
  const script = `(async () => {
    if (!globalThis.__ardiaTopicEngine) return post('result', JSON.stringify({ error: 'The model page lost its engine.' }));
    try {
      const reply = await globalThis.__ardiaTopicEngine.chat.completions.create({
        messages: [
          { role: 'system', content: 'You file open browser tabs into groups. Reply with JSON only.' },
          { role: 'user', content: ${JSON.stringify(promptFor(tabs, groups))} },
        ],
        temperature: 0,
        response_format: { type: 'json_object', schema: ${JSON.stringify(SCHEMA)} },
      });
      post('result', JSON.stringify({ answer: JSON.parse(reply.choices[0].message.content) }));
    } catch (error) {
      post('result', JSON.stringify({ error: String((error && error.message) || error) }));
    }
  })();`;
  const result = (await runOnPage(pageId, script, GROUP_TIMEOUT_MS)) as { answer?: TopicPlan; error?: string };
  if (!result || typeof result !== "object" || !("answer" in result)) {
    throw new Error(result && typeof result === "object" && "error" in result && result.error ? result.error : "The model's answer wasn't readable.");
  }
  return result.answer!;
  });
}
