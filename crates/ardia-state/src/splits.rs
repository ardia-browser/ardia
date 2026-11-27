use crate::ids::{SplitId, TabId, WindowId};
use crate::json::{self, Fields};
use crate::macros::string_enum;
use crate::model::Orientation;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const MAX_SPLIT_PANES: usize = 4;
const EPSILON: f64 = 1e-6;

string_enum!(SplitSide { Left = "left", Right = "right", Top = "top", Bottom = "bottom" } default Right);
string_enum!(PaneDirection { Left = "left", Right = "right", Up = "up", Down = "down" } default Right);

impl SplitSide {
    pub const fn sideways(self) -> bool {
        matches!(self, SplitSide::Left | SplitSide::Right)
    }

    pub const fn leading(self) -> bool {
        matches!(self, SplitSide::Left | SplitSide::Top)
    }

    pub const fn orientation(self) -> Orientation {
        if self.sideways() {
            Orientation::Horizontal
        } else {
            Orientation::Vertical
        }
    }
}

fn flipped(o: Orientation) -> Orientation {
    match o {
        Orientation::Horizontal => Orientation::Vertical,
        Orientation::Vertical => Orientation::Horizontal,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SplitSlot {
    Pane {
        size: f64,
        tab_id: TabId,
    },
    Stack {
        size: f64,
        stack: [TabId; 2],
        stack_sizes: [f64; 2],
    },
}

impl SplitSlot {
    pub fn size(&self) -> f64 {
        match self {
            SplitSlot::Pane { size, .. } | SplitSlot::Stack { size, .. } => *size,
        }
    }

    fn with_size(&self, size: f64) -> SplitSlot {
        match self {
            SplitSlot::Pane { tab_id, .. } => SplitSlot::Pane {
                size,
                tab_id: tab_id.clone(),
            },
            SplitSlot::Stack {
                stack, stack_sizes, ..
            } => SplitSlot::Stack {
                size,
                stack: stack.clone(),
                stack_sizes: *stack_sizes,
            },
        }
    }

    pub fn tab_ids(&self) -> Vec<&TabId> {
        match self {
            SplitSlot::Pane { tab_id, .. } => vec![tab_id],
            SplitSlot::Stack { stack, .. } => stack.iter().collect(),
        }
    }

    pub fn holds(&self, tab: &str) -> bool {
        self.tab_ids().iter().any(|t| t.as_str() == tab)
    }

    pub fn is_stack(&self) -> bool {
        matches!(self, SplitSlot::Stack { .. })
    }

    pub fn from_value(value: &Value) -> Option<SplitSlot> {
        let fields = value.as_object()?;
        let size = fields.get("size").filter(|s| json::is_size(s))?.as_f64()?;
        if let Some(tab) = fields.get("tabId").and_then(Value::as_str) {
            return Some(SplitSlot::Pane {
                size,
                tab_id: TabId::new(tab),
            });
        }
        let stack = fields.get("stack")?.as_array()?;
        let [a, b] = stack.as_slice() else {
            return None;
        };
        Some(SplitSlot::Stack {
            size,
            stack: [TabId::new(a.as_str()?), TabId::new(b.as_str()?)],
            stack_sizes: sizes_or_even(fields.get("stackSizes")),
        })
    }

    pub fn to_value(&self) -> Value {
        match self {
            SplitSlot::Pane { size, tab_id } => {
                json!({"size": json::js_number(*size), "tabId": tab_id})
            }
            SplitSlot::Stack {
                size,
                stack,
                stack_sizes,
            } => {
                json!({"size": json::js_number(*size), "stack": stack, "stackSizes": [json::js_number(stack_sizes[0]), json::js_number(stack_sizes[1])]})
            }
        }
    }
}

fn sizes_or_even(value: Option<&Value>) -> [f64; 2] {
    match value.and_then(Value::as_array).map(Vec::as_slice) {
        Some([a, b]) if json::is_size(a) && json::is_size(b) => {
            [a.as_f64().unwrap_or(0.5), b.as_f64().unwrap_or(0.5)]
        }
        _ => [0.5, 0.5],
    }
}

pub fn slots_from_disk(value: Option<&Value>) -> Option<Vec<SplitSlot>> {
    let rows = value?.as_array()?;
    let slots: Option<Vec<SplitSlot>> = rows.iter().map(SplitSlot::from_value).collect();
    slots.filter(|s| !s.is_empty())
}

fn deserialize_slots<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<SplitSlot>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    slots_from_disk(Some(&value))
        .ok_or_else(|| D::Error::custom("split slots are panes or two-pane stacks"))
}

fn serialize_slots<S: Serializer>(slots: &[SplitSlot], serializer: S) -> Result<S::Ok, S::Error> {
    Value::Array(slots.iter().map(SplitSlot::to_value).collect()).serialize(serializer)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitView {
    pub id: SplitId,
    pub window_id: WindowId,
    pub orientation: Orientation,
    #[serde(
        deserialize_with = "deserialize_slots",
        serialize_with = "serialize_slots"
    )]
    pub slots: Vec<SplitSlot>,
    #[serde(flatten)]
    pub extra: Fields,
}

pub fn even_slots(ids: &[TabId]) -> Vec<SplitSlot> {
    let n = ids.len().max(1) as f64;
    ids.iter()
        .map(|tab| SplitSlot::Pane {
            size: 1.0 / n,
            tab_id: tab.clone(),
        })
        .collect()
}

fn evened(slots: Vec<SplitSlot>) -> Vec<SplitSlot> {
    let n = slots.len().max(1) as f64;
    slots.iter().map(|s| s.with_size(1.0 / n)).collect()
}

fn spans(sizes: &[f64]) -> Vec<(f64, f64)> {
    let mut at = 0.0;
    sizes
        .iter()
        .enumerate()
        .map(|(i, size)| {
            let start = at;
            at = if i == sizes.len() - 1 { 1.0 } else { at + size };
            (start, at - start)
        })
        .collect()
}

fn ranks_before(a: &[f64; 3], b: &[f64; 3]) -> bool {
    for i in 0..3 {
        if (a[i] - b[i]).abs() > EPSILON {
            return a[i] < b[i];
        }
    }
    false
}

impl SplitView {
    pub fn new(
        id: SplitId,
        window_id: WindowId,
        orientation: Orientation,
        slots: Vec<SplitSlot>,
    ) -> Self {
        SplitView {
            id,
            window_id,
            orientation,
            slots,
            extra: Fields::new(),
        }
    }

    pub fn row_is_valid(row: &Value) -> bool {
        let Some(fields) = row.as_object() else {
            return false;
        };
        json::own_id(fields.get("id"))
            && json::own_id(fields.get("windowId"))
            && fields
                .get("orientation")
                .and_then(Value::as_str)
                .is_some_and(|o| o == "horizontal" || o == "vertical")
            && slots_from_disk(fields.get("slots")).is_some()
    }

    pub fn tab_ids(&self) -> Vec<TabId> {
        self.slots
            .iter()
            .flat_map(|s| s.tab_ids().into_iter().cloned())
            .collect()
    }

    pub fn contains(&self, tab: &str) -> bool {
        self.slots.iter().any(|s| s.holds(tab))
    }

    pub fn pane_count(&self) -> usize {
        self.slots.iter().map(|s| s.tab_ids().len()).sum()
    }

    pub fn is_stacked(&self, tab: &str) -> bool {
        self.slots.iter().any(|s| s.is_stack() && s.holds(tab))
    }

    pub fn pane_boxes(&self) -> Vec<(TabId, PaneBox)> {
        let horizontal = self.orientation == Orientation::Horizontal;
        let sizes: Vec<f64> = self.slots.iter().map(SplitSlot::size).collect();
        let mut out = Vec::new();
        for (slot, (start, size)) in self.slots.iter().zip(spans(&sizes)) {
            let bx = if horizontal {
                PaneBox {
                    x: start,
                    y: 0.0,
                    width: size,
                    height: 1.0,
                }
            } else {
                PaneBox {
                    x: 0.0,
                    y: start,
                    width: 1.0,
                    height: size,
                }
            };
            match slot {
                SplitSlot::Pane { tab_id, .. } => out.push((tab_id.clone(), bx)),
                SplitSlot::Stack {
                    stack, stack_sizes, ..
                } => {
                    for (tab, (s, z)) in stack.iter().zip(spans(stack_sizes)) {
                        let inner = if horizontal {
                            PaneBox {
                                y: s,
                                height: z,
                                ..bx
                            }
                        } else {
                            PaneBox {
                                x: s,
                                width: z,
                                ..bx
                            }
                        };
                        out.push((tab.clone(), inner));
                    }
                }
            }
        }
        out
    }

    pub fn neighbor(&self, tab: &str, direction: PaneDirection) -> Option<TabId> {
        let boxes = self.pane_boxes();
        let from = boxes.iter().find(|(id, _)| id.as_str() == tab)?.1;
        let across = matches!(direction, PaneDirection::Left | PaneDirection::Right);
        let forward = matches!(direction, PaneDirection::Right | PaneDirection::Down);
        let start = |b: &PaneBox| if across { b.x } else { b.y };
        let end = |b: &PaneBox| {
            if across {
                b.x + b.width
            } else {
                b.y + b.height
            }
        };
        let cross_start = |b: &PaneBox| if across { b.y } else { b.x };
        let cross_end = |b: &PaneBox| {
            if across {
                b.y + b.height
            } else {
                b.x + b.width
            }
        };
        let mut best: Option<(TabId, [f64; 3])> = None;
        for (id, bx) in &boxes {
            if id.as_str() == tab {
                continue;
            }
            let gap = if forward {
                start(bx) - end(&from)
            } else {
                start(&from) - end(bx)
            };
            let overlap =
                cross_end(bx).min(cross_end(&from)) - cross_start(bx).max(cross_start(&from));
            if gap < -EPSILON || overlap <= EPSILON {
                continue;
            }
            let rank = [gap, -overlap, cross_start(bx)];
            if best.as_ref().is_none_or(|(_, b)| ranks_before(&rank, b)) {
                best = Some((id.clone(), rank));
            }
        }
        best.map(|(id, _)| id)
    }

    pub fn with_pane_ids(&self, ids: &[TabId]) -> SplitView {
        let mut i = 0;
        let mut take = || {
            let id = ids.get(i).cloned().unwrap_or_else(|| TabId::new(""));
            i += 1;
            id
        };
        let slots = self
            .slots
            .iter()
            .map(|slot| match slot {
                SplitSlot::Pane { size, .. } => SplitSlot::Pane {
                    size: *size,
                    tab_id: take(),
                },
                SplitSlot::Stack {
                    size, stack_sizes, ..
                } => SplitSlot::Stack {
                    size: *size,
                    stack: [take(), take()],
                    stack_sizes: *stack_sizes,
                },
            })
            .collect();
        SplitView {
            slots,
            ..self.clone()
        }
    }

    pub fn swapped(&self, a: &str, b: &str) -> Option<SplitView> {
        let ids = self.tab_ids();
        if a == b || !self.contains(a) || !self.contains(b) {
            return None;
        }
        let swapped: Vec<TabId> = ids
            .iter()
            .map(|id| {
                if id == a {
                    TabId::new(b)
                } else if id == b {
                    TabId::new(a)
                } else {
                    id.clone()
                }
            })
            .collect();
        Some(self.with_pane_ids(&swapped))
    }

    fn insertion_at(&self, anchor: &str, side: SplitSide) -> Option<(usize, bool)> {
        if self.pane_count() >= MAX_SPLIT_PANES {
            return None;
        }
        let at = self.slots.iter().position(|s| s.holds(anchor))?;
        let along = (self.orientation == Orientation::Horizontal) == side.sideways();
        if !along && self.slots[at].is_stack() && self.slots.len() > 1 {
            return None;
        }
        Some((at, along))
    }

    pub fn can_insert(split: Option<&SplitView>, anchor: &str, side: SplitSide) -> bool {
        split.is_none_or(|s| s.insertion_at(anchor, side).is_some())
    }

    pub fn paired(
        id: SplitId,
        window_id: WindowId,
        anchor: &TabId,
        tab: &TabId,
        side: SplitSide,
    ) -> SplitView {
        let ids = if side.leading() {
            [tab.clone(), anchor.clone()]
        } else {
            [anchor.clone(), tab.clone()]
        };
        SplitView::new(id, window_id, side.orientation(), even_slots(&ids))
    }

    pub fn inserted(&self, anchor: &TabId, tab: &TabId, side: SplitSide) -> Option<SplitView> {
        let (at, along) = self.insertion_at(anchor.as_str(), side)?;
        let mut slots = self.slots.clone();
        if along {
            let index = if side.leading() { at } else { at + 1 };
            slots.insert(
                index,
                SplitSlot::Pane {
                    size: 0.0,
                    tab_id: tab.clone(),
                },
            );
            return Some(SplitView {
                slots: evened(slots),
                ..self.clone()
            });
        }
        match &slots[at] {
            SplitSlot::Stack { stack, .. } => {
                let mut ids = stack.to_vec();
                let anchor_at = ids.iter().position(|t| t == anchor).unwrap_or(0);
                ids.insert(
                    if side.leading() {
                        anchor_at
                    } else {
                        anchor_at + 1
                    },
                    tab.clone(),
                );
                Some(SplitView {
                    orientation: side.orientation(),
                    slots: even_slots(&ids),
                    ..self.clone()
                })
            }
            SplitSlot::Pane { size, .. } => {
                let stack = if side.leading() {
                    [tab.clone(), anchor.clone()]
                } else {
                    [anchor.clone(), tab.clone()]
                };
                slots[at] = SplitSlot::Stack {
                    size: *size,
                    stack,
                    stack_sizes: [0.5, 0.5],
                };
                Some(SplitView {
                    slots,
                    ..self.clone()
                })
            }
        }
    }

    pub fn normalized(&self) -> SplitView {
        match self.slots.as_slice() {
            [
                SplitSlot::Stack {
                    stack, stack_sizes, ..
                },
            ] => SplitView {
                orientation: flipped(self.orientation),
                slots: stack
                    .iter()
                    .zip(stack_sizes)
                    .map(|(tab, size)| SplitSlot::Pane {
                        size: *size,
                        tab_id: tab.clone(),
                    })
                    .collect(),
                ..self.clone()
            },
            _ => self.clone(),
        }
    }

    pub fn without_panes(&self, gone: &HashSet<TabId>) -> SplitView {
        let slots: Vec<SplitSlot> = self
            .slots
            .iter()
            .filter_map(|slot| match slot {
                SplitSlot::Pane { tab_id, .. } => (!gone.contains(tab_id)).then(|| slot.clone()),
                SplitSlot::Stack { size, stack, .. } => {
                    let left: Vec<&TabId> = stack.iter().filter(|t| !gone.contains(*t)).collect();
                    match left.as_slice() {
                        [_, _] => Some(slot.clone()),
                        [one] => Some(SplitSlot::Pane {
                            size: *size,
                            tab_id: (*one).clone(),
                        }),
                        _ => None,
                    }
                }
            })
            .collect();
        let total: f64 = slots.iter().map(SplitSlot::size).sum();
        let slots = if total > 0.0 {
            slots
                .iter()
                .map(|s| s.with_size(s.size() / total))
                .collect()
        } else {
            evened(slots)
        };
        SplitView {
            slots,
            ..self.clone()
        }
        .normalized()
    }

    fn shape(&self) -> String {
        let slots: Vec<String> = self
            .slots
            .iter()
            .map(|s| {
                s.tab_ids()
                    .iter()
                    .map(|t| t.as_str())
                    .collect::<Vec<_>>()
                    .join("+")
            })
            .collect();
        format!("{}|{}", self.orientation.key(), slots.join(","))
    }

    fn reordered(&self, tab: &str, anchor: &str, side: SplitSide) -> Option<SplitView> {
        if self.slots.iter().any(SplitSlot::is_stack)
            || (self.orientation == Orientation::Horizontal) != side.sideways()
        {
            return None;
        }
        let moving_at = self.slots.iter().position(|s| s.holds(tab))?;
        let mut slots = self.slots.clone();
        let moving = slots.remove(moving_at);
        let at = slots.iter().position(|s| s.holds(anchor))?;
        slots.insert(if side.leading() { at } else { at + 1 }, moving);
        Some(SplitView {
            slots,
            ..self.clone()
        })
    }

    fn redocked(&self, tab: &TabId, anchor: &TabId, side: SplitSide) -> Option<SplitView> {
        let rest = self.without_panes(&HashSet::from([tab.clone()]));
        if rest.pane_count() < 2 {
            let pair =
                SplitView::paired(self.id.clone(), self.window_id.clone(), anchor, tab, side);
            return Some(SplitView {
                extra: self.extra.clone(),
                ..pair
            });
        }
        rest.inserted(anchor, tab, side)
    }

    pub fn moved_pane(&self, tab: &TabId, anchor: &TabId, side: SplitSide) -> Option<SplitView> {
        if tab == anchor || !self.contains(tab.as_str()) || !self.contains(anchor.as_str()) {
            return None;
        }
        let base = self.normalized();
        let moved = base
            .reordered(tab.as_str(), anchor.as_str(), side)
            .or_else(|| base.redocked(tab, anchor, side))?;
        Some(if moved.shape() == base.shape() {
            self.clone()
        } else {
            moved
        })
    }

    pub fn resized(&self, sizes: &[f64]) -> Option<SplitView> {
        if sizes.len() != self.slots.len() || sizes.iter().any(|s| !s.is_finite() || *s <= 0.0) {
            return None;
        }
        let total: f64 = sizes.iter().sum();
        Some(SplitView {
            slots: self
                .slots
                .iter()
                .zip(sizes)
                .map(|(slot, size)| slot.with_size(size / total))
                .collect(),
            ..self.clone()
        })
    }

    pub fn restacked(&self, stack_sizes: [f64; 2]) -> Option<SplitView> {
        if stack_sizes.iter().any(|s| !s.is_finite() || *s <= 0.0) {
            return None;
        }
        let total = stack_sizes[0] + stack_sizes[1];
        let mut out = self.clone();
        let slot = out.slots.iter_mut().find(|s| s.is_stack())?;
        if let SplitSlot::Stack {
            stack_sizes: sizes, ..
        } = slot
        {
            *sizes = [stack_sizes[0] / total, stack_sizes[1] / total];
        }
        Some(out)
    }

    pub fn flipped(&self) -> SplitView {
        SplitView {
            orientation: flipped(self.orientation),
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs(list: &[&str]) -> Vec<TabId> {
        list.iter().map(|t| TabId::new(*t)).collect()
    }

    fn split(orientation: Orientation, list: &[&str]) -> SplitView {
        SplitView::new(
            SplitId::new("s"),
            WindowId::new("w"),
            orientation,
            even_slots(&tabs(list)),
        )
    }

    #[test]
    fn slots_round_trip_and_reject_bad_shapes() {
        let row = json!({"id": "s", "windowId": "w", "orientation": "horizontal", "slots": [{"size": 0.5, "tabId": "a"}, {"size": 0.5, "stack": ["b", "c"], "stackSizes": [0.25, 0.75]}]});
        assert!(SplitView::row_is_valid(&row));
        let view: SplitView = serde_json::from_value(row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&view).unwrap(), row);
        assert!(!SplitView::row_is_valid(
            &json!({"id": "s", "windowId": "w", "orientation": "diagonal", "slots": [{"size": 1, "tabId": "a"}]})
        ));
        assert!(!SplitView::row_is_valid(
            &json!({"id": "s", "windowId": "w", "orientation": "vertical", "slots": [{"size": 0, "tabId": "a"}]})
        ));
        assert!(!SplitView::row_is_valid(
            &json!({"id": "s", "windowId": "w", "orientation": "vertical", "slots": []})
        ));
        assert!(!SplitView::row_is_valid(
            &json!({"id": "s", "windowId": "w", "orientation": "vertical", "slots": [{"size": 1, "stack": ["a"]}]})
        ));
        let even =
            SplitSlot::from_value(&json!({"size": 1, "stack": ["a", "b"], "stackSizes": [0, 1]}))
                .unwrap();
        assert!(matches!(
            even,
            SplitSlot::Stack {
                stack_sizes: [0.5, 0.5],
                ..
            }
        ));
    }

    #[test]
    fn panes_are_inserted_along_or_stacked_up_to_four() {
        let pair = SplitView::paired(
            SplitId::new("s"),
            WindowId::new("w"),
            &TabId::new("a"),
            &TabId::new("b"),
            SplitSide::Right,
        );
        assert_eq!(pair.tab_ids(), tabs(&["a", "b"]));
        let three = pair
            .inserted(&TabId::new("b"), &TabId::new("c"), SplitSide::Right)
            .unwrap();
        assert_eq!(three.tab_ids(), tabs(&["a", "b", "c"]));
        assert!(
            three
                .slots
                .iter()
                .all(|s| (s.size() - 1.0 / 3.0).abs() < 1e-9)
        );
        let four = three
            .inserted(&TabId::new("c"), &TabId::new("d"), SplitSide::Bottom)
            .unwrap();
        assert_eq!(four.pane_count(), 4);
        assert!(four.is_stacked("d"));
        assert!(
            four.inserted(&TabId::new("a"), &TabId::new("e"), SplitSide::Left)
                .is_none()
        );
        assert!(!SplitView::can_insert(Some(&four), "a", SplitSide::Left));
        assert!(SplitView::can_insert(None, "a", SplitSide::Left));
    }

    #[test]
    fn neighbors_follow_the_pane_geometry() {
        let view = split(Orientation::Horizontal, &["a", "b"])
            .inserted(&TabId::new("b"), &TabId::new("c"), SplitSide::Bottom)
            .unwrap();
        assert_eq!(
            view.neighbor("a", PaneDirection::Right).unwrap().as_str(),
            "b"
        );
        assert_eq!(
            view.neighbor("b", PaneDirection::Down).unwrap().as_str(),
            "c"
        );
        assert_eq!(
            view.neighbor("c", PaneDirection::Left).unwrap().as_str(),
            "a"
        );
        assert_eq!(view.neighbor("a", PaneDirection::Left), None);
        let boxes = view.pane_boxes();
        let area: f64 = boxes.iter().map(|(_, b)| b.width * b.height).sum();
        assert!((area - 1.0).abs() < 1e-9);
    }

    #[test]
    fn closing_panes_renormalizes_and_unstacks() {
        let view = split(Orientation::Horizontal, &["a", "b"])
            .inserted(&TabId::new("b"), &TabId::new("c"), SplitSide::Bottom)
            .unwrap();
        let left = view.without_panes(&HashSet::from([TabId::new("a")]));
        assert_eq!(left.orientation, Orientation::Vertical);
        assert_eq!(left.tab_ids(), tabs(&["b", "c"]));
        assert!((left.slots.iter().map(SplitSlot::size).sum::<f64>() - 1.0).abs() < 1e-9);
        let one = left.without_panes(&HashSet::from([TabId::new("b")]));
        assert_eq!(one.pane_count(), 1);
    }

    #[test]
    fn swapping_moving_and_resizing() {
        let view = split(Orientation::Horizontal, &["a", "b", "c"]);
        assert_eq!(
            view.swapped("a", "c").unwrap().tab_ids(),
            tabs(&["c", "b", "a"])
        );
        assert!(view.swapped("a", "a").is_none() && view.swapped("a", "z").is_none());
        let moved = view
            .moved_pane(&TabId::new("a"), &TabId::new("c"), SplitSide::Right)
            .unwrap();
        assert_eq!(moved.tab_ids(), tabs(&["b", "c", "a"]));
        let stacked = view
            .moved_pane(&TabId::new("a"), &TabId::new("c"), SplitSide::Bottom)
            .unwrap();
        assert!(stacked.is_stacked("a"));
        let resized = view.resized(&[2.0, 1.0, 1.0]).unwrap();
        assert!((resized.slots[0].size() - 0.5).abs() < 1e-9);
        assert!(view.resized(&[1.0, -1.0, 1.0]).is_none());
        assert!(view.resized(&[1.0]).is_none());
        assert_eq!(view.flipped().orientation, Orientation::Vertical);
    }
}
