use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, Font, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, LayoutId, Pixels, ShapedLine, SharedString, Size, Style, TextRun, Window,
    point, size,
};

use crate::scale::px;

pub struct TrackedText {
    text: SharedString,
    color: Hsla,
    font_size: f32,
    line_height: f32,
    weight: FontWeight,
    tracking: f32,
}

pub fn tracked_text(
    text: impl Into<SharedString>,
    font_size: f32,
    line_height: f32,
    tracking: f32,
) -> TrackedText {
    TrackedText {
        text: text.into(),
        color: gpui::black(),
        font_size,
        line_height,
        weight: FontWeight::NORMAL,
        tracking,
    }
}

impl TrackedText {
    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = color.into();
        self
    }

    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }
}

#[derive(Clone)]
pub struct Shaper {
    font: Font,
    font_size: Pixels,
    tracking: Pixels,
}

impl Shaper {
    fn shape(&self, text: &str, color: Hsla, window: &Window) -> ShapedLine {
        let run = TextRun {
            len: text.len(),
            font: self.font.clone(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        window.text_system().shape_line(
            SharedString::from(text.to_owned()),
            self.font_size,
            &[run],
            None,
        )
    }

    fn width(&self, text: &str, window: &Window) -> Pixels {
        tracked_width(
            self.shape(text, gpui::black(), window).width,
            text.chars().count(),
            self.tracking,
        )
    }
}

pub fn tracked_width(shaped: Pixels, chars: usize, tracking: Pixels) -> Pixels {
    shaped + tracking * chars as f32
}

pub fn wrap_lines(text: &str, max: Option<f32>, width: &mut dyn FnMut(&str) -> f32) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split(' ').filter(|word| !word.is_empty()) {
            let candidate = if current.is_empty() {
                word.to_owned()
            } else {
                format!("{current} {word}")
            };
            let fits = max.is_none_or(|max| width(&candidate) <= max + 0.01);
            if fits || current.is_empty() {
                current = candidate;
            } else {
                lines.push(std::mem::take(&mut current));
                current = word.to_owned();
            }
        }
        lines.push(current);
    }
    lines
}

fn lines_for(shaper: &Shaper, text: &str, max: Option<Pixels>, window: &Window) -> Vec<String> {
    wrap_lines(text, max.map(f32::from), &mut |line| {
        f32::from(shaper.width(line, window))
    })
}

impl Element for TrackedText {
    type RequestLayoutState = Shaper;
    type PrepaintState = ();

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
        _cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut font = window.text_style().font();
        font.weight = self.weight;
        let shaper = Shaper {
            font,
            font_size: px(self.font_size),
            tracking: px(self.tracking),
        };
        let measure_shaper = shaper.clone();
        let text = self.text.clone();
        let line_height = px(self.line_height);
        let layout = window.request_measured_layout(
            Style::default(),
            move |known: Size<Option<Pixels>>, available: Size<AvailableSpace>, window, _| {
                let max = known.width.or(match available.width {
                    AvailableSpace::Definite(width) => Some(width),
                    _ => None,
                });
                let lines = lines_for(&measure_shaper, &text, max, window);
                let widest = lines
                    .iter()
                    .map(|line| measure_shaper.width(line, window))
                    .fold(Pixels::ZERO, |a, b| a.max(b));
                size(
                    known.width.unwrap_or(widest.ceil()),
                    line_height * lines.len().max(1) as f32,
                )
            },
        );
        (layout, shaper)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        shaper: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let line_height = px(self.line_height);
        let lines = lines_for(shaper, &self.text, Some(bounds.size.width), window);
        for (row, line) in lines.iter().enumerate() {
            let shaped = shaper.shape(line, self.color, window);
            let baseline = bounds.origin.y
                + line_height * row as f32
                + (line_height - (shaped.ascent + shaped.descent)) / 2.0
                + shaped.ascent;
            for run in shaped.runs.iter() {
                for glyph in run.glyphs.iter() {
                    let before = line.get(..glyph.index).map_or(0, |s| s.chars().count());
                    let x = bounds.origin.x + glyph.position.x + shaper.tracking * before as f32;
                    let painted = window.paint_glyph(
                        point(x, baseline + glyph.position.y),
                        run.font_id,
                        glyph.id,
                        shaper.font_size,
                        self.color,
                    );
                    if let Err(error) = painted {
                        log::debug!("tracked text failed to paint a glyph: {error}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_adds_after_every_character() {
        assert_eq!(tracked_width(px(100.), 10, px(-0.4)), px(96.));
    }

    #[test]
    fn words_wrap_greedily_and_keep_explicit_breaks() {
        let mut width = |s: &str| s.chars().count() as f32 * 10.0;
        assert_eq!(
            wrap_lines("one two three", Some(75.0), &mut width),
            ["one two", "three"]
        );
        assert_eq!(wrap_lines("one two", None, &mut width), ["one two"]);
        assert_eq!(wrap_lines("a\nb", Some(500.0), &mut width), ["a", "b"]);
        assert_eq!(
            wrap_lines("enormousword", Some(20.0), &mut width),
            ["enormousword"]
        );
    }
}
