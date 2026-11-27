use std::collections::HashMap;

use serde_json::{Map, Value};

use super::model::{Child, PluginNode};
use super::nodes::{records_of, str_of, str_prop};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormValue {
    Text(String),
    Flag(bool),
}

impl FormValue {
    pub fn to_json(&self) -> Value {
        match self {
            FormValue::Text(text) => Value::String(text.clone()),
            FormValue::Flag(flag) => Value::Bool(*flag),
        }
    }

    pub fn text(&self) -> &str {
        match self {
            FormValue::Text(text) => text,
            FormValue::Flag(_) => "",
        }
    }
}

const FIELD_TYPES: [&str; 4] = ["TextField", "PasswordField", "Toggle", "Select"];

pub fn field_nodes(node: &PluginNode) -> Vec<PluginNode> {
    let mut out = Vec::new();
    collect_fields(node, &mut out);
    out
}

fn collect_fields(node: &PluginNode, out: &mut Vec<PluginNode>) {
    for child in &node.children {
        let Child::Node(child) = child else {
            continue;
        };
        if FIELD_TYPES.contains(&child.kind.as_str()) {
            out.push(child.clone());
        } else {
            collect_fields(child, out);
        }
    }
}

pub fn option_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        other => str_of(other),
    }
}

pub fn select_options(field: &PluginNode) -> Vec<(String, String)> {
    records_of(field.prop("options"))
        .iter()
        .filter_map(|option: &Map<String, Value>| {
            let value = option_value(option.get("value"))?;
            let title = str_of(option.get("title")).unwrap_or_else(|| value.clone());
            Some((value, title))
        })
        .collect()
}

fn select_values(field: &PluginNode) -> Vec<String> {
    select_options(field).into_iter().map(|(v, _)| v).collect()
}

pub fn shown_select_value(field: &PluginNode, value: &FormValue) -> String {
    let allowed = select_values(field);
    match value {
        FormValue::Text(text) if allowed.contains(text) => text.clone(),
        _ => allowed.into_iter().next().unwrap_or_default(),
    }
}

pub fn initial_of(field: &PluginNode) -> FormValue {
    let value = field.prop("value");
    let default = field.prop("defaultValue");
    if field.kind == "Toggle" {
        return FormValue::Flag(match value {
            Some(Value::Bool(flag)) => *flag,
            _ => default == Some(&Value::Bool(true)),
        });
    }
    if let Some(Value::String(text)) = value {
        return FormValue::Text(text.clone());
    }
    if let Some(Value::String(text)) = default {
        return FormValue::Text(text.clone());
    }
    if field.kind == "Select" {
        return FormValue::Text(select_values(field).into_iter().next().unwrap_or_default());
    }
    FormValue::Text(String::new())
}

pub fn controlled_value_of(field: &PluginNode) -> Option<FormValue> {
    match (field.kind.as_str(), field.prop("value")) {
        ("Toggle", Some(Value::Bool(flag))) => Some(FormValue::Flag(*flag)),
        ("Toggle", _) => None,
        (_, Some(Value::String(text))) => Some(FormValue::Text(text.clone())),
        _ => None,
    }
}

pub fn form_values(
    fields: &[PluginNode],
    edits: &HashMap<String, FormValue>,
) -> Vec<(String, FormValue)> {
    let mut out: Vec<(String, FormValue)> = Vec::new();
    for field in fields {
        let Some(id) = str_prop(field, "id") else {
            continue;
        };
        let value = controlled_value_of(field)
            .or_else(|| edits.get(&id).cloned())
            .unwrap_or_else(|| initial_of(field));
        let value = if field.kind == "Select" {
            FormValue::Text(shown_select_value(field, &value))
        } else {
            value
        };
        match out.iter_mut().find(|(known, _)| *known == id) {
            Some(slot) => slot.1 = value,
            None => out.push((id, value)),
        }
    }
    out
}

pub fn values_json(values: &[(String, FormValue)]) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(id, value)| (id.clone(), value.to_json()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::nodes::check_plugin_node;
    use serde_json::json;

    #[test]
    fn values_follow_controlled_then_edits_then_initial() {
        let form = check_plugin_node(&json!({
            "type": "Form",
            "children": [
                {"type": "TextField", "props": {"id": "name", "defaultValue": "Ann"}},
                {"type": "Box", "children": [
                    {"type": "Toggle", "props": {"id": "on", "defaultValue": true}},
                    {"type": "Select", "props": {"id": "pick", "options": [{"value": "a"}, {"value": 2, "title": "Two"}]}}
                ]},
                {"type": "TextField", "props": {"id": "fixed", "value": "locked"}},
                {"type": "TextField", "props": {}}
            ]
        }))
        .unwrap();
        let fields = field_nodes(&form);
        assert_eq!(fields.len(), 5);
        let mut edits = HashMap::new();
        let values = form_values(&fields, &edits);
        assert_eq!(
            values_json(&values),
            json!({"name": "Ann", "on": true, "pick": "a", "fixed": "locked"})
        );
        edits.insert("pick".to_owned(), FormValue::Text("2".into()));
        edits.insert("fixed".to_owned(), FormValue::Text("typed".into()));
        edits.insert("name".to_owned(), FormValue::Text("Bo".into()));
        let values = form_values(&fields, &edits);
        assert_eq!(
            values_json(&values),
            json!({"name": "Bo", "on": true, "pick": "2", "fixed": "locked"})
        );
        edits.insert("pick".to_owned(), FormValue::Text("zzz".into()));
        assert_eq!(
            values_json(&form_values(&fields, &edits))["pick"],
            json!("a")
        );
        assert_eq!(
            select_options(&fields[2])[1],
            ("2".to_owned(), "Two".to_owned())
        );
    }
}
