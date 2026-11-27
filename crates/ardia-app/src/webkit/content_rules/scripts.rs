use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{NSArray, NSDictionary, NSString};
use objc2_web_kit::{
    WKContentWorld, WKScriptMessage, WKScriptMessageHandlerWithReply, WKUserContentController,
    WKUserScript, WKUserScriptInjectionTime,
};

use super::extras::{CosmeticIndex, HANDLER_NAME, ScriptletSources, WORLD_NAME, make_scripts};

pub type IndexCell = Rc<RefCell<Option<Arc<CosmeticIndex>>>>;

pub struct LookupIvars {
    index: IndexCell,
    lookups: RefCell<u64>,
    applied: RefCell<u64>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ArdiaGpuiContentBlockerScripts"]
    #[ivars = LookupIvars]
    pub struct Lookup;

    unsafe impl NSObjectProtocol for Lookup {}

    unsafe impl WKScriptMessageHandlerWithReply for Lookup {
        #[unsafe(method(userContentController:didReceiveScriptMessage:replyHandler:))]
        unsafe fn received(
            &self,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
            reply: &block2::DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>,
        ) {
            match self.answer(message) {
                Some(found) => reply.call((
                    Retained::as_ptr(&found) as *mut AnyObject,
                    std::ptr::null_mut(),
                )),
                None => reply.call((std::ptr::null_mut(), std::ptr::null_mut())),
            }
        }
    }
);

fn strings_at(body: &AnyObject, key: &str, limit: usize) -> Option<Vec<String>> {
    let key = NSString::from_str(key);
    let value: Option<Retained<AnyObject>> = unsafe { msg_send![body, objectForKey: &*key] };
    let array = value?.downcast::<NSArray>().ok()?;
    if array.count() > limit {
        return None;
    }
    array
        .iter()
        .map(|item| {
            item.downcast_ref::<NSString>()
                .map(|s| s.to_string().to_lowercase())
        })
        .collect()
}

fn ns_strings(items: &[String]) -> Retained<NSArray<NSString>> {
    let owned: Vec<Retained<NSString>> = items.iter().map(|s| NSString::from_str(s)).collect();
    NSArray::from_retained_slice(&owned)
}

impl Lookup {
    fn create(mtm: MainThreadMarker, index: IndexCell) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(LookupIvars {
            index,
            lookups: RefCell::new(0),
            applied: RefCell::new(0),
        });
        unsafe { msg_send![super(this), init] }
    }

    fn answer(
        &self,
        message: &WKScriptMessage,
    ) -> Option<Retained<NSDictionary<NSString, NSArray<NSString>>>> {
        let body = unsafe { message.body() };
        body.downcast_ref::<NSDictionary>()?;
        let hostnames = strings_at(&body, "hostnames", 64)?;
        let entities = strings_at(&body, "entities", 256)?;
        let ivars = self.ivars();
        *ivars.lookups.borrow_mut() += 1;
        let index = ivars.index.borrow().clone()?;
        let found = index.lookup(&hostnames, &entities);
        if found.css.is_empty() && found.procedural.is_empty() {
            return None;
        }
        *ivars.applied.borrow_mut() += 1;
        let keys = [NSString::from_str("css"), NSString::from_str("procedural")];
        let values = [ns_strings(&found.css), ns_strings(&found.procedural)];
        let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
        let value_refs: Vec<&NSArray<NSString>> = values.iter().map(|v| &**v).collect();
        Some(NSDictionary::from_slices(&key_refs, &value_refs))
    }

    pub fn counts(&self) -> (u64, u64) {
        (
            *self.ivars().lookups.borrow(),
            *self.ivars().applied.borrow(),
        )
    }
}

struct Installed {
    controller: Weak<WKUserContentController>,
    key: String,
}

pub struct Scripts {
    pub index: IndexCell,
    lookup: Option<Retained<Lookup>>,
    world: Option<Retained<WKContentWorld>>,
    scripts: Vec<Retained<WKUserScript>>,
    mine: Vec<Weak<WKUserScript>>,
    key: String,
    installed: Vec<Installed>,
    pub scriptlet_bytes: usize,
}

impl Default for Scripts {
    fn default() -> Self {
        Self {
            index: Rc::new(RefCell::new(None)),
            lookup: None,
            world: None,
            scripts: Vec::new(),
            mine: Vec::new(),
            key: String::new(),
            installed: Vec::new(),
            scriptlet_bytes: 0,
        }
    }
}

impl Scripts {
    fn world(&mut self, mtm: MainThreadMarker) -> Retained<WKContentWorld> {
        self.world
            .get_or_insert_with(|| unsafe {
                WKContentWorld::worldWithName(&NSString::from_str(WORLD_NAME), mtm)
            })
            .clone()
    }

    pub fn attach(&mut self, controller: &WKUserContentController) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let world = self.world(mtm);
        let index = self.index.clone();
        let lookup = self
            .lookup
            .get_or_insert_with(|| Lookup::create(mtm, index))
            .clone();
        self.installed.retain(|i| i.controller.load().is_some());
        if self
            .installed
            .iter()
            .any(|i| i.controller.load().is_some_and(|c| &*c == controller))
        {
            return;
        }
        unsafe {
            controller.addScriptMessageHandlerWithReply_contentWorld_name(
                ProtocolObject::from_ref(&*lookup),
                &world,
                &NSString::from_str(HANDLER_NAME),
            )
        };
        self.installed.push(Installed {
            controller: Weak::from(controller),
            key: "\u{0}".into(),
        });
        self.apply_all();
    }

    pub fn update(
        &mut self,
        sources: Option<&ScriptletSources>,
        index: Option<Arc<CosmeticIndex>>,
        trusted: &[String],
        key: &str,
    ) {
        let cosmetic = index.as_ref().is_some_and(|i| i.selector_count() > 0)
            || super::extras::has_user_hides();
        *self.index.borrow_mut() = index;
        if key == self.key {
            return;
        }
        self.key = key.to_owned();
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let world = self.world(mtm);
        self.scripts = sources
            .map(|sources| {
                let made = make_scripts(sources, trusted, cosmetic);
                let page = unsafe { WKContentWorld::pageWorld(mtm) };
                [(made.main, page), (made.isolated, world)]
                    .into_iter()
                    .filter_map(|(source, world)| {
                        let source = source?;
                        Some(unsafe {
                            WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                                WKUserScript::alloc(mtm),
                                &NSString::from_str(&source),
                                WKUserScriptInjectionTime::AtDocumentStart,
                                false,
                                &world,
                            )
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.scriptlet_bytes = self
            .scripts
            .iter()
            .map(|s| unsafe { s.source() }.len())
            .sum();
        self.mine.retain(|w| w.load().is_some());
        self.mine
            .extend(self.scripts.iter().map(|s| Weak::from(&**s)));
        self.apply_all();
    }

    fn apply_all(&mut self) {
        self.installed.retain(|i| i.controller.load().is_some());
        let mine: Vec<Retained<WKUserScript>> = self.mine.iter().filter_map(Weak::load).collect();
        for installed in &mut self.installed {
            if installed.key == self.key {
                continue;
            }
            let Some(controller) = installed.controller.load() else {
                continue;
            };
            let current = unsafe { controller.userScripts() };
            let others: Vec<Retained<WKUserScript>> = current
                .iter()
                .filter(|script| {
                    !mine
                        .iter()
                        .any(|m| Retained::as_ptr(m) == Retained::as_ptr(script))
                })
                .collect();
            unsafe { controller.removeAllUserScripts() };
            for script in others.iter().chain(&self.scripts) {
                unsafe { controller.addUserScript(script) };
            }
            installed.key = self.key.clone();
        }
    }

    pub fn counts(&self) -> (u64, u64) {
        self.lookup.as_ref().map_or((0, 0), |l| l.counts())
    }
}
