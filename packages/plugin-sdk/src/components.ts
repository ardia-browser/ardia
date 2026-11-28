import { hostComponent, jsx, type HostComponent, type VNode } from "./element";
import type {
  ActionPanelProps,
  ActionProps,
  CodeBlockProps,
  FileDropZoneProps,
  GridItemProps,
  GridProps,
  GridSectionProps,
  ImageProps,
  ListItemDetailProps,
  TableCellProps,
  TableProps,
  TableRowProps,
  TabProps,
  TabsProps,
  TagListItemProps,
  TagListProps,
  BadgeProps,
  BoxProps,
  ButtonProps,
  CopyToClipboardProps,
  DetailProps,
  DividerProps,
  EmptyStateProps,
  FormProps,
  ListItemProps,
  ListProps,
  ListSectionProps,
  MarkdownProps,
  OpenInBrowserProps,
  PasswordFieldProps,
  PopoverProps,
  ProgressProps,
  SelectProps,
  SidebarItemProps,
  SidebarSectionProps,
  SidebarViewProps,
  TextFieldProps,
  TextProps,
  ToggleProps,
  WebViewProps,
} from "./componentProps";

export const Box: HostComponent<BoxProps> = hostComponent("Box");
export const Text: HostComponent<TextProps> = hostComponent("Text");
export const Markdown: HostComponent<MarkdownProps> = hostComponent("Markdown");
export const Badge: HostComponent<BadgeProps> = hostComponent("Badge");
export const Button: HostComponent<ButtonProps> = hostComponent("Button");
export const Divider: HostComponent<DividerProps> = hostComponent("Divider");
export const EmptyState: HostComponent<EmptyStateProps> = hostComponent("EmptyState");
export const Progress: HostComponent<ProgressProps> = hostComponent("Progress");
export const ActionPanel: HostComponent<ActionPanelProps> = hostComponent("ActionPanel");
export const Popover: HostComponent<PopoverProps> = hostComponent("Popover");
export const WebView: HostComponent<WebViewProps> = hostComponent("WebView");

const ActionHost: HostComponent<ActionProps> = hostComponent("Action");

function OpenInBrowser({ url, title = "Open in Browser", icon = "safari", shortcut }: OpenInBrowserProps): VNode {
  return jsx(ActionHost, { title, icon, url, shortcut });
}

function CopyToClipboard({ content, title = "Copy to Clipboard", icon = "doc.on.doc", shortcut, onCopy }: CopyToClipboardProps): VNode {
  return jsx(ActionHost, { title, icon, copy: content, shortcut, onAction: onCopy });
}

export const Action = Object.assign(ActionHost, { OpenInBrowser, CopyToClipboard });

export const List = Object.assign(hostComponent<ListProps>("List"), {
  Section: hostComponent<ListSectionProps>("ListSection"),
  Item: Object.assign(hostComponent<ListItemProps>("ListItem"), {
    Detail: hostComponent<ListItemDetailProps>("ListItemDetail"),
  }),
});

export const Grid = Object.assign(hostComponent<GridProps>("Grid"), {
  Section: hostComponent<GridSectionProps>("GridSection"),
  Item: hostComponent<GridItemProps>("GridItem"),
});

export const Table = Object.assign(hostComponent<TableProps>("Table"), {
  Row: hostComponent<TableRowProps>("TableRow"),
  Cell: hostComponent<TableCellProps>("TableCell"),
});

export const Tabs = Object.assign(hostComponent<TabsProps>("Tabs"), {
  Tab: hostComponent<TabProps>("Tab"),
});

export const TagList = Object.assign(hostComponent<TagListProps>("TagList"), {
  Item: hostComponent<TagListItemProps>("TagListItem"),
});

export const CodeBlock: HostComponent<CodeBlockProps> = hostComponent("CodeBlock");
export const Image: HostComponent<ImageProps> = hostComponent("Image");
export const FileDropZone: HostComponent<FileDropZoneProps> = hostComponent("FileDropZone");

export const Detail: HostComponent<DetailProps> = hostComponent("Detail");

export const Form = Object.assign(hostComponent<FormProps>("Form"), {
  TextField: hostComponent<TextFieldProps>("TextField"),
  PasswordField: hostComponent<PasswordFieldProps>("PasswordField"),
  Toggle: hostComponent<ToggleProps>("Toggle"),
  Select: hostComponent<SelectProps>("Select"),
});

export const SidebarView = Object.assign(hostComponent<SidebarViewProps>("SidebarView"), {
  Section: hostComponent<SidebarSectionProps>("SidebarSection"),
  Item: hostComponent<SidebarItemProps>("SidebarItem"),
});
