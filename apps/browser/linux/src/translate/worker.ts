import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

type Native = {
  delete(): void;
};
type NativeVector<T> = Native & { push_back(value: T): void; get(index: number): T; size(): number };
type AlignedMemory = Native & { getByteArrayView(): Uint8Array };
type Response = { getTranslatedText(): string };
type Runtime = {
  asm?: Record<string, (...args: unknown[]) => unknown>;
  AlignedMemory: new (size: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => NativeVector<AlignedMemory>;
  VectorString: new () => NativeVector<string>;
  VectorResponseOptions: new () => NativeVector<{ alignment: boolean; html: boolean; qualityScores: boolean }>;
  TranslationModel: new (config: string, model: AlignedMemory, shortlist: AlignedMemory, vocabs: NativeVector<AlignedMemory>, quality: null) => Native;
  BlockingService: new (options: { cacheSize: number }) => {
    translate(model: Native, input: NativeVector<string>, options: NativeVector<unknown>): NativeVector<Response>;
    translateViaPivoting(first: Native, second: Native, input: NativeVector<string>, options: NativeVector<unknown>): NativeVector<Response>;
  };
};

export type ModelFiles = { model: string; lex: string; vocabs: string[] };
export type WorkerText = { text: string; html: boolean };
export type WorkerRequest = { id: number; op: "translate"; models: { key: string; files: ModelFiles }[]; texts: WorkerText[] };
export type WorkerReply = { id: number; result?: unknown; error?: string };

const GEMM_FALLBACKS: Record<string, string> = {
  int8_prepare_a: "int8PrepareAFallback",
  int8_prepare_b: "int8PrepareBFallback",
  int8_prepare_b_from_transposed: "int8PrepareBFromTransposedFallback",
  int8_prepare_b_from_quantized_transposed: "int8PrepareBFromQuantizedTransposedFallback",
  int8_prepare_bias: "int8PrepareBiasFallback",
  int8_multiply_and_add_bias: "int8MultiplyAndAddBiasFallback",
  int8_select_columns_of_b: "int8SelectColumnsOfBFallback",
};

const MODEL_CONFIG = [
  "beam-size: 1",
  "normalize: 1.0",
  "word-penalty: 0",
  "cpu-threads: 0",
  "gemm-precision: int8shiftAlphaAll",
  "skip-cost: true",
  "alignment: soft",
  "quiet: true",
  "quiet-translation: true",
  "max-length-break: 128",
  "mini-batch-words: 1024",
  "workspace: 128",
  "max-length-factor: 2.0",
].join("\n");

const LOADED_LIMIT = 4;

const { wasm, glue } = workerData as { wasm: string; glue: string };

function loadRuntime(): Promise<Runtime> {
  return new Promise((resolve, reject) => {
    const runtime: Record<string, unknown> = {
      print: () => {},
      printErr: () => {},
      instantiateWasm(imports: WebAssembly.Imports, accept: (instance: WebAssembly.Instance) => void) {
        const gemm = Object.fromEntries(Object.entries(GEMM_FALLBACKS).map(([name, fallback]) => [name, (...args: unknown[]) => (runtime.asm as Runtime["asm"])![fallback]!(...args)]));
        WebAssembly.instantiate(readFileSync(wasm), { ...imports, wasm_gemm: gemm }).then(({ instance }) => accept(instance), reject);
        return {};
      },
      onRuntimeInitialized: () => resolve(runtime as unknown as Runtime),
      onAbort: (reason: unknown) => reject(new Error(`the translation engine stopped: ${String(reason)}`)),
    };
    (globalThis as { Module?: unknown }).Module = runtime;
    runInThisContext(readFileSync(glue, "utf8"), { filename: glue });
  });
}

const ready = loadRuntime().then((runtime) => ({ runtime, service: new runtime.BlockingService({ cacheSize: 0 }) }));
const models = new Map<string, Native>();

function aligned(runtime: Runtime, path: string, alignment: number): AlignedMemory {
  const bytes = readFileSync(path);
  const memory = new runtime.AlignedMemory(bytes.byteLength, alignment);
  memory.getByteArrayView().set(bytes);
  return memory;
}

function load(runtime: Runtime, key: string, files: ModelFiles): Native {
  const known = models.get(key);
  if (known) {
    models.delete(key);
    models.set(key, known);
    return known;
  }
  const vocabs = new runtime.AlignedMemoryList();
  for (const path of [...new Set(files.vocabs)]) vocabs.push_back(aligned(runtime, path, 64));
  const model = new runtime.TranslationModel(MODEL_CONFIG, aligned(runtime, files.model, 256), aligned(runtime, files.lex, 64), vocabs, null);
  models.set(key, model);
  return model;
}

function freeBeyondLimit(keep: Set<string>) {
  for (const [key, model] of models) {
    if (models.size <= LOADED_LIMIT) return;
    if (keep.has(key)) continue;
    model.delete();
    models.delete(key);
  }
}

async function translate(wanted: WorkerRequest["models"], texts: WorkerText[]): Promise<string[]> {
  const { runtime, service } = await ready;
  const chosen = wanted.map(({ key, files }) => load(runtime, key, files));
  freeBeyondLimit(new Set(wanted.map(({ key }) => key)));
  const input = new runtime.VectorString();
  const options = new runtime.VectorResponseOptions();
  for (const { text, html } of texts) {
    input.push_back(text);
    options.push_back({ alignment: false, html, qualityScores: false });
  }
  try {
    const responses = chosen.length > 1 ? service.translateViaPivoting(chosen[0]!, chosen[1]!, input, options) : service.translate(chosen[0]!, input, options);
    try {
      return texts.map((_, i) => responses.get(i).getTranslatedText());
    } finally {
      responses.delete();
    }
  } finally {
    input.delete();
    options.delete();
  }
}

async function handle(request: WorkerRequest): Promise<unknown> {
  if (request.op !== "translate") throw new Error(`unknown request ${String(request.op)}`);
  return translate(request.models, request.texts);
}

let chain: Promise<unknown> = ready;
parentPort?.on("message", (request: WorkerRequest) => {
  chain = chain
    .catch(() => {})
    .then(() => handle(request))
    .then(
      (result) => parentPort?.postMessage({ id: request.id, result } satisfies WorkerReply),
      (error: unknown) => parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply),
    );
});
