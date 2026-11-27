import { BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { databaseBlockSpec } from "../database";
import { codeBlock } from "./blocks/CodeBlock";
import { quoteShortcuts } from "./quote";
import { dividerShortcuts } from "./shortcuts";
import { equationBlock, inlineEquation } from "./blocks/Equation";
import { bookmarkBlock, breadcrumbBlock, calloutBlock, columnBlock, columnListBlock, embedBlock, linkToPageBlock, mentionInline, subpageBlock, tocBlock } from "./blocks/PageBlocks";

const { pageBreak: _pageBreak, codeBlock: _codeBlock, heading: _heading, ...defaults } = defaultBlockSpecs as typeof defaultBlockSpecs & { pageBreak?: unknown };

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaults,
    quote: { ...defaultBlockSpecs.quote, extensions: [quoteShortcuts] },
    divider: { ...defaultBlockSpecs.divider, extensions: [dividerShortcuts] },
    heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4], allowToggleHeadings: true }),
    codeBlock: codeBlock(),
    equation: equationBlock(),
    callout: calloutBlock(),
    subpage: subpageBlock(),
    linkToPage: linkToPageBlock(),
    bookmark: bookmarkBlock(),
    embed: embedBlock(),
    toc: tocBlock(),
    breadcrumb: breadcrumbBlock(),
    columnList: columnListBlock(),
    column: columnBlock(),
    database: databaseBlockSpec(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInline, inlineEquation },
  styleSpecs: defaultStyleSpecs,
});

export type NotesSchema = typeof schema;
export type NotesEditor = NotesSchema["BlockNoteEditor"];
export type NotesBlock = NotesSchema["Block"];
export type NotesPartialBlock = NotesSchema["PartialBlock"];
