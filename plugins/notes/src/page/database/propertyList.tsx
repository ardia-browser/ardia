import { useMemo, useRef, useState } from "react";
import type { PageMeta } from "../../shared/model";
import { TITLE, isEditable, moveProperty, settingsOf, type Property } from "../../shared/database";
import type { DatabaseModel } from "./data";
import { createActions } from "./actions";
import { CellEditor, CellView, isEmptyCell } from "./cells";
import { Icon, TypeIcon } from "./icons";
import { PropertyMenu } from "./propertyMenu";
import { AddPropertyMenu } from "./views/table";
import { Popover, usePopover } from "./ui";
import { registerCss } from "./styles";

export function RowPropertiesView({ m, row }: { m: DatabaseModel; row: PageMeta }) {
  const actions = useMemo(() => createActions(m), [m]);
  const [editing, setEditing] = useState<{ prop: string; el: HTMLElement } | null>(null);
  const propMenu = usePopover<string>();
  const addMenu = usePopover();
  const root = useRef<HTMLDivElement | null>(null);
  const hideEmpty = settingsOf(m.doc).get("rowHideEmpty") === true;
  const [showAll, setShowAll] = useState(false);
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  const props = m.schema.filter((p) => p.id !== TITLE);
  const empties = props.filter((p) => isEmptyCell(m, row, p));
  const shown = hideEmpty && !showAll ? props.filter((p) => !isEmptyCell(m, row, p)) : props;
  const editingProp = editing ? m.schema.find((p) => p.id === editing.prop) : undefined;
  const open = (p: Property, el: HTMLElement) => {
    if (p.type === "checkbox") actions.setValue(row.id, p, row.props[p.id] !== true);
    else if (isEditable(p.type)) setEditing({ prop: p.id, el });
  };
  return (
    <div ref={root} className="db-root db-rowprops" data-testid="db-row-properties">
      {shown.map((p) => (
        <div
          key={p.id}
          className={`db-rp ${over?.id === p.id ? (over.before ? "is-over-before" : "is-over-after") : ""}`}
          data-testid="db-rp"
          data-prop={p.name}
          data-prop-id={p.id}
          onDragOver={(e) => {
            if (!drag.current || drag.current === p.id) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setOver({ id: p.id, before: e.clientY < r.top + r.height / 2 });
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            const from = drag.current;
            drag.current = null;
            setOver(null);
            if (!from || from === p.id) return;
            const r = e.currentTarget.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            const others = props.filter((x) => x.id !== from);
            const i = others.findIndex((x) => x.id === p.id);
            moveProperty(m.schemaDoc, from, before ? others[i - 1]?.id ?? null : p.id);
          }}
        >
          <div className="db-rp-name" draggable={!m.locked} onDragStart={() => (drag.current = p.id)} onClick={(e) => propMenu.open(e.currentTarget, p.id)} data-testid="db-rp-name">
            <span className="db-rp-drag">
              <Icon name="drag" size={12} />
            </span>
            <TypeIcon type={p.type} size={16} className="db-rp-icon" />
            <span className="db-rp-label">{p.name}</span>
          </div>
          <div className={`db-rp-value t-${p.type} ${isEditable(p.type) ? "" : "is-readonly"}`} data-testid="db-rp-value" onClick={(e) => open(p, e.currentTarget)}>
            {isEmptyCell(m, row, p) ? <span className="db-rp-empty">Empty</span> : <CellView m={m} row={row} prop={p} wrap />}
          </div>
        </div>
      ))}
      {hideEmpty && empties.length > 0 && (
        <button type="button" className="db-rp-more" onClick={() => setShowAll((s) => !s)}>
          <Icon name={showAll ? "chevronUp" : "chevronDown"} size={14} />
          {showAll ? "Hide empty properties" : `${empties.length} more propert${empties.length === 1 ? "y" : "ies"}`}
        </button>
      )}
      <div className="db-rp-foot">
        {!m.locked && (
          <button type="button" className="db-rp-more" data-testid="db-rp-add" onClick={(e) => addMenu.open(e.currentTarget)}>
            <Icon name="plus" size={14} />
            Add a property
          </button>
        )}
        <button type="button" className="db-rp-more" data-testid="db-rp-hide-empty" onClick={() => settingsOf(m.doc).set("rowHideEmpty", !hideEmpty)}>
          <Icon name={hideEmpty ? "eye" : "eyeOff"} size={14} />
          {hideEmpty ? "Show empty properties" : "Hide empty properties"}
        </button>
      </div>
      {editing && editingProp && <CellEditor m={m} actions={actions} row={m.store.pages.get(row.id) ?? row} prop={editingProp} anchor={editing.el} onClose={() => setEditing(null)} />}
      {propMenu.state && m.schema.find((p) => p.id === propMenu.state!.value) && (
        <PropertyMenu m={m} actions={actions} prop={m.schema.find((p) => p.id === propMenu.state!.value)!} view={null} anchor={propMenu.state.anchor} onClose={propMenu.close} />
      )}
      {addMenu.state && (
        <Popover anchor={addMenu.state.anchor} onClose={addMenu.close} width={240}>
          <AddPropertyMenu
            onPick={(type) => {
              addMenu.close();
              const id = actions.newProperty(type);
              requestAnimationFrame(() => {
                const el = root.current?.querySelector<HTMLElement>(`[data-prop-id="${id}"] .db-rp-name`);
                if (el) propMenu.open(el, id);
              });
            }}
          />
        </Popover>
      )}
    </div>
  );
}

registerCss(
  "rowprops",
  `
.db-rowprops { display: flex; flex-direction: column; gap: 1px; padding: 4px 0 8px; }
.db-rp { display: flex; align-items: flex-start; min-height: 34px; border-radius: 4px; }
.db-rp.is-over-before { box-shadow: inset 0 2px 0 var(--n-form-accent); }
.db-rp.is-over-after { box-shadow: inset 0 -2px 0 var(--n-form-accent); }
.db-rp-name { position: relative; display: flex; align-items: center; gap: 6px; width: 160px; flex: none; height: 34px; padding: 0 6px; border-radius: 4px; color: var(--n-text-2); cursor: default; }
.db-rp-name:hover { background: var(--n-hover); }
.db-rp-drag { position: absolute; left: -16px; opacity: 0; color: var(--n-text-3); cursor: grab; display: inline-flex; }
.db-rp:hover .db-rp-drag { opacity: 1; }
.db-rp-icon { color: var(--n-text-3); }
.db-rp-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.db-rp-value { flex: 1; min-width: 0; min-height: 34px; padding: 7px 8px; border-radius: 4px; display: flex; align-items: center; cursor: default; }
.db-rp-value:hover { background: var(--n-hover); }
.db-rp-value.is-readonly:hover { background: transparent; }
.db-rp-value .db-cell-value { white-space: normal; word-break: break-word; }
.db-rp-empty { color: var(--n-text-3); }
.db-rp-value .db-num { text-align: left; }
.db-rp-value .db-num-bar { max-width: 240px; }
.db-rp-foot { display: flex; gap: 4px; flex-wrap: wrap; }
.db-rp-more { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: none; background: transparent; color: var(--n-text-3); border-radius: 4px; font-size: 14px; cursor: default; }
.db-rp-more:hover { background: var(--n-hover); color: var(--n-text-2); }
`,
);
