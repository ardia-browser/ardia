import { createCodeBlockSpec } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui/icons";
import { Menu } from "../../ui/Menu";

export const LANGUAGES: Record<string, { name: string; aliases?: string[] }> = {
  text: { name: "Plain text", aliases: ["txt", "plain", "plaintext"] },
  bash: { name: "Bash", aliases: ["sh", "shell", "zsh"] },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  css: { name: "CSS" },
  diff: { name: "Diff" },
  docker: { name: "Docker", aliases: ["dockerfile"] },
  go: { name: "Go", aliases: ["golang"] },
  graphql: { name: "GraphQL", aliases: ["gql"] },
  html: { name: "HTML" },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js"] },
  json: { name: "JSON" },
  jsx: { name: "JSX" },
  kotlin: { name: "Kotlin", aliases: ["kt"] },
  latex: { name: "LaTeX", aliases: ["tex"] },
  lua: { name: "Lua" },
  markdown: { name: "Markdown", aliases: ["md"] },
  mermaid: { name: "Mermaid" },
  objc: { name: "Objective-C", aliases: ["objective-c", "objectivec"] },
  php: { name: "PHP" },
  python: { name: "Python", aliases: ["py"] },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  scss: { name: "SCSS" },
  sql: { name: "SQL" },
  swift: { name: "Swift" },
  toml: { name: "TOML" },
  tsx: { name: "TSX" },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  xml: { name: "XML" },
  yaml: { name: "YAML", aliases: ["yml"] },
};

const base = createCodeBlockSpec({ defaultLanguage: "text", supportedLanguages: LANGUAGES, indentLineWithTab: true });

let mermaidModule: Promise<typeof import("mermaid")> | null = null;
let mermaidTheme = "";
let mermaidCount = 0;

async function renderMermaid(source: string): Promise<{ svg: string } | { error: string }> {
  mermaidModule ??= import("mermaid");
  const mermaid = (await mermaidModule).default;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches || getComputedStyle(document.documentElement).colorScheme === "dark";
  const theme = dark ? "dark" : "neutral";
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict", fontFamily: "-apple-system, system-ui, sans-serif" });
    mermaidTheme = theme;
  }
  try {
    await mermaid.parse(source);
    const { svg } = await mermaid.render(`n-mermaid-${++mermaidCount}`, source);
    return { svg };
  } catch (error) {
    document.getElementById(`dn-mermaid-${mermaidCount}`)?.remove();
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function MermaidPreview({ source }: { source: string }) {
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      if (!source.trim()) return setState({});
      void renderMermaid(source).then((result) => live && setState("svg" in result ? { svg: result.svg } : { error: result.error }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source]);
  if (!source.trim()) return <div className="n-mermaid-empty">Write a Mermaid diagram above</div>;
  if (state.error && !state.svg) return <div className="n-mermaid-error">{state.error.split("\n")[0]}</div>;
  return <div className="n-mermaid" contentEditable={false} dangerouslySetInnerHTML={{ __html: state.svg ?? "" }} />;
}

function languageName(id: string) {
  return LANGUAGES[id]?.name ?? id;
}

export const codeBlock = createReactBlockSpec(
  {
    type: "codeBlock",
    propSchema: { language: { default: "text" }, wrap: { default: false }, view: { default: "split", values: ["code", "preview", "split"] } },
    content: "plain",
  },
  {
    meta: { code: true, defining: true, isolating: false, highlight: (block) => (block.props.language === "text" || block.props.language === "mermaid" ? undefined : block.props.language) },
    parse: base.implementation.parse as never,
    parseContent: base.implementation.parseContent,
    render: ({ block, editor, contentRef }) => {
      const [menu, setMenu] = useState<HTMLElement | null>(null);
      const [copied, setCopied] = useState(false);
      const source = block.content.map((c) => c.text).join("");
      const preRef = useRef<HTMLPreElement>(null);
      const mermaid = block.props.language === "mermaid";
      const view = mermaid ? block.props.view : "code";
      const set = (props: Partial<typeof block.props>) => editor.isEditable && editor.updateBlock(block, { props });
      return (
        <div className={`n-code${block.props.wrap ? " is-wrap" : ""}${mermaid ? ` is-mermaid is-${view}` : ""}`} data-language={block.props.language}>
          <div className="n-code-bar" contentEditable={false}>
            <button type="button" className="n-code-lang" onMouseDown={(e) => e.preventDefault()} onClick={(e) => editor.isEditable && setMenu(e.currentTarget)}>
              {languageName(block.props.language)}
              <Icon name="chevronDown" size={12} />
            </button>
            {mermaid ? (
              <div className="n-seg">
                {(["code", "preview", "split"] as const).map((v) => (
                  <button key={v} type="button" className={view === v ? "is-on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => set({ view: v })}>
                    {v[0]!.toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="n-spacer" />
            <button type="button" className="n-code-action" title="Wrap code" aria-pressed={block.props.wrap} onMouseDown={(e) => e.preventDefault()} onClick={() => set({ wrap: !block.props.wrap })}>
              <Icon name="wrap" size={14} />
            </button>
            <button
              type="button"
              className="n-code-action"
              title="Copy code"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void navigator.clipboard?.writeText(source).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : <Icon name="copy" size={14} />}
            </button>
          </div>
          <pre ref={preRef} className="n-code-pre">
            <code ref={contentRef} />
          </pre>
          {mermaid && view !== "code" ? <MermaidPreview source={source} /> : null}
          {menu ? (
            <Menu
              anchor={menu}
              onClose={() => setMenu(null)}
              search
              searchPlaceholder="Search for a language…"
              width={220}
              entries={Object.entries(LANGUAGES).map(([id, info]) => ({ id: `lang-${id}`, label: info.name, aliases: info.aliases, checked: id === block.props.language, onSelect: () => set({ language: id }) }))}
            />
          ) : null}
        </div>
      );
    },
    toExternalHTML: ({ block }) => (
      <pre>
        <code className={`language-${block.props.language}`}>{block.content.map((c) => c.text).join("")}</code>
      </pre>
    ),
  },
  base.extensions as never,
);
