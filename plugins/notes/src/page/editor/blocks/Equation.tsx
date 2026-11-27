import "katex/dist/katex.min.css";
import { createReactBlockSpec, createReactInlineContentSpec, SourceBlockWithPreview, SourceInlineContentWithPreview } from "@blocknote/react";
import { useEffect, useMemo, useState } from "react";

type Katex = typeof import("katex").default;
let katex: Katex | null = null;
let katexLoading: Promise<Katex> | null = null;
const loadKatex = () =>
  (katexLoading ??= import("katex")
    .then((m) => (katex = m.default))
    .catch((error: unknown) => {
      katexLoading = null;
      throw error;
    }));

export function renderTex(source: string, displayMode: boolean): { html: string; error: string | null } {
  if (!katex) return { html: "", error: null };
  try {
    return { html: katex.renderToString(source, { displayMode, throwOnError: true, strict: "ignore", output: "htmlAndMathml" }), error: null };
  } catch (error) {
    return { html: "", error: error instanceof Error ? error.message.replace(/^KaTeX parse error: /, "") : String(error) };
  }
}

function useTex({ source, display }: { source: string; display: boolean }) {
  const [ready, setReady] = useState(!!katex);
  useEffect(() => {
    if (!ready) void loadKatex().then(() => setReady(true), () => {});
  }, [ready]);
  const result = useMemo(() => renderTex(source, display), [source, display, ready]);
  return { preview: result.html ? <span className={display ? "n-tex n-tex-block" : "n-tex"} dangerouslySetInnerHTML={{ __html: result.html }} /> : undefined, error: result.error };
}

export const equationBlock = createReactBlockSpec(
  { type: "equation", propSchema: {}, content: "plain" },
  {
    meta: { hasPreview: true, code: true },
    render: ({ block, editor, contentRef }) => {
      const source = block.content.map((c) => c.text).join("");
      const { preview, error } = useTex({ source, display: true });
      return (
        <div className="n-equation">
          <SourceBlockWithPreview
            block={block}
            editor={editor}
            contentRef={contentRef}
            source={source}
            preview={preview}
            error={error}
            emptySourcePlaceholder="Add a TeX equation"
            errorPreview="Invalid equation"
            sourcePlaceholder="E = mc^2"
          />
        </div>
      );
    },
  },
);

export const inlineEquation = createReactInlineContentSpec(
  { type: "inlineEquation", propSchema: {}, content: "plain" },
  {
    meta: { hasPreview: true, code: true },
    render: ({ inlineContent, editor, node, getPos, contentRef }) => {
      const source = typeof inlineContent.content === "string" ? inlineContent.content : "";
      const { preview, error } = useTex({ source, display: false });
      return (
        <SourceInlineContentWithPreview
          editor={editor}
          node={node}
          getPos={getPos}
          contentRef={contentRef}
          source={source}
          preview={preview}
          error={error}
          emptySourcePlaceholder="New equation"
          errorPreview="Invalid equation"
          sourcePlaceholder="x^2"
        />
      );
    },
  },
);
