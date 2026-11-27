use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::actions::PageUpdate;
use ardia_state::model::PageEngine;
use ardia_state::{Action, TabId};
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use parking_lot::Mutex;
use serde_json::Value;

use super::page;
use super::site_data::with_deadline;
use super::telemetry::{self, EngineSwap};
use crate::coordinator::AppCoordinator;

pub const SWAP_DEADLINE: Duration = Duration::from_millis(3000);
pub const POLL: Duration = Duration::from_millis(50);
pub const HIDDEN_POLL: Duration = Duration::from_millis(250);
pub const EVALUATE_DEADLINE: Duration = Duration::from_millis(400);

pub const SCROLL_POSITION: &str = r#"post("result", JSON.stringify({ x: scrollX, y: scrollY }))"#;

pub fn first_paint_script(scroll: Option<(i64, i64)>, on_screen: bool) -> String {
    let target = scroll.map_or_else(
        || "null".to_owned(),
        |(x, y)| format!("{{\"x\":{x},\"y\":{y}}}"),
    );
    let done = if on_screen {
        r#"requestAnimationFrame(() => requestAnimationFrame(() => post("result", "true")));"#
    } else {
        r#"post("result", "true");"#
    };
    format!(
        r#"(() => {{
  const shown = /^(https?|file):$/.test(location.protocol) && location.href !== "about:blank";
  const painted = shown && (performance.getEntriesByName("first-contentful-paint").length > 0 || document.readyState === "complete");
  if (!painted) return post("result", "false");
  const target = {target};
  if (target && target.y > 0) {{
    const room = Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight);
    if (room + 1 < target.y && document.readyState !== "complete") return post("result", "false");
    if (Math.abs(scrollY - Math.min(target.y, room)) > 1 || Math.abs(scrollX - target.x) > 1) scrollTo(target.x, Math.min(target.y, room));
  }}
  {done}
}})()"#
    )
}

pub fn scroll_from(value: &Value) -> Option<(i64, i64)> {
    let x = value.get("x")?.as_f64()?;
    let y = value.get("y")?.as_f64()?;
    (x.is_finite() && y.is_finite() && (x > 0.0 || y > 0.0))
        .then(|| (x.round() as i64, y.round() as i64))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Held {
    pub loading: Option<bool>,
    pub progress: Option<f32>,
}

#[derive(Clone, Debug)]
struct Swap {
    id: u64,
    to: PageEngine,
    scroll: Option<(i64, i64)>,
    zoom: bool,
    started: Instant,
    watching: bool,
    visible: bool,
    held: Held,
}

#[derive(Default)]
struct Swaps {
    next: u64,
    live: HashMap<TabId, Swap>,
}

static SWAPS: Mutex<Option<Swaps>> = Mutex::new(None);

fn with_swaps<T>(run: impl FnOnce(&mut Swaps) -> T) -> T {
    let mut guard = SWAPS.lock();
    run(guard.get_or_insert_with(Swaps::default))
}

pub fn swapping(tab: &TabId) -> bool {
    with_swaps(|swaps| swaps.live.contains_key(tab))
}

pub fn hold(tab: &TabId, update: &mut PageUpdate) -> bool {
    with_swaps(|swaps| {
        let Some(swap) = swaps.live.get_mut(tab) else {
            return false;
        };
        if let Some(loading) = update.loading.take() {
            swap.held.loading = Some(loading);
        }
        if let Some(progress) = update.progress.take() {
            swap.held.progress = Some(progress);
        }
        true
    })
}

fn timer(delay: Duration) -> oneshot::Receiver<()> {
    let (done, wait) = oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("ardia-engine-swap-timer".into())
        .spawn(move || {
            std::thread::sleep(delay);
            let _ = done.send(());
        });
    wait
}

impl AppCoordinator {
    pub(crate) fn evaluate_page(
        &self,
        tab: &TabId,
        body: &str,
    ) -> LocalBoxFuture<'static, Option<Value>> {
        if page::has(tab) {
            let (answer, reply) = oneshot::channel();
            page::evaluate(
                tab,
                body,
                Box::new(move |result| {
                    let value = result.and_then(|text| serde_json::from_str::<Value>(&text).ok());
                    let _ = answer.send(value);
                }),
            );
            return with_deadline(reply.map(|r| r.ok().flatten()), EVALUATE_DEADLINE, None)
                .boxed_local();
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return futures::future::ready(None).boxed_local();
        };
        let reply = engine.evaluate_js(engine_tab, body);
        with_deadline(reply.map(|r| r.ok().flatten()), EVALUATE_DEADLINE, None).boxed_local()
    }

    fn carry_zoom(&self, tab: &TabId, to: PageEngine, url: &str) -> bool {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        let host = page::host_of(url);
        if host.is_empty() || !listed.zoom.is_finite() || listed.zoom <= 0.0 {
            return false;
        }
        if to == PageEngine::Webkit {
            #[cfg(target_os = "macos")]
            page::set_host_zoom(
                &state.engine_profile(&listed.profile_id),
                &host,
                listed.zoom,
            );
        }
        (listed.zoom - 1.0).abs() > 0.001
    }

    pub fn hold_page_for_swap(
        self: &Arc<Self>,
        tab: &TabId,
        to: PageEngine,
        url: &str,
        keep_scroll: bool,
    ) -> LocalBoxFuture<'static, Option<u64>> {
        if !self.store().snapshot().settings.engine_switch_keeps_page {
            self.carry_zoom(tab, to, url);
            return futures::future::ready(None).boxed_local();
        }
        let read = keep_scroll.then(|| self.evaluate_page(tab, SCROLL_POSITION));
        let me = Arc::clone(self);
        let tab = tab.clone();
        let url = url.to_owned();
        async move {
            let scroll = match read {
                Some(read) => read.await.as_ref().and_then(scroll_from),
                None => None,
            };
            me.store().snapshot().tab(tab.as_str())?;
            let zoom = me.carry_zoom(&tab, to, &url);
            let id = with_swaps(|swaps| {
                swaps.next += 1;
                let id = swaps.next;
                let held = swaps
                    .live
                    .get(&tab)
                    .map(|s| s.held.clone())
                    .unwrap_or_default();
                swaps.live.insert(
                    tab.clone(),
                    Swap {
                        id,
                        to,
                        scroll,
                        zoom,
                        started: Instant::now(),
                        watching: false,
                        visible: false,
                        held,
                    },
                );
                id
            });
            let weak = Arc::downgrade(&me);
            let watched = tab.clone();
            me.spawn(async move {
                let _ = timer(SWAP_DEADLINE).await;
                if let Some(me) = weak.upgrade() {
                    me.finish_swap(&watched, id, true);
                }
            });
            Some(id)
        }
        .boxed_local()
    }

    pub fn drop_swap(&self, tab: &TabId, only: Option<u64>) {
        let taken = with_swaps(|swaps| {
            let matches = swaps
                .live
                .get(tab)
                .is_some_and(|s| only.is_none_or(|id| s.id == id));
            if matches {
                swaps.live.remove(tab)
            } else {
                None
            }
        });
        if let Some(swap) = taken {
            self.release_held(tab, swap.held);
            self.release_retiring(tab);
        }
    }

    fn release_held(&self, tab: &TabId, held: Held) {
        if self.store().snapshot().tab(tab.as_str()).is_none() {
            return;
        }
        if held.loading.is_none() && held.progress.is_none() {
            return;
        }
        let progress = match (held.loading, held.progress) {
            (Some(false), _) => Some(0.0),
            (_, progress) => progress,
        };
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                loading: held.loading,
                progress,
                ..PageUpdate::default()
            },
        });
    }

    fn finish_swap(&self, tab: &TabId, id: u64, timed_out: bool) {
        let taken = with_swaps(|swaps| {
            if swaps.live.get(tab).is_some_and(|s| s.id == id) {
                swaps.live.remove(tab)
            } else {
                None
            }
        });
        let Some(swap) = taken else {
            return;
        };
        self.release_held(tab, swap.held.clone());
        self.release_retiring(tab);
        if self.store().snapshot().tab(tab.as_str()).is_none() {
            return;
        }
        telemetry::note_engine_swap(
            swap.to,
            EngineSwap {
                ms: swap.started.elapsed().as_secs_f64() * 1000.0,
                timed_out,
                hidden: !swap.watching || !swap.visible,
                scroll: swap.scroll.is_some(),
                zoom: swap.zoom,
            },
        );
    }

    pub(crate) fn tab_on_screen(&self, tab: &TabId) -> bool {
        self.bridge
            .lock()
            .shown
            .values()
            .any(|shown| shown.contains(tab))
            || self
                .store()
                .snapshot()
                .tab(tab.as_str())
                .and_then(|t| {
                    self.store()
                        .snapshot()
                        .window(t.window_id.as_str())
                        .and_then(|w| w.active_tab().cloned())
                })
                .is_some_and(|active| &active == tab)
    }

    pub fn watch_first_paint(self: &Arc<Self>, tab: &TabId) {
        let visible = self.tab_on_screen(tab);
        let started = with_swaps(|swaps| {
            let swap = swaps.live.get_mut(tab)?;
            if swap.watching {
                return None;
            }
            swap.watching = true;
            swap.visible = visible;
            Some((swap.id, swap.scroll))
        });
        let Some((id, scroll)) = started else {
            return;
        };
        if !visible && scroll.is_none() {
            self.finish_swap(tab, id, false);
            return;
        }
        let script = first_paint_script(scroll, visible);
        let weak = Arc::downgrade(self);
        let tab = tab.clone();
        self.spawn(async move {
            loop {
                let still = with_swaps(|swaps| swaps.live.get(&tab).is_some_and(|s| s.id == id));
                if !still {
                    return;
                }
                let Some(me) = weak.upgrade() else {
                    return;
                };
                let painted = me.evaluate_page(&tab, &script);
                drop(me);
                let painted = painted.await;
                let Some(me) = weak.upgrade() else {
                    return;
                };
                if painted == Some(Value::Bool(true)) {
                    me.finish_swap(&tab, id, false);
                    return;
                }
                drop(me);
                let _ = timer(if visible { POLL } else { HIDDEN_POLL }).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_paint_script_carries_the_scroll_target() {
        let script = first_paint_script(Some((0, 640)), true);
        assert!(script.contains(r#"const target = {"x":0,"y":640};"#));
        assert!(script.contains("requestAnimationFrame(() => requestAnimationFrame"));
        let hidden = first_paint_script(None, false);
        assert!(hidden.contains("const target = null;"));
        assert!(!hidden.contains("requestAnimationFrame"));
        assert_eq!(
            scroll_from(&serde_json::json!({ "x": 0, "y": 120.6 })),
            Some((0, 121))
        );
        assert_eq!(scroll_from(&serde_json::json!({ "x": 0, "y": 0 })), None);
    }

    #[test]
    fn held_loading_waits_for_the_swap() {
        let tab = TabId::from("swap-test-tab");
        with_swaps(|swaps| {
            swaps.live.insert(
                tab.clone(),
                Swap {
                    id: 99,
                    to: PageEngine::Webkit,
                    scroll: None,
                    zoom: false,
                    started: Instant::now(),
                    watching: false,
                    visible: false,
                    held: Held::default(),
                },
            )
        });
        let mut update = PageUpdate {
            loading: Some(true),
            progress: Some(0.4),
            title: Some("t".into()),
            ..PageUpdate::default()
        };
        assert!(hold(&tab, &mut update));
        assert_eq!(update.loading, None);
        assert_eq!(update.progress, None);
        assert_eq!(update.title.as_deref(), Some("t"));
        assert!(swapping(&tab));
        with_swaps(|swaps| swaps.live.remove(&tab));
        assert!(!hold(&TabId::from("other"), &mut update));
    }
}
