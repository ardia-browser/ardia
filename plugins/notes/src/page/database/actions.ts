import * as Y from "yjs";
import type { PageId } from "../../shared/protocol";
import { archivePage, getPage, movePage, pagesOf, setProp, type PageMeta } from "../../shared/model";
import {
  addOption,
  addProperty,
  addRelationProperty,
  addView,
  createRow,
  deleteProperty,
  duplicateProperty,
  duplicateRowProps,
  duplicateView,
  deleteView,
  isEditable,
  moveToGroupValue,
  retypeProperty,
  setCell,
  setRelation,
  setViewProp,
  TITLE,
  unlinkBackRelation,
  updateView,
  type Property,
  type PropType,
  type View,
  type ViewType,
  NONE,
  groupValueFor,
  prefillForFilter,
  findOptionByName,
  renameProperty,
} from "../../shared/database";
import type { DatabaseModel } from "./data";

export function createActions(m: DatabaseModel) {
  const by = m.me.deviceId;
  const prop = (id: string) => m.schema.find((p) => p.id === id);

  const setValue = (row: PageId, p: Property, value: unknown) => {
    if (p.type === "relation") setRelation(m.tree, row, p, Array.isArray(value) ? (value as string[]) : [], by);
    else setCell(m.tree, row, p, value, by);
  };

  const addRow = async (input: { after?: PageId | null; props?: Record<string, unknown>; title?: string; template?: PageId | null; view?: View; group?: { prop: string; key: string } } = {}): Promise<PageId> => {
    const given: Record<string, unknown> = { ...(input.props ?? {}) };
    if (input.group) {
      const gp = prop(input.group.prop);
      if (gp && isEditable(gp.type) && gp.type !== "title") {
        if (input.group.key === NONE) given[gp.id] = gp.type === "checkbox" ? false : gp.type === "multi_select" || gp.type === "person" || gp.type === "relation" ? [] : null;
        else given[gp.id] = gp.type === "multi_select" || gp.type === "person" || gp.type === "relation" ? [input.group.key] : groupValueFor(m.ctx, gp, input.group.key);
      }
    }
    const props = Object.fromEntries(Object.entries(input.view ? prefillForFilter(m.ctx, input.view.filter, given) : given).filter(([, v]) => v !== null));
    const templateId = input.template === undefined ? m.settings.defaultTemplate || null : input.template;
    const template = templateId ? m.templates.find((t) => t.id === templateId) : undefined;
    if (template) {
      const merged = { ...duplicateRowProps(template, m.schema), ...props };
      const { page } = await m.client.call("createPage", { workspace: m.workspace, parent: m.source, kind: "page", title: input.title ?? template.title, props: merged, template: template.id, ...(input.after ? { after: input.after } : {}) });
      m.tree.transact(() => {
        pagesOf(m.tree).get(page)?.set("isTemplate", false);
        for (const p of m.schema) if (p.type === "id") setProp(m.tree, page, p.id, nextFree(m, p.id), by);
      });
      return page;
    }
    return createRow(m.tree, m.source, m.schema, { by, props, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.after !== undefined ? { after: input.after } : {}) });
  };

  const addTemplate = (title = "New template") => createRow(m.tree, m.source, [], { by, title, isTemplate: true });

  const deleteRows = (ids: PageId[]) => {
    m.tree.transact(() => {
      for (const id of ids) archivePage(m.tree, id, by);
    });
  };

  const duplicateRows = async (ids: PageId[]) => {
    const out: PageId[] = [];
    for (const id of ids) {
      const { page } = await m.client.call("duplicatePage", { workspace: m.workspace, page: id });
      for (const p of m.schema) if (p.type === "id") setProp(m.tree, page, p.id, nextFree(m, p.id), by);
      out.push(page);
    }
    return out;
  };

  const moveRow = (row: PageId, after: PageId | null) => {
    movePage(m.tree, row, m.source, after, by);
  };

  const moveToGroup = (row: PageMeta, groupProp: string, from: string, to: string) => {
    const p = prop(groupProp);
    if (!p || !isEditable(p.type) || p.type === "title") return;
    const value = moveToGroupValue(m.ctx, row, p, from, to);
    setValue(row.id, p, value);
  };

  const newProperty = (type: PropType, options: { name?: string; after?: string | null; view?: View } = {}) => {
    let id: string;
    if (type === "relation") id = addRelationProperty(m.schemaDoc, { target: m.source, source: m.source, twoWay: false, name: options.name ?? "Relation" });
    else id = addProperty(m.schemaDoc, { type, ...(options.name ? { name: options.name } : {}), ...(type === "id" ? { prefix: "" } : {}) }, options.after !== undefined ? { after: options.after } : {});
    if (options.view) setViewProp(m.doc, options.view.id, id, { visible: true });
    if (type === "id") {
      const sorted = [...m.rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      m.tree.transact(() => sorted.forEach((r, i) => setProp(m.tree, r.id, id, i + 1, by)));
    }
    return id;
  };

  const removeProperty = (id: string) => {
    const p = prop(id);
    if (!p || id === TITLE) return;
    if (p.type === "relation" && p.twoWay && p.backProp) {
      const target = m.docFor(p.relation);
      if (target) unlinkBackRelation(target, p.backProp);
    }
    deleteProperty(m.schemaDoc, id);
  };

  const changeType = (id: string, type: PropType) => {
    const p = prop(id);
    if (!p) return;
    if (type === "relation") {
      retypeProperty(m.schemaDoc, m.tree, m.source, p, type, by, m.ctx);
      m.schemaDoc.transact(() => {
        const entry = m.schemaDoc.getMap<Y.Map<unknown>>("schema").get(id);
        entry?.set("relation", m.source);
      });
      return;
    }
    retypeProperty(m.schemaDoc, m.tree, m.source, p, type, by, m.ctx);
  };

  const ensureOption = (p: Property, name: string) => findOptionByName(p, name)?.id ?? addOption(m.schemaDoc, p.id, name, p.type === "status" ? { group: "todo" } : {});

  return {
    by,
    setValue,
    addRow,
    addTemplate,
    deleteRows,
    duplicateRows,
    moveRow,
    moveToGroup,
    newProperty,
    removeProperty,
    changeType,
    ensureOption,
    duplicateProperty: (id: string) => duplicateProperty(m.schemaDoc, id),
    updatePropertyName: (id: string, name: string) => renameProperty(m.schemaDoc, id, name),
    addView: (type: ViewType, after?: string) => addView(m.doc, type, { ...(after ? { after } : {}) }),
    duplicateView: (id: string) => duplicateView(m.doc, id),
    deleteView: (id: string) => deleteView(m.doc, id),
    updateView: (id: string, patch: Parameters<typeof updateView>[2]) => updateView(m.doc, id, patch),
    page: (id: string) => getPage(m.tree, id),
  };
}

function nextFree(m: DatabaseModel, prop: string) {
  let max = 0;
  for (const r of m.store.children(m.source)) {
    const v = r.props[prop];
    if (typeof v === "number" && v > max) max = v;
  }
  return max + 1;
}

export type Actions = ReturnType<typeof createActions>;
