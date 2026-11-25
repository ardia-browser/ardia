import type { Renderable, VNode } from "./element";
import type { Size, Space, Tone } from "./protocol";

type Awaitable<T> = T | Promise<T>;
type Handler<A extends unknown[] = []> = (...args: A) => Awaitable<unknown>;

export type Icon = string;
export type Shortcut = string;

export type BoxProps = {
  direction?: "row" | "column";
  gap?: Space;
  padding?: Space;
  paddingX?: Space;
  paddingY?: Space;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  grow?: boolean;
  background?: "none" | "subtle" | "raised" | "accent";
  radius?: Space;
  onPress?: Handler;
  children?: Renderable;
};

export type TextProps = {
  size?: Size;
  tone?: Tone;
  weight?: "regular" | "medium" | "semibold" | "bold";
  monospace?: boolean;
  lines?: number;
  align?: "start" | "center" | "end";
  selectable?: boolean;
  children?: Renderable;
};

export type MarkdownProps = { markdown?: string; children?: string | string[] };

export type BadgeProps = { tone?: Tone; icon?: Icon; children?: Renderable };

export type ButtonProps = {
  title: string;
  icon?: Icon;
  tone?: Tone;
  variant?: "primary" | "secondary" | "plain";
  disabled?: boolean;
  loading?: boolean;
  shortcut?: Shortcut;
  onPress?: Handler;
};

export type DividerProps = { spacing?: Space; label?: string };

export type EmptyStateProps = { icon?: Icon; title: string; description?: string; tone?: Tone; actions?: VNode };

export type ProgressProps = { value?: number; total?: number; label?: string; tone?: Tone };

export type ActionPanelProps = { title?: string; children?: Renderable };

export type ActionProps = {
  title: string;
  icon?: Icon;
  shortcut?: Shortcut;
  tone?: Tone;
  destructive?: boolean;
  url?: string;
  copy?: string;
  onAction?: Handler;
};

export type OpenInBrowserProps = { url: string; title?: string; icon?: Icon; shortcut?: Shortcut };

export type CopyToClipboardProps = { content: string; title?: string; icon?: Icon; shortcut?: Shortcut; onCopy?: Handler };

export type ListAccessory = { text?: string; icon?: Icon; tag?: string; tone?: Tone; tooltip?: string };

export type ListProps = {
  searchBarPlaceholder?: string;
  searchText?: string;
  filtering?: boolean;
  isLoading?: boolean;
  isShowingDetail?: boolean;
  selectedItemId?: string;
  onSearchTextChange?: Handler<[text: string]>;
  onSelectionChange?: Handler<[id: string | null]>;
  actions?: VNode;
  emptyView?: VNode;
  children?: Renderable;
};

export type ListSectionProps = { title?: string; subtitle?: string; children?: Renderable };

export type ListItemProps = {
  id?: string;
  title: string;
  subtitle?: string;
  icon?: Icon;
  accessories?: ListAccessory[];
  keywords?: string[];
  actions?: VNode;
  detail?: VNode;
  onSelect?: Handler;
};

export type DetailMetadata = { label: string; text?: string; icon?: Icon; tone?: Tone; url?: string };

export type DetailProps = {
  markdown?: string;
  isLoading?: boolean;
  metadata?: DetailMetadata[];
  actions?: VNode;
  children?: Renderable;
};

export type FormValues = Record<string, string | boolean | undefined>;

export type FormProps = {
  submitTitle?: string;
  isLoading?: boolean;
  onSubmit?: Handler<[values: FormValues]>;
  actions?: VNode;
  children?: Renderable;
};

type FieldBase = { id: string; title?: string; info?: string; error?: string; disabled?: boolean; autoFocus?: boolean };

export type TextFieldProps = FieldBase & {
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  multiline?: boolean;
  onChange?: Handler<[value: string]>;
};

export type PasswordFieldProps = FieldBase & {
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: Handler<[value: string]>;
};

export type ToggleProps = FieldBase & { label?: string; value?: boolean; defaultValue?: boolean; onChange?: Handler<[value: boolean]> };

export type SelectOption = { value: string; title: string; icon?: Icon };

export type SelectProps = FieldBase & {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: Handler<[value: string]>;
};

export type SidebarViewProps = { title?: string; isLoading?: boolean; actions?: VNode; children?: Renderable };

export type SidebarSectionProps = {
  title?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  actions?: VNode;
  children?: Renderable;
};

export type SidebarItemProps = {
  id?: string;
  title: string;
  subtitle?: string;
  icon?: Icon;
  badge?: string | number;
  tone?: Tone;
  selected?: boolean;
  onPress?: Handler;
  actions?: VNode;
  children?: Renderable;
};

export type PopoverProps = { title?: string; width?: number; height?: number; children?: Renderable };

export type WebViewProps = {
  src?: string;
  html?: string;
  height?: number;
  themed?: boolean;
  onMessage?: Handler<[message: unknown]>;
};
