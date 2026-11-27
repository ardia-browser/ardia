import { useMemo, useState } from "react";
import { formFieldsFor, isEditable, TITLE, type FormField, type Property } from "../../../shared/database";
import { registerCss } from "../styles";
import { Icon } from "../icons";
import { Avatar, Button, Menu, MenuItem, Popover, Tag, Toggle, usePopover } from "../ui";
import type { ViewProps } from "./types";

registerCss(
  "form",
  `
.db-form { display: flex; justify-content: center; padding: 8px 0 24px; }
.db-form-card { width: 100%; max-width: 640px; background: var(--n-raised); box-shadow: inset 0 0 0 1px var(--n-group-border); border-radius: var(--n-r-panel, 12px); padding: 24px 24px 20px; display: flex; flex-direction: column; gap: 18px; }
.db-form-title { font-size: 22px; font-weight: 600; line-height: 1.25; color: var(--n-text); }
.db-form-desc { font-size: var(--n-t-body, 13px); color: var(--n-text-2); white-space: pre-wrap; margin-top: -10px; }
.db-form-field { display: flex; flex-direction: column; gap: 6px; }
.db-form-label { display: flex; align-items: center; gap: 6px; font-size: var(--n-t-body, 13px); font-weight: 500; color: var(--n-text); min-height: 22px; }
.db-form-label .db-form-required { color: var(--n-red); }
.db-form-label .db-form-tools { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--n-text-3); font-weight: 400; font-size: var(--n-t-caption, 11px); }
.db-form-help { font-size: var(--n-t-caption, 11px); color: var(--n-text-3); margin-top: -2px; }
.db-form-input { width: 100%; box-sizing: border-box; border: none; outline: none; background: var(--n-field, var(--n-chip)); box-shadow: inset 0 0 0 0.5px var(--n-group-border); border-radius: var(--n-r-control, 6px); padding: 7px 9px; font: inherit; font-size: var(--n-t-body, 13px); color: var(--n-text); resize: vertical; }
.db-form-input:focus { box-shadow: inset 0 0 0 1px var(--n-accent); }
.db-form-options { display: flex; flex-wrap: wrap; gap: 6px; }
.db-form-option { border: none; background: transparent; padding: 0; cursor: default; border-radius: 4px; opacity: .55; }
.db-form-option.is-on { opacity: 1; box-shadow: 0 0 0 1.5px var(--n-accent); }
.db-form-option:hover { opacity: 1; }
.db-form-person { display: inline-flex; align-items: center; gap: 6px; border: none; background: var(--n-chip); color: var(--n-text); border-radius: 999px; padding: 2px 8px 2px 2px; font: inherit; font-size: 12px; opacity: .6; cursor: default; }
.db-form-person.is-on { opacity: 1; box-shadow: 0 0 0 1.5px var(--n-accent); }
.db-form-muted { font-size: var(--n-t-caption, 11px); color: var(--n-text-3); }
.db-form-foot { display: flex; align-items: center; gap: 10px; padding-top: 4px; }
.db-form-foot .db-form-error { color: var(--n-red); font-size: var(--n-t-caption, 11px); }
.db-form-done { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 0 12px; text-align: center; color: var(--n-text-2); font-size: var(--n-t-body, 13px); }
.db-form-done .n-check { width: 32px; height: 32px; border-radius: 50%; background: color-mix(in srgb, var(--n-green) 18%, transparent); color: var(--n-green); display: flex; align-items: center; justify-content: center; }
`,
);

type Draft = Record<string, unknown>;

const isTextual = (p: Property) => p.type === "title" || p.type === "text" || p.type === "url" || p.type === "email" || p.type === "phone" || p.type === "number";

function filled(p: Property, v: unknown) {
  if (p.type === "checkbox") return v === true;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== "";
}

export function FormView(props: ViewProps) {
  const { m, view, editable } = props;
  const fields = useMemo(() => formFieldsFor(view, m.schema), [view, m.schema]);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const addMenu = usePopover();
  const byId = new Map(m.schema.map((p) => [p.id, p]));
  const set = (id: string, v: unknown) => {
    setError("");
    setDraft((d) => ({ ...d, [id]: v }));
  };
  const saveFields = (next: FormField[]) => props.actions.updateView(view.id, { formFields: next });
  const hidden = m.schema.filter((p) => isEditable(p.type) && !fields.some((f) => f.prop === p.id));

  const submit = async () => {
    const missing = fields.find((f) => f.required && byId.has(f.prop) && !filled(byId.get(f.prop)!, draft[f.prop]));
    if (missing) {
      setError(`${missing.label || byId.get(missing.prop)!.name || "A required question"} needs an answer.`);
      return;
    }
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      const p = byId.get(f.prop);
      const v = draft[f.prop];
      if (!p || p.id === TITLE || !filled(p, v)) continue;
      values[p.id] = p.type === "number" ? Number(String(v).replace(/[, ]/g, "")) : p.type === "date" ? { start: String(v) } : v;
    }
    const title = typeof draft[TITLE] === "string" ? (draft[TITLE] as string) : "";
    await props.newRow({ title, props: values, open: false });
    setDraft({});
    setSent(true);
  };

  const input = (p: Property) => {
    const v = draft[p.id];
    if (isTextual(p))
      return p.type === "text" ? (
        <textarea className="db-form-input" rows={2} value={typeof v === "string" ? v : ""} onChange={(e) => set(p.id, e.target.value)} data-testid="db-form-input" />
      ) : (
        <input className="db-form-input" type={p.type === "number" ? "number" : p.type === "email" ? "email" : p.type === "url" ? "url" : "text"} value={typeof v === "string" ? v : ""} onChange={(e) => set(p.id, e.target.value)} data-testid="db-form-input" />
      );
    if (p.type === "select" || p.type === "status" || p.type === "multi_select") {
      const chosen = p.type === "multi_select" ? (Array.isArray(v) ? (v as string[]) : []) : typeof v === "string" ? [v] : [];
      return (
        <div className="db-form-options">
          {p.options.map((o) => (
            <button
              type="button"
              key={o.id}
              className={`db-form-option ${chosen.includes(o.id) ? "is-on" : ""}`}
              onClick={() => (p.type === "multi_select" ? set(p.id, chosen.includes(o.id) ? chosen.filter((x) => x !== o.id) : [...chosen, o.id]) : set(p.id, chosen.includes(o.id) ? undefined : o.id))}
            >
              <Tag color={o.color}>{o.name}</Tag>
            </button>
          ))}
          {!p.options.length && <span className="db-form-muted">No options yet</span>}
        </div>
      );
    }
    if (p.type === "checkbox") return <Toggle on={v === true} onChange={(on) => set(p.id, on)} />;
    if (p.type === "date") return <input className="db-form-input" type="date" value={typeof v === "string" ? v : ""} onChange={(e) => set(p.id, e.target.value || undefined)} />;
    if (p.type === "person") {
      const chosen = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="db-form-options">
          {[...m.people.values()].map((person) => (
            <button type="button" key={person.id} className={`db-form-person ${chosen.includes(person.id) ? "is-on" : ""}`} onClick={() => set(p.id, chosen.includes(person.id) ? chosen.filter((x) => x !== person.id) : [...chosen, person.id])}>
              <Avatar name={person.name} color={person.color} size={18} />
              {person.name}
            </button>
          ))}
          {!m.people.size && <span className="db-form-muted">No people in this database yet</span>}
        </div>
      );
    }
    return <span className="db-form-muted">Add this after the response is in</span>;
  };

  return (
    <div className="db-form" data-testid="db-form">
      <div className="db-form-card">
        <div className="db-form-title">{view.formTitle || m.meta?.title || "Form"}</div>
        {(view.formDescription || m.settings.description) && <div className="db-form-desc">{view.formDescription || m.settings.description}</div>}
        {sent ? (
          <div className="db-form-done" data-testid="db-form-done">
            <span className="n-check">
              <Icon name="check" size={16} />
            </span>
            Your response was added.
            <Button kind="plain" onClick={() => setSent(false)}>
              Submit another response
            </Button>
          </div>
        ) : (
          <>
            {fields.map((f, i) => {
              const p = byId.get(f.prop);
              if (!p) return null;
              return (
                <div key={f.prop} className="db-form-field" data-testid="db-form-field" data-prop={p.id}>
                  <div className="db-form-label">
                    <span>{f.label || p.name || "Untitled"}</span>
                    {f.required && <span className="db-form-required">*</span>}
                    {editable && (
                      <span className="db-form-tools">
                        Required
                        <Toggle on={f.required} onChange={(on) => saveFields(fields.map((x, j) => (j === i ? { ...x, required: on } : x)))} />
                        {p.id !== TITLE && (
                          <button type="button" className="db-icon-btn" title="Remove question" aria-label="Remove question" onClick={() => saveFields(fields.filter((_, j) => j !== i))}>
                            <Icon name="x" size={12} />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {f.help && <div className="db-form-help">{f.help}</div>}
                  {input(p)}
                </div>
              );
            })}
            <div className="db-form-foot">
              <Button kind="primary" testId="db-form-submit" onClick={() => void submit()}>
                Submit
              </Button>
              {editable && hidden.length > 0 && (
                <Button kind="ghost" icon="plus" onClick={(e) => addMenu.open(e.currentTarget)}>
                  Add a question
                </Button>
              )}
              {error && <span className="db-form-error">{error}</span>}
            </div>
          </>
        )}
      </div>
      {addMenu.state && (
        <Popover anchor={addMenu.state.anchor} onClose={addMenu.close} width={220}>
          <Menu>
            {hidden.map((p) => (
              <MenuItem key={p.id} label={p.name || "Untitled"} onSelect={() => {
                addMenu.close();
                saveFields([...fields, { prop: p.id, required: false }]);
              }} />
            ))}
          </Menu>
        </Popover>
      )}
    </div>
  );
}
