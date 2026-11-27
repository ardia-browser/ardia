import { createExtension } from "@blocknote/core";

export const quoteShortcuts = createExtension({
  key: "quote-block-shortcuts",
  keyboardShortcuts: {
    "Mod-Alt-q": ({ editor }) => {
      const block = editor.getTextCursorPosition().block;
      if (editor.schema.blockSchema[block.type]?.content !== "inline") return false;
      editor.updateBlock(block, { type: "quote", props: {} });
      return true;
    },
  },
  inputRules: [{ find: /^\p{Quotation_Mark}\s$/u, replace: () => ({ type: "quote", props: {} }) }],
});
