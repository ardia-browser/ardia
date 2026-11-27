pub const RULE_BUDGET: usize = 140_000;
pub const IGNORE_TOP_DOCUMENTS: &str = r#"{"action":{"type":"ignore-previous-rules"},"trigger":{"load-context":["top-frame"],"resource-type":["document"],"url-filter":".*"}}"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkRule {
    pub priority: i64,
    pub exception: bool,
    pub json: String,
}

#[derive(Clone)]
struct Rule<'a> {
    priority: i64,
    exception: bool,
    json: &'a str,
    order: i64,
    weight: usize,
}

fn rule_count_in_group(json: &str) -> usize {
    json.matches(r#"{"action":"#).count().max(1)
}

fn ordered(a: &Rule, b: &Rule) -> std::cmp::Ordering {
    a.priority
        .cmp(&b.priority)
        .then(a.exception.cmp(&b.exception))
        .then(a.order.cmp(&b.order))
}

fn header(text: &str) -> Vec<Option<i64>> {
    text.split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<i64>().ok())
        .collect()
}

pub fn lists(texts: &[String], user: &[NetworkRule]) -> Vec<String> {
    let mut groups: std::collections::BTreeMap<i64, Vec<Rule>> = Default::default();
    let mut blocks: Vec<Rule> = Vec::new();
    let mut allows: Vec<Rule> = Vec::new();
    let mut cosmetic: Vec<&str> = Vec::new();
    let mut order = 0i64;
    for text in texts {
        for line in text.split('\n').filter(|line| !line.is_empty()) {
            let Some(tag) = line.chars().next() else {
                continue;
            };
            let Some(tab) = line.find('\t') else {
                continue;
            };
            let start = tag.len_utf8();
            if tab < start {
                continue;
            }
            let fields = header(&line[start..tab]);
            let priority = fields.first().copied().flatten().unwrap_or(1);
            let json = &line[tab + 1..];
            order += 1;
            match tag {
                'p' => {
                    let (Some(Some(set)), Some(Some(rank)), 3) =
                        (fields.get(1).copied(), fields.get(2).copied(), fields.len())
                    else {
                        continue;
                    };
                    groups.entry(set).or_default().push(Rule {
                        priority,
                        exception: false,
                        json,
                        order: rank,
                        weight: rule_count_in_group(json),
                    });
                }
                'b' => blocks.push(Rule {
                    priority,
                    exception: false,
                    json,
                    order,
                    weight: 1,
                }),
                'a' => allows.push(Rule {
                    priority,
                    exception: true,
                    json,
                    order,
                    weight: 1,
                }),
                'c' => cosmetic.push(json),
                _ => {}
            }
        }
    }
    for rule in user {
        order += 1;
        let made = Rule {
            priority: rule.priority,
            exception: rule.exception,
            json: &rule.json,
            order,
            weight: 1,
        };
        if rule.exception {
            allows.push(made);
        } else {
            blocks.push(made);
        }
    }
    let allowed_weight: usize = allows.iter().map(|rule| rule.weight).sum();
    let budget = RULE_BUDGET
        .saturating_sub(allowed_weight)
        .saturating_sub(1)
        .max(1000);
    let mut out = Vec::new();
    let mut pack = |mut rules: Vec<Rule>| {
        rules.sort_by(ordered);
        let mut chunk: Vec<Rule> = Vec::new();
        let mut weight = 0usize;
        let flush = |chunk: &mut Vec<Rule>, out: &mut Vec<String>| {
            let mut parts: Vec<Rule> = chunk.drain(..).chain(allows.iter().cloned()).collect();
            parts.sort_by(ordered);
            let mut joined: Vec<&str> = parts.iter().map(|rule| rule.json).collect();
            joined.push(IGNORE_TOP_DOCUMENTS);
            out.push(format!("[{}]", joined.join(",")));
        };
        for rule in rules {
            if !chunk.is_empty() && weight + rule.weight > budget {
                flush(&mut chunk, &mut out);
                weight = 0;
            }
            weight += rule.weight;
            chunk.push(rule);
        }
        if !chunk.is_empty() {
            flush(&mut chunk, &mut out);
        }
    };
    for (_, rules) in std::mem::take(&mut groups) {
        pack(rules);
    }
    pack(std::mem::take(&mut blocks));
    for slice in cosmetic.chunks(RULE_BUDGET) {
        out.push(format!("[{}]", slice.join(",")));
    }
    out
}

pub fn list_of(rules: &[NetworkRule]) -> String {
    format!(
        "[{}]",
        rules
            .iter()
            .map(|rule| rule.json.as_str())
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: &str) -> String {
        format!(r#"{{"action":{{"type":"{kind}"}}}}"#)
    }

    #[test]
    fn allows_join_every_chunk_and_priorities_order_rules() {
        let text = format!(
            "b2\t{}\nb1\t{}\na1\t{}\nc\t{}\nxjunk\nb1-no-tab\n",
            rule("block2"),
            rule("block1"),
            rule("allow"),
            rule("css")
        );
        let out = lists(&[text], &[]);
        assert_eq!(out.len(), 2);
        let block1 = out[0].find("block1").unwrap();
        let allow = out[0].find("allow").unwrap();
        let block2 = out[0].find("block2").unwrap();
        assert!(block1 < allow && allow < block2);
        assert!(out[0].ends_with(&format!("{IGNORE_TOP_DOCUMENTS}]")));
        assert_eq!(out[1], format!("[{}]", rule("css")));
    }

    #[test]
    fn grouped_rules_pack_by_set_then_rank_and_split_on_budget() {
        let group = format!(
            "p1.2.5\t{}\np1.2.1\t{}\np1.1.9\t{}\n",
            rule("x"),
            rule("y"),
            rule("z")
        );
        let out = lists(&[group], &[]);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("\"z\"") && !out[0].contains("\"x\""));
        assert!(out[1].find("\"y\"").unwrap() < out[1].find("\"x\"").unwrap());
        let many: String = (0..(RULE_BUDGET + 10))
            .map(|_| format!("b1\t{}\n", rule("b")))
            .collect();
        let out = lists(&[many], &[]);
        assert_eq!(out.len(), 2);
        let user = vec![NetworkRule {
            priority: 1,
            exception: true,
            json: rule("mine"),
        }];
        let out = lists(&[format!("b1\t{}\n", rule("b"))], &user);
        assert!(out[0].contains("mine"));
        assert_eq!(list_of(&user), format!("[{}]", rule("mine")));
    }
}
