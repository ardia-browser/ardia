use std::time::Duration;

use ardia_state::TabId;
use ardia_ui::host::ReplaceNote;
use ardia_ui::host_data::HostTopics;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const REPLACE_DEADLINE: Duration = Duration::from_millis(4000);

const FOCUSED: &str = r#"const focused = () => {
  let el = document.activeElement;
  for (;;) {
    if (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    else if (el && el.tagName === "IFRAME") {
      try { el = el.contentDocument.activeElement; } catch (e) { return el; }
    } else return el;
  }
};
const isTextField = (el) => !!el && !el.readOnly && !el.disabled &&
  (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|email|tel|)$/i.test(el.getAttribute("type") || "")));"#;

const REPLACE: &str = r#"(query, replacement, all) => {
  const el = focused();
  const done = (field, count) => ({ field, count });
  const q = query.toLowerCase();
  if (!el || !q) return done(false, 0);
  const doc = el.ownerDocument, win = doc.defaultView;
  if (isTextField(el)) {
    const insert = (start, end, text) => {
      el.focus();
      el.setSelectionRange(start, end);
      if (!doc.execCommand("insertText", false, text)) {
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }));
      }
    };
    const value = el.value, lower = value.toLowerCase();
    if (all) {
      let out = "", last = 0, count = 0;
      for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length), count++) {
        out += value.slice(last, i) + replacement;
        last = i + q.length;
      }
      if (count) insert(0, value.length, out + value.slice(last));
      return done(true, count);
    }
    const selected = lower.slice(el.selectionStart, el.selectionEnd) === q;
    let at = selected ? el.selectionStart : lower.indexOf(q, el.selectionEnd);
    if (at === -1) at = lower.indexOf(q);
    if (at === -1) return done(true, 0);
    insert(at, at + q.length, replacement);
    const after = el.value.toLowerCase();
    let next = after.indexOf(q, at + replacement.length);
    if (next === -1) next = after.indexOf(q);
    if (next !== -1) el.setSelectionRange(next, next + q.length);
    return done(true, 1);
  }
  if (!el.isContentEditable) return done(false, 0);
  const matches = () => {
    const found = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      const t = n.data.toLowerCase();
      for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) {
        const r = doc.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        found.push(r);
      }
    }
    return found;
  };
  const sel = win.getSelection();
  const select = (r) => {
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const replace = (r) => {
    select(r);
    if (!doc.execCommand("insertText", false, replacement)) {
      r.deleteContents();
      r.insertNode(doc.createTextNode(replacement));
    }
  };
  el.focus();
  const found = matches();
  if (all) {
    for (const r of found.reverse()) replace(r);
    return done(true, found.length);
  }
  const current = sel.rangeCount ? sel.getRangeAt(0) : null;
  const isCurrent = (r) => current && r.compareBoundaryPoints(Range.START_TO_START, current) === 0 && r.compareBoundaryPoints(Range.END_TO_END, current) === 0;
  const target = found.find(isCurrent) || (current && found.find((r) => r.compareBoundaryPoints(Range.START_TO_START, current) >= 0)) || found[0];
  if (!target) return done(true, 0);
  replace(target);
  const caret = sel.rangeCount ? sel.getRangeAt(0) : null;
  const rest = matches();
  const next = (caret && rest.find((r) => r.compareBoundaryPoints(Range.START_TO_END, caret) >= 0)) || rest[0];
  if (next) select(next);
  return done(true, 1);
}"#;

pub fn replace_script(query: &str, replacement: &str, all: bool) -> String {
    let args = [json!(query), json!(replacement), json!(all)]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!("(() => {{ {FOCUSED}\n return ({REPLACE})({args}); }})()")
}

pub fn replace_outcome(answer: &Value) -> (bool, u32) {
    let value = answer.pointer("/result/value");
    let field = value
        .and_then(|v| v.get("field"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let count = value
        .and_then(|v| v.get("count"))
        .and_then(Value::as_u64)
        .map_or(0, |c| u32::try_from(c).unwrap_or(u32::MAX));
    (field, count)
}

impl AppCoordinator {
    pub fn replace_in_tab(&self, tab: TabId, query: String, replacement: String, all: bool) {
        if query.is_empty() {
            return;
        }
        let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(&tab)) else {
            return;
        };
        let reply = engine.devtools_call(
            engine_tab,
            "Runtime.evaluate",
            Some(json!({
                "expression": replace_script(&query, &replacement, all),
                "returnByValue": true,
                "userGesture": true,
            })),
            REPLACE_DEADLINE,
        );
        let me = self.weak();
        self.spawn(async move {
            let (field, count) = match reply.await {
                Ok(answer) if answer.get("exceptionDetails").is_none() => replace_outcome(&answer),
                Ok(_) => (false, 0),
                Err(problem) => {
                    log::debug!("replace didn't run: {problem}");
                    (false, 0)
                }
            };
            let Some(me) = me.upgrade() else {
                return;
            };
            let note = ReplaceNote::of(field, count, all, ardia_state::store::now_ms());
            {
                let mut bridge = me.bridge.lock();
                match note {
                    Some(note) => {
                        bridge.replace_notes.insert(tab.clone(), note);
                    }
                    None => {
                        bridge.replace_notes.remove(&tab);
                    }
                }
            }
            me.signal.emit(HostTopics::PAGE);
            if let (Some(engine), Some(engine_tab)) = (me.engine(), me.engine_tab(&tab))
                && let Err(problem) = engine.find(engine_tab, &query, true)
            {
                log::debug!("find after replace failed: {problem}");
            }
        });
    }

    pub fn replace_note_of(&self, tab: &TabId) -> Option<ReplaceNote> {
        self.bridge.lock().replace_notes.get(tab).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_quotes_its_arguments() {
        let script = replace_script("a\"b", "c\nd", true);
        assert!(script.contains(r#""a\"b", "c\nd", true"#));
        assert!(script.starts_with("(() => {"));
    }

    #[test]
    fn outcomes_read_the_returned_value() {
        let answer = json!({ "result": { "value": { "field": true, "count": 3 } } });
        assert_eq!(replace_outcome(&answer), (true, 3));
        assert_eq!(replace_outcome(&json!({})), (false, 0));
    }
}
