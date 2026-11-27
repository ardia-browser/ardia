use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use gpui::{
    App, Bounds, ContentMask, Element, ElementId, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, LayoutId, Length, Pixels, ShapedLine, SharedString, Style, TextAlign,
    TextRun, Window, point,
};
use smallvec::SmallVec;

use crate::primitives::fade_label::single_line;
use crate::scale;

pub const FADE: f32 = 12.0;
pub const FADE_STEPS: usize = 6;
pub const PAUSE_MS: f64 = 1500.0;
pub const SPEED: f64 = 30.0;
pub const FADE_EDGE: f32 = 0.03;

#[derive(Clone, Debug)]
struct Group {
    reset: String,
    iterations: i32,
    overflows: HashMap<&'static str, f32>,
    started: Instant,
}

thread_local! {
    static GROUPS: RefCell<HashMap<String, Group>> = RefCell::new(HashMap::new());
}

fn max_overflow(overflows: &HashMap<&'static str, f32>) -> f32 {
    overflows.values().copied().fold(0.0, f32::max)
}

pub fn progress_at(elapsed_ms: f64, max_overflow: f32, iterations: i32) -> (f32, bool) {
    if max_overflow < 1.0 || iterations == 0 {
        return (0.0, false);
    }
    let travel = f64::from(max_overflow) / SPEED * 1000.0;
    let cycle = 2.0 * (PAUSE_MS + travel);
    if iterations > 0 && elapsed_ms >= cycle * f64::from(iterations) {
        return (0.0, false);
    }
    let t = elapsed_ms.max(0.0) % cycle;
    let p = if t < PAUSE_MS {
        0.0
    } else if t < PAUSE_MS + travel {
        (t - PAUSE_MS) / travel
    } else if t < 2.0 * PAUSE_MS + travel {
        1.0
    } else {
        1.0 - (t - 2.0 * PAUSE_MS - travel) / travel
    };
    (p as f32, true)
}

fn sync_group(key: &str, reset: &str, iterations: i32) {
    GROUPS.with(|groups| {
        let mut groups = groups.borrow_mut();
        let group = groups.entry(key.to_owned()).or_insert_with(|| Group {
            reset: reset.to_owned(),
            iterations,
            overflows: HashMap::new(),
            started: Instant::now(),
        });
        if group.reset != reset || group.iterations != iterations {
            group.reset = reset.to_owned();
            group.iterations = iterations;
            group.started = Instant::now();
        }
    });
}

fn report(key: &str, line: &'static str, overflow: f32) {
    GROUPS.with(|groups| {
        if let Some(group) = groups.borrow_mut().get_mut(key) {
            let known = group.overflows.get(line).copied().unwrap_or(0.0);
            if (known - overflow).abs() < 0.5 {
                return;
            }
            let before = max_overflow(&group.overflows);
            group.overflows.insert(line, overflow);
            if (max_overflow(&group.overflows) - before).abs() > f32::EPSILON {
                group.started = Instant::now();
            }
        }
    });
}

fn group_progress(key: &str) -> (f32, bool) {
    GROUPS.with(|groups| {
        groups.borrow().get(key).map_or((0.0, false), |group| {
            let elapsed = group.started.elapsed().as_secs_f64() * 1000.0;
            progress_at(elapsed, max_overflow(&group.overflows), group.iterations)
        })
    })
}

pub fn forget_group(key: &str) {
    GROUPS.with(|groups| groups.borrow_mut().remove(key));
}

pub fn edge_strengths(progress: f32) -> (f32, f32) {
    let left = (progress / FADE_EDGE).clamp(0.0, 1.0);
    let right = ((1.0 - progress) / FADE_EDGE).clamp(0.0, 1.0);
    (left, right)
}

pub fn glyph_alpha(center_x: f32, box_width: f32, left: f32, right: f32) -> f32 {
    let step = FADE / FADE_STEPS as f32;
    let mut alpha = 1.0;
    if center_x < FADE {
        let slice = (center_x.max(0.0) / step)
            .floor()
            .min(FADE_STEPS as f32 - 1.0);
        let kept = (slice + 0.5) / FADE_STEPS as f32;
        alpha *= 1.0 - left * (1.0 - kept);
    }
    let from = box_width - FADE;
    if center_x > from {
        let slice = ((center_x - from) / step)
            .floor()
            .clamp(0.0, FADE_STEPS as f32 - 1.0);
        let kept = 1.0 - (slice + 0.5) / FADE_STEPS as f32;
        alpha *= 1.0 - right * (1.0 - kept);
    }
    alpha
}

pub struct Marquee {
    group: String,
    reset: String,
    iterations: i32,
    line: &'static str,
    text: SharedString,
    color: Hsla,
    font_size: f32,
    line_height: f32,
    weight: FontWeight,
    tabular: bool,
}

pub fn marquee(
    group: &str,
    reset: &str,
    iterations: i32,
    line: &'static str,
    text: impl Into<SharedString>,
) -> Marquee {
    Marquee {
        group: group.to_owned(),
        reset: reset.to_owned(),
        iterations,
        line,
        text: single_line(text.into()),
        color: gpui::black(),
        font_size: 13.0,
        line_height: 16.0,
        weight: FontWeight::NORMAL,
        tabular: false,
    }
}

impl Marquee {
    pub fn color(mut self, color: Hsla) -> Self {
        self.color = color;
        self
    }

    pub fn size(mut self, font_size: f32, line_height: f32) -> Self {
        self.font_size = font_size;
        self.line_height = line_height;
        self
    }

    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    fn template(&self, window: &Window) -> TextRun {
        let mut font = window.text_style().font();
        font.weight = self.weight;
        if self.tabular {
            font.features = gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]));
        }
        TextRun {
            len: self.text.len(),
            font,
            color: self.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }
}

pub struct Prepared {
    line: Option<ShapedLine>,
    offset: f32,
}

impl Element for Marquee {
    type RequestLayoutState = ();
    type PrepaintState = Prepared;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.height = scale::px(self.line_height).into();
        style.size.width = Length::Auto;
        style.min_size.width = scale::px(0.).into();
        style.flex_grow = 1.0;
        style.flex_shrink = 1.0;
        style.flex_basis = Length::Definite(scale::px(0.).into());
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        sync_group(&self.group, &self.reset, self.iterations);
        if self.text.is_empty() {
            report(&self.group, self.line, 0.0);
            return Prepared {
                line: None,
                offset: 0.0,
            };
        }
        let template = self.template(window);
        let font_size = scale::px(self.font_size);
        let plain = window.text_system().shape_line(
            self.text.clone(),
            font_size,
            std::slice::from_ref(&template),
            None,
        );
        let natural = scale::points(plain.width);
        let box_width = scale::points(bounds.size.width);
        let overflow = if box_width > 0.0 && natural > box_width + 0.5 {
            natural - box_width
        } else {
            0.0
        };
        report(&self.group, self.line, overflow);
        if overflow <= 0.0 {
            return Prepared {
                line: Some(plain),
                offset: 0.0,
            };
        }
        let (progress, animating) = group_progress(&self.group);
        if animating {
            window.request_animation_frame();
        }
        let offset = -overflow * progress;
        let (left, right) = edge_strengths(progress);
        let mut runs: SmallVec<[TextRun; 16]> = SmallVec::new();
        let mut indices = self.text.char_indices().peekable();
        while let Some((start, _)) = indices.next() {
            let end = indices.peek().map_or(self.text.len(), |(next, _)| *next);
            let a = scale::points(plain.x_for_index(start));
            let b = scale::points(plain.x_for_index(end));
            let alpha = glyph_alpha((a + b) / 2.0 + offset, box_width, left, right);
            let color = template.color.opacity(alpha);
            match runs.last_mut() {
                Some(last) if last.color == color => last.len += end - start,
                _ => runs.push(TextRun {
                    len: end - start,
                    color,
                    ..template.clone()
                }),
            }
        }
        let line = window
            .text_system()
            .shape_line(self.text.clone(), font_size, &runs, None);
        Prepared {
            line: Some(line),
            offset,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepared: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(line) = prepared.line.take() else {
            return;
        };
        let origin = point(
            bounds.origin.x + scale::px(prepared.offset),
            bounds.origin.y,
        );
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if let Err(error) = line.paint(
                origin,
                bounds.size.height,
                TextAlign::Left,
                None,
                window,
                cx,
            ) {
                log::debug!("marquee failed to paint: {error}");
            }
        });
    }
}

pub fn tabular(mut m: Marquee) -> Marquee {
    m.tabular = true;
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marquee_pauses_scrolls_at_thirty_points_a_second_and_comes_back() {
        assert_eq!(progress_at(0.0, 30.0, -1), (0.0, true));
        assert_eq!(progress_at(1499.0, 30.0, -1).0, 0.0);
        assert!((progress_at(2000.0, 30.0, -1).0 - 0.5).abs() < 1e-6);
        assert_eq!(progress_at(2600.0, 30.0, -1).0, 1.0);
        assert!((progress_at(4500.0, 30.0, -1).0 - 0.5).abs() < 1e-6);
        assert_eq!(progress_at(5000.0, 30.0, -1).0, 0.0);
        assert_eq!(progress_at(5100.0, 30.0, -1).0, 0.0);
    }

    #[test]
    fn a_counted_marquee_stops_at_rest_and_short_text_never_moves() {
        assert!(progress_at(4999.0, 30.0, 1).1);
        assert_eq!(progress_at(5000.0, 30.0, 1), (0.0, false));
        assert_eq!(progress_at(2000.0, 0.5, -1), (0.0, false));
        assert_eq!(progress_at(2000.0, 30.0, 0), (0.0, false));
    }

    #[test]
    fn edges_fade_in_slices_once_the_text_has_moved() {
        assert_eq!(edge_strengths(0.0), (0.0, 1.0));
        assert_eq!(edge_strengths(1.0), (1.0, 0.0));
        assert_eq!(edge_strengths(0.5), (1.0, 1.0));
        assert_eq!(glyph_alpha(50.0, 100.0, 1.0, 1.0), 1.0);
        assert!((glyph_alpha(1.0, 100.0, 1.0, 1.0) - 0.5 / 6.0).abs() < 1e-6);
        assert_eq!(glyph_alpha(1.0, 100.0, 0.0, 1.0), 1.0);
        assert!((glyph_alpha(99.0, 100.0, 1.0, 1.0) - 0.5 / 6.0).abs() < 1e-6);
    }
}
