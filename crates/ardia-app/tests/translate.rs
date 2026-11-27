use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use ardia_app::translate::native::{Answer, Blocks, LanguageStatus, Translator};
use ardia_app::translate::page::{PageOp, args_of, op_of};
use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::{BrowserEngine, EngineEvent, MockBrowserEngine};
use ardia_state::actions::{Action, NewTab};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, TabId};
use ardia_ui::UiHost;
use ardia_ui::site::SiteAnswer;

#[derive(Default)]
struct Model {
    opened: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<String>>,
    broken: bool,
}

struct FakeTranslator(Arc<Model>);

impl Translator for FakeTranslator {
    fn available(&self) -> bool {
        true
    }

    fn user_languages(&self) -> Vec<String> {
        vec!["en-US".to_owned()]
    }

    fn language_name(&self, language: &str) -> String {
        match language {
            "fr" => "French",
            "en" => "English",
            "de" => "German",
            other => other,
        }
        .to_owned()
    }

    fn detect(&self, text: &str) -> Option<String> {
        text.contains("Bonjour").then(|| "fr".to_owned())
    }

    fn status(&self, _source: &str, _target: &str) -> Answer<LanguageStatus> {
        Box::pin(async { Ok(LanguageStatus::Installed) })
    }

    fn supported_languages(&self) -> Answer<Vec<String>> {
        Box::pin(async { Ok(vec!["fr".to_owned(), "de".to_owned(), "en".to_owned()]) })
    }

    fn prepare(&self, _source: &str, _target: &str) -> Answer<()> {
        Box::pin(async { Ok(()) })
    }

    fn translate_blocks(
        &self,
        _source: &str,
        target: &str,
        blocks: Vec<Vec<String>>,
        _owner: &str,
    ) -> Answer<Blocks> {
        let broken = self.0.broken;
        let target = target.to_owned();
        Box::pin(async move {
            if broken {
                return Err("model down".to_owned());
            }
            Ok(blocks
                .into_iter()
                .map(|pieces| {
                    Some(
                        pieces
                            .into_iter()
                            .map(|piece| format!("[{target}]{piece}"))
                            .collect(),
                    )
                })
                .collect())
        })
    }

    fn open(&self, owner: &str) -> Answer<()> {
        self.0.opened.lock().push(owner.to_owned());
        Box::pin(async { Ok(()) })
    }

    fn cancel(&self, owner: &str) {
        self.0.cancelled.lock().push(owner.to_owned());
    }
}

#[derive(Default)]
struct Page {
    active: bool,
    served: bool,
    applied: Vec<(i64, Option<String>)>,
    reverted: usize,
}

struct Harness {
    engine: Arc<MockBrowserEngine>,
    app: Arc<AppCoordinator>,
    model: Arc<Model>,
    page: Arc<Mutex<Page>>,
}

impl Harness {
    fn new(broken: bool) -> Self {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("translate"),
        ));
        let engine = Arc::new(MockBrowserEngine::started());
        let shared: Arc<dyn BrowserEngine> = engine.clone();
        let app = AppCoordinator::new(store, shared, CoordinatorConfig::default());
        app.set_waker(|| {});
        app.start();
        let model = Arc::new(Model {
            broken,
            ..Model::default()
        });
        app.set_translator(Arc::new(FakeTranslator(Arc::clone(&model))));
        let page = Arc::new(Mutex::new(Page::default()));
        let fake = Arc::clone(&page);
        engine.set_evaluator(move |_, expression| {
            let Some(op) = op_of(expression) else {
                return Ok(None);
            };
            let args = args_of(expression);
            let mut page = fake.lock();
            let answer = match op {
                PageOp::Sample => json!({
                    "lang": "fr",
                    "text": "Bonjour tout le monde, voici une page en français.",
                    "active": page.active
                }),
                PageOp::Holds => json!(page.active),
                PageOp::Start => {
                    page.active = true;
                    json!(true)
                }
                PageOp::Next => {
                    let first = !page.served;
                    page.served = true;
                    json!({
                        "passages": if first { json!([[1, [[2, "Bonjour"], [3, " le monde"]], 0]]) } else { json!([]) },
                        "more": false, "gone": !page.active, "done": 1, "total": 1
                    })
                }
                PageOp::Apply => {
                    if let Some(Value::Array(results)) = args.get(1) {
                        for result in results {
                            page.applied.push((
                                result[0].as_i64().unwrap_or_default(),
                                result[1].as_str().map(str::to_owned),
                            ));
                        }
                    }
                    json!(true)
                }
                PageOp::Revert => {
                    page.active = false;
                    page.reverted += 1;
                    json!(true)
                }
            };
            Ok(Some(Value::String(answer.to_string())))
        });
        let harness = Harness {
            engine,
            app,
            model,
            page,
        };
        harness.pump();
        harness
    }

    fn pump(&self) {
        for _ in 0..40 {
            self.app.poll_parked();
            if self.app.pump().rounds == 0 && self.app.poll_parked() == 0 {
                break;
            }
        }
    }

    fn open(&self, url: &str) -> TabId {
        let state = self.app.store().snapshot();
        let window = state
            .window_order
            .iter()
            .find(|id| {
                state
                    .window(id.as_str())
                    .is_some_and(|w| w.kind == WindowKind::Main)
            })
            .cloned()
            .expect("a window");
        let tab = self
            .app
            .dispatch_action(Action::NewTab {
                window,
                tab: NewTab {
                    url: Some(url.into()),
                    ..NewTab::default()
                },
            })
            .unwrap()
            .tab
            .unwrap();
        self.pump();
        tab
    }

    fn loaded(&self, tab: &TabId) {
        let engine_tab = self.app.engine_tab(tab).expect("an engine tab");
        self.engine.emit(EngineEvent::LoadingChanged {
            tab: engine_tab,
            loading: false,
        });
        self.pump();
    }

    fn toasts(&self) -> Vec<String> {
        let state = self.app.store().snapshot();
        state
            .window_order
            .iter()
            .filter_map(|id| state.window(id.as_str()))
            .flat_map(|w| w.chrome.toasts.iter().map(|t| t.message.clone()))
            .collect()
    }
}

#[test]
fn a_foreign_page_is_detected_translated_and_reverted() {
    let h = Harness::new(false);
    let tab = h.open("https://lemonde.fr/");
    h.loaded(&tab);
    let view = h.app.translate_view(&tab);
    assert!(view.available);
    assert_eq!(view.source.as_deref(), Some("fr"));
    assert_eq!(view.target_name, "English");
    assert!(!view.translated);

    h.app.site_answer(tab.clone(), SiteAnswer::Translate);
    h.pump();
    let view = h.app.translate_view(&tab);
    assert!(view.translated);
    assert_eq!(view.source_name, "French");
    assert_eq!(h.model.opened.lock().len(), 1);
    {
        let page = h.page.lock();
        assert!(page.applied.contains(&(2, Some("[en]Bonjour".to_owned()))));
        assert!(
            page.applied
                .contains(&(3, Some("[en] le monde".to_owned())))
        );
    }
    assert!(h.toasts().iter().any(|t| t == "Translated to English"));

    h.app.site_answer(tab.clone(), SiteAnswer::ShowOriginal);
    h.pump();
    assert!(!h.app.translate_view(&tab).translated);
    assert_eq!(h.page.lock().reverted, 2);
    assert_eq!(h.model.cancelled.lock().len(), 1);
    assert!(h.toasts().iter().any(|t| t == "Translated back to French"));
}

#[test]
fn a_dead_model_reverts_and_says_why() {
    let h = Harness::new(true);
    let tab = h.open("https://lemonde.fr/");
    h.loaded(&tab);
    h.app.site_answer(tab.clone(), SiteAnswer::Translate);
    h.pump();
    assert!(!h.app.translate_view(&tab).translated);
    assert!(
        h.toasts()
            .iter()
            .any(|t| t == "Translation error (model down)")
    );
}

#[test]
fn never_translating_a_site_hides_the_offer_and_languages_list_loads() {
    let h = Harness::new(false);
    let tab = h.open("https://lemonde.fr/");
    h.loaded(&tab);
    h.app
        .site_answer(tab.clone(), SiteAnswer::NeverTranslate(true));
    h.pump();
    let view = h.app.translate_view(&tab);
    assert!(view.never);
    assert_eq!(view.source, None);
    let sites = h
        .app
        .store()
        .snapshot()
        .settings
        .never_translate_sites
        .clone();
    assert!(
        sites
            .values()
            .any(|list| list.contains(&"lemonde.fr".to_owned()))
    );
    assert!(h.app.translate_languages(&tab).is_empty());
    h.pump();
    let languages = h.app.translate_languages(&tab);
    assert_eq!(
        languages
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>(),
        vec!["English", "French", "German"]
    );
}
