import { memo, useMemo } from "react";
import { ScrollView, Text as NativeText, View, type TextStyle } from "react-native";
import { parseMarkdown, type MarkdownBlock, type MarkdownListItem, type MarkdownSpan } from "../../lib/pluginMarkdown";
import { newTab } from "../../state/tabs/actions";
import { Box, Divider, monoFace, space, Text, useLiveAction, useTheme, weight, type TypeSize } from "../ui";
import { SURFACE } from "./tokens";
import { useSurface } from "./surfaceNodes";

const HEADING_SIZE: Record<1 | 2 | 3, TypeSize> = { 1: "large", 2: "title", 3: "body" };

export const SurfaceMarkdown = memo(function SurfaceMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <Blocks blocks={blocks} />;
});

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return (
    <Box gap="m">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </Box>
  );
}

function BlockView({ block }: { block: MarkdownBlock }) {
  const theme = useTheme();
  switch (block.kind) {
    case "heading":
      return (
        <Text size={HEADING_SIZE[block.level]} weight={block.level === 3 ? "semibold" : "bold"} selectable accessibilityRole="header">
          <Spans spans={block.spans} />
        </Text>
      );
    case "paragraph":
      return (
        <Text selectable style={SHRINK}>
          <Spans spans={block.spans} />
        </Text>
      );
    case "code":
      return (
        <Box fill="chipFill" radius="control">
          <ScrollView horizontal contentContainerStyle={CODE_PAD}>
            <Text size="small" selectable style={monoFace()}>
              {block.text}
            </Text>
          </ScrollView>
        </Box>
      );
    case "list":
      return (
        <Box gap="xs">
          {block.items.map((item, index) => (
            <ListItem key={index} item={item} />
          ))}
        </Box>
      );
    case "quote":
      return (
        <Box row gap="s">
          <View style={[QUOTE_BAR, { backgroundColor: theme.divider }]} />
          <View style={FLEX}>
            <Blocks blocks={block.blocks} />
          </View>
        </Box>
      );
    case "rule":
      return <Divider />;
  }
}

function ListItem({ item }: { item: MarkdownListItem }) {
  return (
    <Box row gap="xs" style={{ paddingLeft: item.depth * SURFACE.indent }}>
      <Text tone="textSecondary" style={MARKER}>
        {item.marker}
      </Text>
      <Text selectable style={FLEX}>
        <Spans spans={item.spans} />
      </Text>
    </Box>
  );
}

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <Span key={index} span={span} />
      ))}
    </>
  );
}

function Span({ span }: { span: MarkdownSpan }) {
  const theme = useTheme();
  const { windowId } = useSurface();
  const live = useLiveAction();
  const url = span.url;
  if (!span.bold && !span.italic && !span.code && !url) return <>{span.text}</>;
  const style: TextStyle = {
    fontWeight: span.bold ? weight.bold : undefined,
    fontStyle: span.italic ? "italic" : undefined,
    color: url ? theme.accent : undefined,
    textDecorationLine: url ? "underline" : undefined,
    backgroundColor: span.code ? theme.chipFill : undefined,
    ...(span.code ? monoFace() : null),
  };
  return (
    <NativeText style={style} accessibilityRole={url ? "link" : undefined} onPress={url ? live(() => newTab(windowId, { url })) : undefined}>
      {span.text}
    </NativeText>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const MARKER = { minWidth: SURFACE.indent } as const;
const CODE_PAD = { padding: space.s } as const;
const QUOTE_BAR = { width: space.xxs, alignSelf: "stretch", borderRadius: space.xxs } as const;
