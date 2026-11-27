import type { BlockSpec } from "../blocks";
import type { CalcFn, Color, DateFormat, FilterCond, GroupBy, NumberFormat, PropType, RollupFn, StatusGroup, View, ViewType } from "../database";

export type TemplateCategory = "personal" | "work" | "school" | "creative" | "planning";

export type OptionSpec = string | { name: string; color?: Color; group?: StatusGroup };

export type PropSpec = {
  key: string;
  name: string;
  type: Exclude<PropType, "title">;
  options?: OptionSpec[];
  format?: NumberFormat;
  display?: "number" | "bar" | "ring";
  divideBy?: number;
  barColor?: Color;
  showNumber?: boolean;
  dateFormat?: DateFormat;
  timeFormat?: "12" | "24" | "hidden";
  expression?: string;
  relation?: string;
  twoWay?: string;
  rollup?: { relation: string; target: string; fn: RollupFn };
  prefix?: string;
  description?: string;
};

export type DateCell = { d: number; end?: number; at?: string; endAt?: string };
export type CellValue = string | number | boolean | string[] | DateCell | null;

export type RowSpec = { key?: string; title: string; icon?: string; cover?: string; values?: Record<string, CellValue>; blocks?: BlockSpec[] };
export type RowTemplateSpec = RowSpec & { isDefault?: boolean };

export type FilterSpec = { prop: string; cond: FilterCond; value?: unknown } | { any: FilterSpec[] } | { all: FilterSpec[] };

export type GroupSpec = { prop: string; date?: GroupBy["date"]; status?: GroupBy["status"]; hideEmpty?: boolean; sort?: GroupBy["sort"] };

export type ViewSpec = {
  key?: string;
  name: string;
  type: ViewType;
  filter?: FilterSpec[];
  filterOp?: "and" | "or";
  sorts?: { prop: string; dir: "asc" | "desc" }[];
  group?: GroupSpec;
  subGroup?: GroupSpec;
  show?: string[];
  hide?: string[];
  widths?: Record<string, number>;
  calcs?: Record<string, CalcFn>;
  date?: string;
  end?: string;
  zoom?: View["zoom"];
  showTable?: boolean;
  showWeekends?: boolean;
  cardPreview?: "none" | "cover" | "content";
  cardSize?: View["cardSize"];
  fitImage?: boolean;
  colorColumns?: boolean;
  wrap?: boolean;
  chart?: { type: View["chartType"]; by: string; agg?: View["chartAgg"]; value?: string };
  limit?: number;
};

export type DatabaseSpec = {
  kind: "database";
  key?: string;
  title: string;
  icon?: string;
  cover?: string;
  description?: string;
  inline?: boolean;
  titleName?: string;
  openAs?: "side" | "center" | "full";
  properties: PropSpec[];
  views: ViewSpec[];
  rows: RowSpec[];
  rowTemplates?: RowTemplateSpec[];
};

export type PageSpec = {
  kind: "page";
  key?: string;
  title: string;
  icon?: string;
  cover?: string;
  font?: "default" | "serif" | "mono";
  fullWidth?: boolean;
  smallText?: boolean;
  blocks: BlockSpec[];
  children?: NodeSpec[];
};

export type NodeSpec = PageSpec | DatabaseSpec;

export type TemplateSpec = {
  id: string;
  title: string;
  description: string;
  category: TemplateCategory;
  tags?: string[];
  root: NodeSpec;
};

export type TemplateSummary = {
  id: string;
  title: string;
  description: string;
  category: TemplateCategory;
  icon: string;
  cover: string;
  kind: "page" | "database";
  tags: string[];
  pages: number;
  databases: number;
  views: ViewType[];
};
