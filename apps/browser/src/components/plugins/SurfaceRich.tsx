import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, View, type ImageResizeMode } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { copyText } from "../../state/app/system";
import { droppedFilePaths, dropFilesOnPluginView, pickFilesForPluginView, pluginCanPickFiles, pluginImage } from "../../state/plugins/actions";
import { ActivitySpinner, Badge, Box, Button, Divider, FileDropArea, monoFace, Segmented, space, Text, useTheme, type DropUpdate } from "../ui";
import { SurfaceIcon } from "./SurfaceBasics";
import { SurfaceMarkdown } from "./SurfaceMarkdown";
import { SURFACE } from "./tokens";
import { codeTokens, type CodeTone } from "./codeTokens";
import { bool, fillToneOf, flattenNodes, isHandlerRef, isNode, num, records, spaceOf, str, strings, textOf, toneOf, useSurface } from "./surfaceNodes";

type NodeProps = { node: PluginNode };

function usePluginImage(plugin: string, src: string | undefined): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUri(null);
    void pluginImage(plugin, src).then((loaded) => live && setUri(loaded));
    return () => {
      live = false;
    };
  }, [plugin, src]);
  return uri;
}

const ASPECT: Record<string, number> = { "1": 1, "3/2": 1.5, "2/3": 2 / 3, "4/3": 4 / 3, "3/4": 0.75, "16/9": 16 / 9, "9/16": 9 / 16 };
const FITS: Record<string, ImageResizeMode> = { contain: "contain", cover: "cover", fill: "stretch" };

export function ListItemDetailNode({ node }: NodeProps) {
  const { render } = useSurface();
  const p = node.props;
  const markdown = str(p.markdown);
  return (
    <Box gap="m" pad="m">
      {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
      {markdown ? <SurfaceMarkdown source={markdown} /> : null}
      {records(p.metadata).length ? <Divider /> : null}
      {records(p.metadata).map((row, index) => (
        <Box key={index} row gap="s">
          <Text size="small" tone="textTertiary" style={META_LABEL}>{str(row.title) ?? str(row.label) ?? ""}</Text>
          <Text size="small" selectable style={FLEX}>{str(row.text) ?? str(row.value) ?? ""}</Text>
        </Box>
      ))}
      {node.children.map(render)}
    </Box>
  );
}

function GridCell({ item, columns, aspect, fit }: { item: PluginNode; columns: number; aspect: number; fit: ImageResizeMode }) {
  const { plugin, fire } = useSurface();
  const theme = useTheme();
  const p = item.props;
  const content = p.content;
  const source = typeof content === "string" ? content : str((content as Record<string, unknown> | null)?.source);
  const color = str((content as Record<string, unknown> | null)?.color);
  const uri = usePluginImage(plugin, source);
  const tile = (
    <View style={{ width: `${100 / columns}%`, padding: space.xs }}>
      <View style={{ aspectRatio: aspect, borderRadius: space.s, overflow: "hidden", backgroundColor: color ?? theme.chipFill, alignItems: "center", justifyContent: "center" }}>
        {uri ? <Image source={{ uri }} resizeMode={fit} style={FILL} /> : !color && source ? <SurfaceIcon name={source} size={SURFACE.iconBox * 2} /> : null}
      </View>
      {str(p.title) ? <Text size="small" numberOfLines={1}>{str(p.title)}</Text> : null}
      {str(p.subtitle) ? <Text size="caption" tone="textTertiary" numberOfLines={1}>{str(p.subtitle)}</Text> : null}
    </View>
  );
  return isHandlerRef(p.onSelect) ? <Pressable key={str(p.id)} onPress={() => fire(p.onSelect)} style={{ width: `${100 / columns}%` }}>{tile}</Pressable> : tile;
}

export function GridNode({ node }: NodeProps) {
  const { render } = useSurface();
  const p = node.props;
  const columns = Math.min(8, Math.max(1, num(p.columns) ?? 4));
  const aspect = ASPECT[str(p.aspectRatio) ?? "1"] ?? 1;
  const fit = FITS[str(p.fit) ?? "contain"] ?? "contain";
  const parts = flattenNodes(node.children, (n) => n.type === "GridSection" || n.type === "GridItem");
  if (!parts.length) return isNode(p.emptyView) ? render(p.emptyView, 0) : null;
  return (
    <ScrollView style={FIT_SCROLL}>
      {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
      {parts.map((part, index) =>
        part.type === "GridItem" ? (
          <View key={index} style={WRAP_ROW}>
            <GridCell item={part} columns={columns} aspect={aspect} fit={fit} />
          </View>
        ) : (
          <Box key={index} gap="xs">
            {str(part.props.title) ? <Text size="caption" weight="semibold" tone="textSecondary">{str(part.props.title)}</Text> : null}
            <View style={WRAP_ROW}>
              {flattenNodes(part.children, (n) => n.type === "GridItem").map((item, at) => (
                <GridCell key={at} item={item} columns={Math.min(8, Math.max(1, num(part.props.columns) ?? columns))} aspect={aspect} fit={fit} />
              ))}
            </View>
          </Box>
        ),
      )}
    </ScrollView>
  );
}

export function TableNode({ node }: NodeProps) {
  const { fire, render } = useSurface();
  const theme = useTheme();
  const p = node.props;
  const columns = records(p.columns).flatMap((c) => (str(c.id) ? [{ id: str(c.id)!, title: str(c.title) ?? "", width: num(c.width), align: str(c.align), sortable: bool(c.sortable) }] : []));
  const rows = flattenNodes(node.children, (n) => n.type === "TableRow");
  const sortColumn = str(p.sortColumn);
  const direction = p.sortDirection === "descending" ? "descending" : "ascending";
  const cellAlign = (align?: string) => (align === "end" ? "right" : align === "center" ? "center" : "left");
  const cellStyle = (width?: number) => (width ? { width } : FLEX);
  return (
    <ScrollView style={FIT_SCROLL}>
      <Box row padX="s" padY="xs">
        {columns.map((c) => (
          <Pressable key={c.id} style={cellStyle(c.width)} disabled={!c.sortable || !isHandlerRef(p.onSortChange)} onPress={() => fire(p.onSortChange, [c.id, sortColumn === c.id && direction === "ascending" ? "descending" : "ascending"])}>
            <Text size="caption" weight="semibold" tone="textSecondary" style={{ textAlign: cellAlign(c.align) }}>
              {c.title + (sortColumn === c.id ? (direction === "ascending" ? " ▲" : " ▼") : "")}
            </Text>
          </Pressable>
        ))}
      </Box>
      <Divider />
      {rows.length ? (
        rows.map((row, index) => {
          const cells = flattenNodes(row.children, (n) => n.type === "TableCell");
          const selected = str(p.selectedRowId) !== undefined && str(row.props.id) === str(p.selectedRowId);
          return (
            <Pressable key={str(row.props.id) ?? index} onPress={() => (isHandlerRef(row.props.onSelect) ? fire(row.props.onSelect) : isHandlerRef(p.onSelectionChange) ? fire(p.onSelectionChange, [str(row.props.id) ?? null]) : undefined)}>
              <Box row padX="s" padY="xs" style={selected ? { backgroundColor: theme.tabSelected } : undefined}>
                {columns.map((c, at) => {
                  const cell = cells.find((x) => str(x.props.column) === c.id) ?? cells[at];
                  return (
                    <View key={c.id} style={[cellStyle(c.width), ROW_CENTER]}>
                      {cell ? <SurfaceIcon name={str(cell.props.icon)} tone={cell.props.tone} /> : null}
                      <Text size="small" numberOfLines={1} tone={toneOf(cell?.props.tone)} style={[{ textAlign: cellAlign(c.align), flexShrink: 1 }, bool(cell?.props.monospace) ? monoFace() : null]}>
                        {cell ? textOf(cell.children) : ""}
                      </Text>
                    </View>
                  );
                })}
              </Box>
            </Pressable>
          );
        })
      ) : isNode(p.emptyView) ? (
        render(p.emptyView, 0)
      ) : null}
      {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
    </ScrollView>
  );
}

export function TabsNode({ node }: NodeProps) {
  const { fire, render } = useSurface();
  const p = node.props;
  const tabs = flattenNodes(node.children, (n) => n.type === "Tab").filter((t) => str(t.props.id));
  const [own, setOwn] = useState(str(p.defaultTabId) ?? str(tabs[0]?.props.id) ?? "");
  const selected = str(p.selectedTabId) ?? own;
  const current = tabs.find((t) => str(t.props.id) === selected) ?? tabs[0];
  if (!current) return null;
  const choose = (id: string) => {
    setOwn(id);
    if (isHandlerRef(p.onChange)) fire(p.onChange, [id]);
  };
  return (
    <Box gap="s">
      <Segmented options={tabs.map((t) => ({ value: str(t.props.id)!, title: str(t.props.badge) ? `${str(t.props.title) ?? ""} ${str(t.props.badge)}` : (str(t.props.title) ?? "") }))} value={str(current.props.id)!} onChange={choose} />
      <View>{current.children.map(render)}</View>
    </Box>
  );
}

const CODE_ROLES: Record<CodeTone, "accent" | "success" | "warning" | "textTertiary" | "textPrimary" | "destructive"> = {
  keyword: "accent",
  string: "success",
  number: "warning",
  comment: "textTertiary",
  plain: "textPrimary",
  punctuation: "textPrimary",
};

export function CodeBlockNode({ node }: NodeProps) {
  const theme = useTheme();
  const p = node.props;
  const code = str(p.code) ?? textOf(node.children);
  const language = str(p.language) ?? "";
  const maxLines = num(p.maxLines);
  const lines = useMemo(() => {
    const all = code.split("\n");
    return maxLines ? all.slice(0, maxLines) : all;
  }, [code, maxLines]);
  const tokens = useMemo(() => lines.map((line) => codeTokens(line, language)), [lines, language]);
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ borderRadius: space.s, backgroundColor: theme.chipFill, padding: space.s }}>
      <Box row style={BETWEEN}>
        <Text size="caption" tone="textTertiary">{language}</Text>
        {p.copyable === false ? null : (
          <Button
            title={copied ? "Copied" : "Copy"}
            icon="doc.on.doc"
            kind="plain"
            onPress={() => {
              copyText(code);
              setCopied(true);
            }}
          />
        )}
      </Box>
      <ScrollView horizontal={!bool(p.wrap)}>
        <View>
          {tokens.map((parts, index) => (
            <Text key={index} size="small" selectable style={monoFace()} numberOfLines={bool(p.wrap) ? undefined : 1}>
              {bool(p.lineNumbers) ? <Text size="small" tone="textTertiary" style={monoFace()}>{`${String(index + 1).padStart(3, " ")}  `}</Text> : null}
              {parts.map((part, at) => (
                <Text key={at} size="small" tone={CODE_ROLES[part.tone]} style={monoFace()}>{part.text}</Text>
              ))}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function ImageNode({ node }: NodeProps) {
  const { plugin, fire } = useSurface();
  const p = node.props;
  const uri = usePluginImage(plugin, str(p.source));
  const radiusSpace = spaceOf(p.radius);
  if (!uri) return <Text size="small" tone="textTertiary">{str(p.alt) ?? "This image isn't from a host the plugin may reach."}</Text>;
  const image = (
    <Image
      source={{ uri }}
      accessibilityLabel={str(p.alt)}
      resizeMode={FITS[str(p.fit) ?? "contain"] ?? "contain"}
      style={{ width: num(p.width) ?? "100%", height: num(p.height) ?? 160, borderRadius: radiusSpace ? space[radiusSpace] : undefined }}
    />
  );
  return isHandlerRef(p.onPress) ? <Pressable onPress={() => fire(p.onPress)}>{image}</Pressable> : image;
}

export function TagListNode({ node }: NodeProps) {
  const { fire } = useSurface();
  const theme = useTheme();
  const items = flattenNodes(node.children, (n) => n.type === "TagListItem");
  return (
    <Box gap="xs">
      {str(node.props.title) ? <Text size="caption" tone="textTertiary">{str(node.props.title)}</Text> : null}
      <View style={node.props.wrap === false ? ROW_CENTER : WRAP_ROW}>
        {items.map((item, index) => {
          const role = fillToneOf(item.props.color);
          const text = str(item.props.text) ?? textOf(item.children);
          const badge = <Badge text={text} fill={role ? theme[role] : undefined} color={role ? theme.onAccent : undefined} tone="chip" />;
          return (
            <View key={index} style={TAG}>
              {isHandlerRef(item.props.onPress) ? <Pressable onPress={() => fire(item.props.onPress)}>{badge}</Pressable> : badge}
            </View>
          );
        })}
      </View>
    </Box>
  );
}

export function FileDropZoneNode({ node }: NodeProps) {
  const { plugin, surfaceId, windowId, fire } = useSurface();
  const theme = useTheme();
  const p = node.props;
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const allowed = pluginCanPickFiles(plugin) && !bool(p.disabled);
  const options = { accept: strings(p.accept), multiple: bool(p.multiple), maxBytes: num(p.maxBytes) ?? null };
  const hand = async (load: () => ReturnType<typeof pickFilesForPluginView>) => {
    if (!allowed || busy) return;
    setBusy(true);
    const files = await load();
    setBusy(false);
    if (files?.length && isHandlerRef(p.onDrop)) fire(p.onDrop, [files]);
  };
  const onDropUpdate = (e: DropUpdate) => {
    if (e.phase === "enter" || e.phase === "move") return setOver(true);
    setOver(false);
    if (e.phase !== "drop") return;
    const paths = droppedFilePaths(e.items);
    if (paths.length) void hand(() => dropFilesOnPluginView(plugin, surfaceId, windowId, paths, options));
  };
  const zone = { borderWidth: 1, borderStyle: "dashed", borderColor: over ? theme.accent : theme.divider, borderRadius: space.s, opacity: allowed ? 1 : 0.5 } as const;
  return (
    <FileDropArea accepts="files" enabled={allowed && !busy} onDropUpdate={onDropUpdate}>
      <Pressable onPress={() => void hand(() => pickFilesForPluginView(plugin, surfaceId, windowId, options))} disabled={!allowed}>
        <Box gap="xs" pad="l" center style={zone}>
          {busy ? <ActivitySpinner style={SPINNER} /> : <SurfaceIcon name={str(p.icon) ?? "tray.and.arrow.down"} size={SURFACE.iconBox * 1.5} />}
          <Text weight="medium">{str(p.title) ?? "Choose or drop files"}</Text>
          {str(p.description) ? <Text size="small" tone="textTertiary">{str(p.description)}</Text> : null}
        </Box>
      </Pressable>
    </FileDropArea>
  );
}

const FLEX = { flex: 1 } as const;
const FILL = { width: "100%", height: "100%" } as const;
const FIT_SCROLL = { flexGrow: 0, flexShrink: 1 } as const;
const ROW_CENTER = { flexDirection: "row", alignItems: "center", gap: space.xs } as const;
const WRAP_ROW = { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" } as const;
const BETWEEN = { justifyContent: "space-between", alignItems: "center" } as const;
const TAG = { marginRight: space.xs, marginBottom: space.xs } as const;
const META_LABEL = { width: SURFACE.metaLabel } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
