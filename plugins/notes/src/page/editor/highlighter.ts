import type { HighlighterCore, LanguageInput } from "shiki/core";

const LANGS: Record<string, () => LanguageInput> = {
  bash: () => import("@shikijs/langs/bash"),
  sh: () => import("@shikijs/langs/bash"),
  shell: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  js: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  latex: () => import("@shikijs/langs/latex"),
  lua: () => import("@shikijs/langs/lua"),
  markdown: () => import("@shikijs/langs/markdown"),
  objc: () => import("@shikijs/langs/objective-c"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  ts: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

const IMPORT_TRIES = 3;
const RETRY_MS = 150;

async function settled<T>(load: () => Promise<T>): Promise<T> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < IMPORT_TRIES; attempt++) {
    try {
      return await load();
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS * (attempt + 1)));
    }
  }
  throw failure;
}

const plainGrammar = (name: string) => ({ name, scopeName: `source.notes-plain.${name}`, patterns: [], repository: {} });

export async function createNotesHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await settled(() => Promise.all([import("shiki/core"), import("shiki/engine/javascript")]));
  const highlighter = await createHighlighterCore({
    themes: await settled(() => Promise.all([import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")])),
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  const load = highlighter.loadLanguage.bind(highlighter);
  highlighter.loadLanguage = (async (...langs: (LanguageInput | string)[]) => {
    for (const lang of langs) {
      if (typeof lang !== "string") {
        await load(lang as LanguageInput);
        continue;
      }
      const loader = LANGS[lang];
      if (!loader) throw new Error(`Unknown language ${lang}`);
      try {
        await load(await settled(() => Promise.resolve(loader())) as LanguageInput);
      } catch {
        await load(plainGrammar(lang) as unknown as LanguageInput);
      }
    }
  }) as typeof highlighter.loadLanguage;
  return highlighter;
}
