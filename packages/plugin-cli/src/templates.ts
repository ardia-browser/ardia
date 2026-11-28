export const TEMPLATES = ["ui", "content-script", "ai-consumer", "sidecar"] as const;

export type TemplateName = (typeof TEMPLATES)[number];

export type TemplateInput = { id: string; name: string; title: string; sdkRange: string; cliRange: string; ardiaRange: string };

export type TemplateFile = { path: string; content: string; executable?: boolean };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function manifestFor(template: TemplateName, t: TemplateInput): Record<string, unknown> {
  const base = {
    $schema: "https://raw.githubusercontent.com/ardia-browser/ardia/main/docs/plugin.v3.schema.json",
    manifest: 3,
    id: t.id,
    name: t.title,
    description: "A plugin for Ardia.",
    version: "0.1.0",
    icon: "puzzlepiece",
    license: "MIT",
    engines: { ardia: ">=0.3.0", sdk: t.sdkRange },
    release: { github: `OWNER/${t.name}`, tagPrefix: "v" },
  };
  if (template === "ui") {
    return {
      ...base,
      main: "dist/index.js",
      permissions: { tabs: "read", storage: true },
      contributes: {
        commands: [{ name: "open", title: `Open ${t.title}`, view: "main", shortcut: "cmd+shift+y" }],
        sidebarViews: [{ id: "main", title: t.title, icon: "puzzlepiece" }],
        toolbar: [{ id: "toolbar", title: t.title, icon: "puzzlepiece", view: "main" }],
      },
    };
  }
  if (template === "content-script") {
    return {
      ...base,
      main: "dist/index.js",
      permissions: { pages: ["https://*/*"], storage: true },
      contributes: {
        commands: [{ name: "count", title: "Count Links on This Page", handler: true }],
        contentScripts: [{ id: "links", matches: ["https://*/*"], js: ["dist/content.js"], runAt: "document_idle" }],
        pageStyles: [{ id: "focus", matches: ["https://*/*"], css: "styles/focus.css" }],
      },
    };
  }
  if (template === "ai-consumer") {
    return {
      ...base,
      main: "dist/index.js",
      consumes: ["ai.provider"],
      permissions: { activePage: { read: true } },
      contributes: {
        inputModes: [{ id: "ask", title: "Ask About This Page", placeholder: "Ask anything about this page", icon: "sparkles" }],
        commands: [{ name: "ask", title: "Ask About This Page", inputMode: "ask", shortcut: "cmd+shift+j" }],
      },
    };
  }
  return {
    ...base,
    main: "dist/index.js",
    sidecar: { run: ["sidecar/server.mjs"], memoryMB: 256 },
    contributes: { commands: [{ name: "ping", title: "Ping the Sidecar", handler: true }] },
  };
}

const UI_SOURCE = `import { Action, ActionPanel, List, ardia, definePlugin, useEffect, useState } from "@ardia/plugin-sdk";

type Row = { id: string; title: string; url: string };

function Main() {
  const [tabs, setTabs] = useState<Row[] | null>(null);
  useEffect(() => {
    void ardia.tabs.query().then(setTabs, () => setTabs([]));
  }, []);
  return (
    <List searchBarPlaceholder="Filter tabs" isLoading={tabs === null}>
      {(tabs ?? []).map((tab) => (
        <List.Item
          key={tab.id}
          id={tab.id}
          title={tab.title || tab.url}
          subtitle={tab.url}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser url={tab.url} />
              <Action.CopyToClipboard content={tab.url} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

void definePlugin({ views: { main: Main } });
`;

const CONTENT_MAIN = `import { definePlugin } from "@ardia/plugin-sdk";

const counts = new Map<string, number>();

void definePlugin({
  activate(ardia) {
    ardia.page.onContentMessage(({ tabId, message }) => {
      const links = (message as { links?: number }).links;
      if (typeof links === "number") counts.set(tabId, links);
    });
  },
  commands: {
    async count(_input, call) {
      const tabId = String(call.context.tabId ?? "");
      return { links: counts.get(tabId) ?? 0 };
    },
  },
});
`;

const CONTENT_SCRIPT = `declare const ardia: { send(message: unknown): void; onMessage(listener: (message: unknown) => void): void };

const links = document.querySelectorAll("a[href]").length;
ardia.send({ links });
`;

const AI_SOURCE = `import { Detail, ardia, definePlugin, useEffect, useState } from "@ardia/plugin-sdk";
import type { ViewProps } from "@ardia/plugin-sdk";

type Completion = { text: string };

async function ask(question: string): Promise<string> {
  const providers = await ardia.services.list("ai.provider");
  if (!providers.length) return "Turn on a plugin that provides ai.provider to get answers.";
  const page = await ardia.page.readActive({ markdown: true });
  const prompt = \`\${question}\\n\\n\${page?.markdown ?? page?.text ?? ""}\`;
  const reply = await ardia.services.call<Completion>("ai.provider", "complete", { prompt });
  return reply.text;
}

function Answer({ context }: ViewProps<{ query?: string }>) {
  const [answer, setAnswer] = useState<string | null>(null);
  useEffect(() => {
    void ask(context.query ?? "").then(setAnswer, (error: Error) => setAnswer(\`Couldn't answer: \${error.message}\`));
  }, [context.query]);
  return <Detail isLoading={answer === null} markdown={answer ?? ""} />;
}

void definePlugin({ views: { ask: Answer } });
`;

const SIDECAR_MAIN = `import { ardia, definePlugin } from "@ardia/plugin-sdk";

void definePlugin({
  activate() {
    ardia.sidecar.onMessage((message) => {
      void ardia.ui.toast("Sidecar", JSON.stringify(message));
    });
  },
  commands: {
    async ping() {
      return { reply: await ardia.sidecar.request("ping") };
    },
  },
});
`;

const SIDECAR_SERVER = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "ping") process.stdout.write(JSON.stringify({ id: message.id, result: "pong" }) + "\\n");
});
`;

const RELEASE_WORKFLOW = `name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npx ardia-plugin release --tag "\${GITHUB_REF_NAME}"
        env:
          GH_TOKEN: \${{ github.token }}
`;

export function templateFiles(template: TemplateName, t: TemplateInput): TemplateFile[] {
  const files: TemplateFile[] = [
    { path: "plugin.json", content: json(manifestFor(template, t)) },
    {
      path: "package.json",
      content: json({
        name: t.id,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { build: "ardia-plugin build", dev: "ardia-plugin dev", check: "ardia-plugin check", pack: "ardia-plugin pack", release: "ardia-plugin release" },
        devDependencies: { "@ardia/plugin-cli": t.cliRange, "@ardia/plugin-sdk": t.sdkRange, typescript: "~5.9.2" },
      }),
    },
    {
      path: "tsconfig.json",
      content: json({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: template === "content-script" ? ["ES2022", "DOM"] : ["ES2022"],
          jsx: "react-jsx",
          jsxImportSource: "@ardia/plugin-sdk",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src"],
      }),
    },
    { path: ".gitignore", content: "node_modules/\ndist/\nrelease/\n" },
    { path: ".github/workflows/release.yml", content: RELEASE_WORKFLOW },
    {
      path: "README.md",
      content: `# ${t.title}\n\nAn Ardia plugin (\`${t.id}\`).\n\n- \`npm run dev\` builds on every change and links the plugin into Ardia.\n- \`npm run check\` checks plugin.json and the files it names.\n- \`npm run pack\` makes the release archive in release/.\n- Push a tag like v0.1.0 and the Release workflow publishes it on GitHub.\n\nSet \`release.github\` in plugin.json to your repository before the first release.\n`,
    },
  ];
  if (template === "ui") files.push({ path: "src/index.tsx", content: UI_SOURCE });
  if (template === "content-script") {
    files.push({ path: "src/index.ts", content: CONTENT_MAIN }, { path: "src/content.ts", content: CONTENT_SCRIPT });
    files.push({ path: "styles/focus.css", content: "a:focus-visible {\n  outline: 2px solid currentColor;\n  outline-offset: 2px;\n}\n" });
  }
  if (template === "ai-consumer") files.push({ path: "src/index.tsx", content: AI_SOURCE });
  if (template === "sidecar") files.push({ path: "src/index.ts", content: SIDECAR_MAIN }, { path: "sidecar/server.mjs", content: SIDECAR_SERVER, executable: true });
  return files;
}
