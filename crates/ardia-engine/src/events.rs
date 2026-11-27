use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::task::{Context, Poll};

use futures::Stream;
use futures::task::AtomicWaker;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use smallvec::SmallVec;

use crate::types::*;

#[derive(Clone, Debug, PartialEq)]
pub enum EngineEvent {
    Started,
    WillShutDown,
    QuitCancelled,
    EventsDropped {
        count: u64,
        resync: bool,
    },
    PermissionRequested {
        tab: Option<EngineTabId>,
        request: PermissionRequest,
    },
    PermissionDismissed {
        request_id: String,
    },
    ExtensionSidePanel {
        tab: Option<EngineTabId>,
        panel: Value,
    },
    ExtensionActionPopup {
        tab: Option<EngineTabId>,
        popup: Value,
    },
    ExtensionActionShortcut {
        tab: Option<EngineTabId>,
        shortcut: Value,
    },
    ExtensionInstallPrompt {
        profile: Option<EngineProfileId>,
        tab: Option<EngineTabId>,
        prompt: ExtensionInstallPrompt,
    },
    ExtensionInstallFailed {
        tab: Option<EngineTabId>,
        message: String,
    },
    DeviceChooser {
        tab: Option<EngineTabId>,
        chooser: DeviceChooser,
    },
    CastDialog {
        tab: Option<EngineTabId>,
        dialog: CastDialog,
    },
    CastRoutes {
        profile: Option<EngineProfileId>,
        routes: Vec<CastRoute>,
    },
    WindowCreatedByEngine {
        window: EngineWindowId,
        profile: Option<EngineProfileId>,
        kind: NewBrowserKind,
    },
    TabInserted {
        window: EngineWindowId,
        tab: EngineTabId,
        opener: Option<EngineTabId>,
        disposition: String,
    },
    TabRemoved {
        window: EngineWindowId,
        tab: EngineTabId,
    },
    TabActivated {
        window: EngineWindowId,
        tab: EngineTabId,
    },
    DevToolsChanged {
        window: EngineWindowId,
        tab: EngineTabId,
        open: bool,
    },
    FullscreenChanged {
        window: EngineWindowId,
        tab: EngineTabId,
        fullscreen: bool,
    },
    PasswordPrompt {
        window: EngineWindowId,
        tab: EngineTabId,
        prompt: PasswordPrompt,
    },
    AutofillPrompt {
        window: EngineWindowId,
        tab: EngineTabId,
        prompt: AutofillPrompt,
    },
    ShowRequested {
        window: EngineWindowId,
        active: bool,
    },
    WindowCloseCancelled {
        window: EngineWindowId,
    },
    WindowCanTakeTabs {
        window: EngineWindowId,
    },
    ConfirmCloseWithDownloads {
        window: EngineWindowId,
        count: i32,
        request: u64,
    },
    WindowClosed {
        window: EngineWindowId,
    },
    TitleChanged {
        tab: EngineTabId,
        title: String,
    },
    ShownTitleChanged {
        tab: EngineTabId,
        title: String,
        url: String,
    },
    UrlChanged {
        tab: EngineTabId,
        url: String,
    },
    LoadingChanged {
        tab: EngineTabId,
        loading: bool,
    },
    ProgressChanged {
        tab: EngineTabId,
        progress: f64,
    },
    FaviconChanged {
        tab: EngineTabId,
        url: Option<String>,
    },
    NavigationStateChanged {
        tab: EngineTabId,
        can_go_back: bool,
        can_go_forward: bool,
    },
    FindMatches {
        tab: EngineTabId,
        matches: FindMatches,
    },
    PageMessage {
        tab: EngineTabId,
        message: PageMessage,
    },
    TabWillClose {
        tab: EngineTabId,
    },
    RendererGone {
        tab: EngineTabId,
        status: String,
        code: i32,
    },
    LoadFailed {
        tab: EngineTabId,
        url: String,
        code: i32,
        description: String,
    },
    StatusText {
        tab: EngineTabId,
        text: String,
    },
    AppUrlRequested {
        tab: EngineTabId,
        url: String,
        user_gesture: bool,
    },
    ThemeColorChanged {
        tab: EngineTabId,
        color: Option<String>,
    },
    DocumentCommitted {
        tab: EngineTabId,
    },
    FocusGained {
        tab: EngineTabId,
    },
    AudioChanged {
        tab: EngineTabId,
        audible: bool,
        muted: bool,
    },
    SecurityChanged {
        tab: EngineTabId,
    },
    ZoomChanged {
        tab: EngineTabId,
        zoom: f64,
    },
    PopupBlocked {
        tab: EngineTabId,
        popup: BlockedPopup,
    },
    PreferredSizeChanged {
        tab: EngineTabId,
        size: Size,
    },
    ExternalAppRequest {
        tab: EngineTabId,
        request: Value,
    },
    ActivationRequested {
        tab: EngineTabId,
        reason: String,
        from_other_app: bool,
    },
    PipActivity {
        tab: EngineTabId,
        name: String,
        payload: Value,
    },
    PipChanged {
        tab: EngineTabId,
        state: PipState,
    },
    AutofillSuggestionsShown {
        tab: EngineTabId,
        items: Vec<Value>,
    },
    RequestsBlocked {
        tab: EngineTabId,
        count: i32,
        last_url: String,
    },
    ContextMenuCommand {
        tab: EngineTabId,
        item: String,
        text: String,
        modifiers: Value,
    },
    ShareFromContextMenu {
        tab: EngineTabId,
        share: Value,
    },
    ContextMenuShown {
        tab: EngineTabId,
        items: Vec<Value>,
    },
    NavigationBecameDownload {
        tab: EngineTabId,
        url: String,
    },
    DiscardedChanged {
        tab: EngineTabId,
        discarded: bool,
        reason: Option<String>,
    },
    Unresponsive {
        tab: EngineTabId,
    },
    Responsive {
        tab: EngineTabId,
    },
    MediaAccessChanged {
        tab: EngineTabId,
        access: MediaAccess,
    },
    TabOffered {
        offer: TabOffer,
    },
    PageScroll {
        view: ViewToken,
        ack: PageScrollAck,
        consumed: bool,
    },
    PageOverscroll {
        view: ViewToken,
        allows_horizontal: bool,
    },
    Download(DownloadEvent),
    Service(ServiceEvent),
    OpenUrls {
        urls: Vec<String>,
        sender: Option<UrlSender>,
    },
    DockReopen {
        has_visible_windows: bool,
    },
    MenuCommand {
        command: String,
        arg: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum CoalesceKey {
    Progress(EngineTabId),
    Status(EngineTabId),
    Title(EngineTabId),
    Favicon(EngineTabId),
    NavigationState(EngineTabId),
    Zoom(EngineTabId),
    PreferredSize(EngineTabId),
    MediaAccess(EngineTabId),
    Audio(EngineTabId),
    Find(EngineTabId),
    Blocked(EngineTabId),
    Scroll(ViewToken, PageScrollAck),
    Overscroll(ViewToken),
}

impl EngineEvent {
    pub fn tab(&self) -> Option<EngineTabId> {
        use EngineEvent::*;
        match self {
            PermissionRequested { tab, .. }
            | ExtensionSidePanel { tab, .. }
            | ExtensionActionPopup { tab, .. }
            | ExtensionActionShortcut { tab, .. }
            | ExtensionInstallPrompt { tab, .. }
            | ExtensionInstallFailed { tab, .. }
            | DeviceChooser { tab, .. }
            | CastDialog { tab, .. } => *tab,
            TabInserted { tab, .. }
            | TabRemoved { tab, .. }
            | TabActivated { tab, .. }
            | DevToolsChanged { tab, .. }
            | FullscreenChanged { tab, .. }
            | PasswordPrompt { tab, .. }
            | AutofillPrompt { tab, .. }
            | TitleChanged { tab, .. }
            | ShownTitleChanged { tab, .. }
            | UrlChanged { tab, .. }
            | LoadingChanged { tab, .. }
            | ProgressChanged { tab, .. }
            | FaviconChanged { tab, .. }
            | NavigationStateChanged { tab, .. }
            | FindMatches { tab, .. }
            | PageMessage { tab, .. }
            | TabWillClose { tab }
            | RendererGone { tab, .. }
            | LoadFailed { tab, .. }
            | StatusText { tab, .. }
            | AppUrlRequested { tab, .. }
            | ThemeColorChanged { tab, .. }
            | DocumentCommitted { tab }
            | FocusGained { tab }
            | AudioChanged { tab, .. }
            | SecurityChanged { tab }
            | ZoomChanged { tab, .. }
            | PopupBlocked { tab, .. }
            | PreferredSizeChanged { tab, .. }
            | ExternalAppRequest { tab, .. }
            | ActivationRequested { tab, .. }
            | PipActivity { tab, .. }
            | PipChanged { tab, .. }
            | AutofillSuggestionsShown { tab, .. }
            | RequestsBlocked { tab, .. }
            | ContextMenuCommand { tab, .. }
            | ShareFromContextMenu { tab, .. }
            | ContextMenuShown { tab, .. }
            | NavigationBecameDownload { tab, .. }
            | DiscardedChanged { tab, .. }
            | Unresponsive { tab }
            | Responsive { tab }
            | MediaAccessChanged { tab, .. } => Some(*tab),
            _ => None,
        }
    }

    pub fn window(&self) -> Option<EngineWindowId> {
        use EngineEvent::*;
        match self {
            WindowCreatedByEngine { window, .. }
            | TabInserted { window, .. }
            | TabRemoved { window, .. }
            | TabActivated { window, .. }
            | DevToolsChanged { window, .. }
            | FullscreenChanged { window, .. }
            | PasswordPrompt { window, .. }
            | AutofillPrompt { window, .. }
            | ShowRequested { window, .. }
            | WindowCloseCancelled { window }
            | WindowCanTakeTabs { window }
            | ConfirmCloseWithDownloads { window, .. }
            | WindowClosed { window } => Some(*window),
            _ => None,
        }
    }

    fn coalesce_key(&self) -> Option<CoalesceKey> {
        use EngineEvent::*;
        Some(match self {
            ProgressChanged { tab, .. } => CoalesceKey::Progress(*tab),
            StatusText { tab, .. } => CoalesceKey::Status(*tab),
            TitleChanged { tab, .. } => CoalesceKey::Title(*tab),
            FaviconChanged { tab, .. } => CoalesceKey::Favicon(*tab),
            NavigationStateChanged { tab, .. } => CoalesceKey::NavigationState(*tab),
            ZoomChanged { tab, .. } => CoalesceKey::Zoom(*tab),
            PreferredSizeChanged { tab, .. } => CoalesceKey::PreferredSize(*tab),
            MediaAccessChanged { tab, .. } => CoalesceKey::MediaAccess(*tab),
            AudioChanged { tab, .. } => CoalesceKey::Audio(*tab),
            FindMatches { tab, .. } => CoalesceKey::Find(*tab),
            RequestsBlocked { tab, .. } => CoalesceKey::Blocked(*tab),
            PageScroll { view, ack, .. } => CoalesceKey::Scroll(*view, *ack),
            PageOverscroll { view, .. } => CoalesceKey::Overscroll(*view),
            _ => return None,
        })
    }

    pub fn is_droppable(&self) -> bool {
        use EngineEvent::*;
        self.coalesce_key().is_some()
            || matches!(
                self,
                PageMessage { .. }
                    | Service(_)
                    | Download(DownloadEvent::Changed { .. })
                    | ContextMenuShown { .. }
                    | AutofillSuggestionsShown { .. }
            )
    }

    pub fn prompt(&self) -> Option<PromptKey> {
        use EngineEvent::*;
        let named = |id: &str| (!id.is_empty()).then(|| id.to_owned());
        Some(match self {
            PermissionRequested { request, .. } => PromptKey::Permission(named(&request.id)?),
            ExtensionInstallPrompt { prompt, .. } => {
                PromptKey::ExtensionInstall(named(&prompt.request_id)?)
            }
            ExternalAppRequest { request, .. } => {
                PromptKey::ExternalApp(named(request.get("id")?.as_str()?)?)
            }
            DeviceChooser { chooser, .. } if chooser.open => PromptKey::DeviceChooser(chooser.id),
            CastDialog { dialog, .. } if dialog.open => PromptKey::CastDialog(dialog.id),
            ConfirmCloseWithDownloads { request, .. } => PromptKey::CloseWithDownloads(*request),
            TabOffered { offer } => PromptKey::TabOffer(named(&offer.id)?),
            _ => return None,
        })
    }

    fn touches_prompts(&self) -> bool {
        use EngineEvent::*;
        matches!(
            self,
            PermissionRequested { .. }
                | PermissionDismissed { .. }
                | ExtensionInstallPrompt { .. }
                | ExternalAppRequest { .. }
                | DeviceChooser { .. }
                | CastDialog { .. }
                | ConfirmCloseWithDownloads { .. }
                | TabOffered { .. }
                | TabWillClose { .. }
                | WindowClosed { .. }
        )
    }

    fn merge_into(self, older: EngineEvent) -> EngineEvent {
        match (older, self) {
            (
                EngineEvent::RequestsBlocked { count: before, .. },
                EngineEvent::RequestsBlocked {
                    tab,
                    count,
                    last_url,
                },
            ) => EngineEvent::RequestsBlocked {
                tab,
                count: before.saturating_add(count),
                last_url,
            },
            (_, newer) => newer,
        }
    }
}

pub const DEFAULT_EVENT_CAPACITY: usize = 8192;
pub const OPEN_PROMPT_LIMIT: usize = 256;
const HARD_LIMIT_FACTOR: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PromptKey {
    Permission(String),
    ExtensionInstall(String),
    ExternalApp(String),
    DeviceChooser(i32),
    CastDialog(i32),
    CloseWithDownloads(u64),
    TabOffer(String),
}

impl PromptKey {
    fn evictable(&self) -> bool {
        !matches!(self, Self::CloseWithDownloads(_))
    }
}

#[derive(Default)]
struct OpenPrompts {
    open: VecDeque<(PromptKey, EngineEvent)>,
}

impl OpenPrompts {
    fn settle(&mut self, key: &PromptKey) -> Option<EngineEvent> {
        let index = self.open.iter().position(|(open, _)| open == key)?;
        self.open.remove(index).map(|(_, event)| event)
    }

    fn observe(&mut self, event: &EngineEvent) {
        use EngineEvent::*;
        match event {
            PermissionDismissed { request_id } => {
                self.settle(&PromptKey::Permission(request_id.clone()));
            }
            DeviceChooser { chooser, .. } if !chooser.open => {
                self.settle(&PromptKey::DeviceChooser(chooser.id));
            }
            CastDialog { dialog, .. } if !dialog.open => {
                self.settle(&PromptKey::CastDialog(dialog.id));
            }
            TabWillClose { tab } => self.open.retain(|(_, open)| open.tab() != Some(*tab)),
            WindowClosed { window } => self.open.retain(|(_, open)| open.window() != Some(*window)),
            _ => {
                if let Some(key) = event.prompt() {
                    self.settle(&key);
                    if self.open.len() >= OPEN_PROMPT_LIMIT
                        && let Some(oldest) =
                            self.open.iter().position(|(open, _)| open.evictable())
                    {
                        self.open.remove(oldest);
                    }
                    self.open.push_back((key, event.clone()));
                }
            }
        }
    }
}

type WakeHook = Arc<dyn Fn() + Send + Sync>;

struct QueueState {
    slots: VecDeque<Option<(EngineEvent, Option<CoalesceKey>)>>,
    head_seq: u64,
    live: usize,
    latest: HashMap<CoalesceKey, u64>,
    dropped: u64,
    resync: bool,
    capacity: usize,
    finished: bool,
}

impl QueueState {
    fn new(capacity: usize, finished: bool) -> Self {
        Self {
            slots: VecDeque::new(),
            head_seq: 0,
            live: 0,
            latest: HashMap::new(),
            dropped: 0,
            resync: false,
            capacity: capacity.max(1),
            finished,
        }
    }

    fn insert(&mut self, mut event: EngineEvent) {
        if self.finished {
            return;
        }
        let key = event.coalesce_key();
        if let Some(key) = key
            && let Some(&seq) = self.latest.get(&key)
            && seq >= self.head_seq
        {
            let index = (seq - self.head_seq) as usize;
            if let Some(slot) = self.slots.get_mut(index)
                && let Some((older, _)) = slot.take()
            {
                self.live -= 1;
                event = event.merge_into(older);
            }
        }
        if self.live >= self.capacity && event.is_droppable() {
            self.dropped += 1;
            return;
        }
        if self.live >= self.capacity * HARD_LIMIT_FACTOR {
            self.dropped += self.live as u64 + 1;
            self.resync = true;
            self.slots.clear();
            self.latest.clear();
            self.live = 0;
            return;
        }
        let seq = self.head_seq + self.slots.len() as u64;
        if let Some(key) = key {
            self.latest.insert(key, seq);
        }
        self.slots.push_back(Some((event, key)));
        self.live += 1;
        if self.slots.len() > self.live * 2 + 32 {
            self.compact();
        }
    }

    fn compact(&mut self) {
        let slots = std::mem::take(&mut self.slots);
        self.latest.clear();
        for (event, key) in slots.into_iter().flatten() {
            if let Some(key) = key {
                self.latest
                    .insert(key, self.head_seq + self.slots.len() as u64);
            }
            self.slots.push_back(Some((event, key)));
        }
    }

    fn pop(&mut self) -> Option<EngineEvent> {
        if self.dropped > 0 {
            let count = std::mem::take(&mut self.dropped);
            let resync = std::mem::take(&mut self.resync);
            return Some(EngineEvent::EventsDropped { count, resync });
        }
        while let Some(slot) = self.slots.pop_front() {
            let seq = self.head_seq;
            self.head_seq += 1;
            if let Some((event, key)) = slot {
                self.live -= 1;
                if let Some(key) = key
                    && self.latest.get(&key) == Some(&seq)
                {
                    self.latest.remove(&key);
                }
                return Some(event);
            }
        }
        None
    }

    fn is_empty(&self) -> bool {
        self.live == 0 && self.dropped == 0
    }
}

struct Queue {
    state: Mutex<QueueState>,
    waker: AtomicWaker,
    hook: Mutex<Option<WakeHook>>,
}

impl Queue {
    fn insert(&self, event: EngineEvent) -> bool {
        let mut state = self.state.lock();
        let was_empty = state.is_empty();
        state.insert(event);
        was_empty && !state.is_empty()
    }

    fn mark_finished(&self) {
        self.state.lock().finished = true;
    }

    fn wake(&self) {
        let hook = self.hook.lock().clone();
        let woke = catch_unwind(AssertUnwindSafe(|| {
            self.waker.wake();
            if let Some(hook) = hook {
                hook();
            }
        }));
        if woke.is_err() {
            log::error!("an engine event subscriber's wake hook panicked");
        }
    }
}

#[derive(Default)]
struct Registry {
    queues: Vec<Arc<Queue>>,
    closed: bool,
}

struct BusInner {
    registry: RwLock<Registry>,
    ledger: Mutex<OpenPrompts>,
    capacity: usize,
    published: AtomicU64,
}

#[derive(Clone)]
pub struct EventBus {
    inner: Arc<BusInner>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for EventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventBus")
            .field("subscribers", &self.subscriber_count())
            .field("published", &self.published())
            .finish()
    }
}

impl EventBus {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_EVENT_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(BusInner {
                registry: RwLock::new(Registry::default()),
                ledger: Mutex::new(OpenPrompts::default()),
                capacity: capacity.max(1),
                published: AtomicU64::new(0),
            }),
        }
    }

    pub fn subscribe(&self) -> EventSubscription {
        let mut registry = self.inner.registry.write();
        let queue = Arc::new(Queue {
            state: Mutex::new(QueueState::new(self.inner.capacity, registry.closed)),
            waker: AtomicWaker::new(),
            hook: Mutex::new(None),
        });
        if !registry.closed {
            registry.queues.push(queue.clone());
        }
        drop(registry);
        EventSubscription {
            queue,
            bus: Arc::downgrade(&self.inner),
        }
    }

    pub fn publish(&self, event: EngineEvent) {
        let mut ledger = self.inner.ledger.lock();
        let targets: SmallVec<[Arc<Queue>; 4]> = {
            let registry = self.inner.registry.read();
            if registry.closed {
                return;
            }
            registry.queues.iter().cloned().collect()
        };
        if event.touches_prompts() {
            ledger.observe(&event);
        }
        self.inner.published.fetch_add(1, Ordering::Relaxed);
        let mut ready: SmallVec<[bool; 4]> = SmallVec::new();
        if let Some((last, rest)) = targets.split_last() {
            for queue in rest {
                ready.push(queue.insert(event.clone()));
            }
            ready.push(last.insert(event));
        }
        drop(ledger);
        for (queue, ready) in targets.iter().zip(ready) {
            if ready {
                queue.wake();
            }
        }
    }

    pub fn open_prompts(&self) -> Vec<EngineEvent> {
        self.inner
            .ledger
            .lock()
            .open
            .iter()
            .map(|(_, event)| event.clone())
            .collect()
    }

    pub fn settle_prompt(&self, key: &PromptKey) -> Option<EngineEvent> {
        self.inner.ledger.lock().settle(key)
    }

    pub fn has_subscribers(&self) -> bool {
        self.subscriber_count() > 0
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.registry.read().queues.len()
    }

    pub fn published(&self) -> u64 {
        self.inner.published.load(Ordering::Relaxed)
    }

    pub fn close(&self) {
        let queues = {
            let mut ledger = self.inner.ledger.lock();
            let mut registry = self.inner.registry.write();
            if registry.closed {
                return;
            }
            registry.closed = true;
            ledger.open.clear();
            std::mem::take(&mut registry.queues)
        };
        for queue in &queues {
            queue.mark_finished();
        }
        for queue in &queues {
            queue.wake();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.inner.registry.read().closed
    }
}

pub struct EventSubscription {
    queue: Arc<Queue>,
    bus: Weak<BusInner>,
}

impl std::fmt::Debug for EventSubscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventSubscription")
            .field("pending", &self.pending())
            .finish()
    }
}

impl EventSubscription {
    pub fn try_next(&self) -> Option<EngineEvent> {
        self.queue.state.lock().pop()
    }

    pub fn drain(&self) -> Vec<EngineEvent> {
        let mut state = self.queue.state.lock();
        let mut events = Vec::with_capacity(state.live + usize::from(state.dropped > 0));
        while let Some(event) = state.pop() {
            events.push(event);
        }
        events
    }

    pub fn pending(&self) -> usize {
        let state = self.queue.state.lock();
        state.live + usize::from(state.dropped > 0)
    }

    pub fn set_wake_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.queue.hook.lock() = Some(Arc::new(hook));
        let ready = !self.queue.state.lock().is_empty();
        if ready {
            self.queue.wake();
        }
    }

    pub fn clear_wake_hook(&self) {
        *self.queue.hook.lock() = None;
    }

    pub fn is_finished(&self) -> bool {
        let state = self.queue.state.lock();
        state.finished && state.is_empty()
    }
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        *self.queue.hook.lock() = None;
        if let Some(bus) = self.bus.upgrade() {
            bus.registry
                .write()
                .queues
                .retain(|queue| !Arc::ptr_eq(queue, &self.queue));
        }
    }
}

impl Stream for EventSubscription {
    type Item = EngineEvent;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<EngineEvent>> {
        if let Some(event) = self.try_next() {
            return Poll::Ready(Some(event));
        }
        self.queue.waker.register(cx.waker());
        let mut state = self.queue.state.lock();
        match state.pop() {
            Some(event) => Poll::Ready(Some(event)),
            None if state.finished => Poll::Ready(None),
            None => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use futures::executor::block_on;
    use std::sync::atomic::AtomicUsize;

    fn tab(raw: u64) -> EngineTabId {
        EngineTabId::from_raw(raw).unwrap()
    }

    fn window(raw: u64) -> EngineWindowId {
        EngineWindowId::from_raw(raw).unwrap()
    }

    #[test]
    fn state_events_coalesce_to_the_latest_in_order() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        bus.publish(EngineEvent::ProgressChanged {
            tab: tab(1),
            progress: 0.1,
        });
        bus.publish(EngineEvent::DocumentCommitted { tab: tab(1) });
        bus.publish(EngineEvent::ProgressChanged {
            tab: tab(1),
            progress: 0.5,
        });
        bus.publish(EngineEvent::ProgressChanged {
            tab: tab(2),
            progress: 0.2,
        });
        bus.publish(EngineEvent::ProgressChanged {
            tab: tab(1),
            progress: 0.9,
        });
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::DocumentCommitted { tab: tab(1) },
                EngineEvent::ProgressChanged {
                    tab: tab(2),
                    progress: 0.2
                },
                EngineEvent::ProgressChanged {
                    tab: tab(1),
                    progress: 0.9
                },
            ]
        );
        bus.publish(EngineEvent::ProgressChanged {
            tab: tab(1),
            progress: 1.0,
        });
        assert_eq!(
            events.drain(),
            vec![EngineEvent::ProgressChanged {
                tab: tab(1),
                progress: 1.0
            }]
        );
    }

    #[test]
    fn blocked_request_counts_add_up() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        bus.publish(EngineEvent::RequestsBlocked {
            tab: tab(1),
            count: 2,
            last_url: "a".into(),
        });
        bus.publish(EngineEvent::RequestsBlocked {
            tab: tab(1),
            count: 3,
            last_url: "b".into(),
        });
        assert_eq!(
            events.drain(),
            vec![EngineEvent::RequestsBlocked {
                tab: tab(1),
                count: 5,
                last_url: "b".into()
            }]
        );
    }

    #[test]
    fn lifecycle_events_are_never_coalesced_or_dropped() {
        let bus = EventBus::with_capacity(2);
        let events = bus.subscribe();
        for n in 0..10 {
            bus.publish(EngineEvent::StatusText {
                tab: tab(n + 1),
                text: format!("{n}"),
            });
        }
        bus.publish(EngineEvent::TabWillClose { tab: tab(1) });
        bus.publish(EngineEvent::TabRemoved {
            window: window(1),
            tab: tab(1),
        });
        bus.publish(EngineEvent::WindowClosed { window: window(1) });
        let drained = events.drain();
        assert_eq!(
            drained[0],
            EngineEvent::EventsDropped {
                count: 8,
                resync: false
            }
        );
        assert_eq!(
            &drained[1..3],
            &[
                EngineEvent::StatusText {
                    tab: tab(1),
                    text: "0".into()
                },
                EngineEvent::StatusText {
                    tab: tab(2),
                    text: "1".into()
                },
            ]
        );
        assert_eq!(
            &drained[3..],
            &[
                EngineEvent::TabWillClose { tab: tab(1) },
                EngineEvent::TabRemoved {
                    window: window(1),
                    tab: tab(1)
                },
                EngineEvent::WindowClosed { window: window(1) },
            ]
        );
    }

    #[test]
    fn every_subscriber_gets_every_event() {
        let bus = EventBus::new();
        let first = bus.subscribe();
        let second = bus.subscribe();
        bus.publish(EngineEvent::Started);
        assert_eq!(first.drain(), vec![EngineEvent::Started]);
        assert_eq!(second.drain(), vec![EngineEvent::Started]);
        drop(second);
        bus.publish(EngineEvent::QuitCancelled);
        assert_eq!(bus.subscriber_count(), 1);
        assert_eq!(first.try_next(), Some(EngineEvent::QuitCancelled));
        assert_eq!(bus.published(), 2);
    }

    #[test]
    fn wake_hook_fires_once_per_empty_to_ready_edge() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        events.set_wake_hook(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        bus.publish(EngineEvent::Started);
        bus.publish(EngineEvent::QuitCancelled);
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        events.drain();
        bus.publish(EngineEvent::WillShutDown);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stream_ends_after_close_and_drain() {
        let bus = EventBus::new();
        let mut events = bus.subscribe();
        bus.publish(EngineEvent::Started);
        bus.close();
        bus.publish(EngineEvent::QuitCancelled);
        assert_eq!(block_on(events.next()), Some(EngineEvent::Started));
        assert_eq!(block_on(events.next()), None);
        assert!(events.is_finished());
    }

    #[test]
    fn stream_wakes_a_waiting_task_from_another_thread() {
        let bus = EventBus::new();
        let mut events = bus.subscribe();
        let sender = bus;
        let thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            sender.publish(EngineEvent::TabWillClose { tab: tab(9) });
        });
        assert_eq!(
            block_on(events.next()),
            Some(EngineEvent::TabWillClose { tab: tab(9) })
        );
        thread.join().unwrap();
    }

    #[test]
    fn scroll_acks_coalesce_per_view_and_phase() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        let view = NativeViewHandle(8 as *mut _).token();
        bus.publish(EngineEvent::PageScroll {
            view,
            ack: PageScrollAck::Begin,
            consumed: true,
        });
        bus.publish(EngineEvent::PageScroll {
            view,
            ack: PageScrollAck::Update,
            consumed: true,
        });
        bus.publish(EngineEvent::PageScroll {
            view,
            ack: PageScrollAck::Update,
            consumed: false,
        });
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::PageScroll {
                    view,
                    ack: PageScrollAck::Begin,
                    consumed: true
                },
                EngineEvent::PageScroll {
                    view,
                    ack: PageScrollAck::Update,
                    consumed: false
                },
            ]
        );
    }

    #[test]
    fn events_report_their_tab_and_window() {
        let event = EngineEvent::TabInserted {
            window: window(2),
            tab: tab(3),
            opener: None,
            disposition: "foreground".into(),
        };
        assert_eq!(event.tab(), Some(tab(3)));
        assert_eq!(event.window(), Some(window(2)));
        assert_eq!(EngineEvent::Started.tab(), None);
    }

    #[test]
    fn wake_hooks_may_subscribe_and_publish_without_deadlocking() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        let inner = bus.clone();
        let extra = Arc::new(Mutex::new(Vec::new()));
        let keep = extra.clone();
        events.set_wake_hook(move || {
            keep.lock().push(inner.subscribe());
            inner.publish(EngineEvent::QuitCancelled);
        });
        bus.publish(EngineEvent::Started);
        assert_eq!(
            events.drain(),
            vec![EngineEvent::Started, EngineEvent::QuitCancelled]
        );
        assert_eq!(extra.lock().len(), 1);
    }

    #[test]
    fn subscribing_after_close_ends_at_once() {
        let bus = EventBus::new();
        bus.close();
        let mut late = bus.subscribe();
        bus.publish(EngineEvent::Started);
        assert_eq!(block_on(late.next()), None);
        assert_eq!(bus.subscriber_count(), 0);
        assert!(bus.is_closed());
    }

    #[test]
    fn a_finished_stream_never_receives_more() {
        let bus = EventBus::new();
        let mut events = bus.subscribe();
        let publisher = bus.clone();
        bus.close();
        publisher.publish(EngineEvent::QuitCancelled);
        assert_eq!(block_on(events.next()), None);
        assert_eq!(events.try_next(), None);
    }

    #[test]
    fn close_wakes_hooks_outside_the_registry_lock() {
        let bus = EventBus::new();
        let events = bus.subscribe();
        let inner = bus.clone();
        let late = Arc::new(Mutex::new(None));
        let keep = late.clone();
        events.set_wake_hook(move || {
            *keep.lock() = Some(inner.subscribe());
        });
        bus.close();
        assert!(
            late.lock()
                .as_ref()
                .is_some_and(EventSubscription::is_finished)
        );
    }

    #[test]
    fn dropped_subscriptions_unlink_immediately() {
        let bus = EventBus::new();
        let first = bus.subscribe();
        bus.publish(EngineEvent::Started);
        assert_eq!(bus.subscriber_count(), 1);
        drop(first);
        assert_eq!(bus.subscriber_count(), 0);
        assert!(!bus.has_subscribers());
    }

    #[test]
    fn a_stalled_subscriber_is_told_to_resync_instead_of_growing() {
        let bus = EventBus::with_capacity(4);
        let stalled = bus.subscribe();
        for n in 0..100u64 {
            bus.publish(EngineEvent::TabWillClose { tab: tab(n + 1) });
        }
        assert!(stalled.queue.state.lock().live <= 16);
        let drained = stalled.drain();
        assert!(matches!(
            drained[0],
            EngineEvent::EventsDropped { resync: true, .. }
        ));
        let EngineEvent::EventsDropped { count, .. } = drained[0] else {
            unreachable!()
        };
        assert_eq!(count as usize + drained.len() - 1, 100);
    }

    fn permission(tab_raw: u64, id: &str) -> EngineEvent {
        EngineEvent::PermissionRequested {
            tab: Some(tab(tab_raw)),
            request: PermissionRequest {
                id: id.into(),
                ..PermissionRequest::default()
            },
        }
    }

    #[test]
    fn prompts_dropped_by_an_overflow_stay_answerable() {
        let bus = EventBus::with_capacity(2);
        let stalled = bus.subscribe();
        bus.publish(EngineEvent::ConfirmCloseWithDownloads {
            window: window(1),
            count: 2,
            request: 7,
        });
        bus.publish(permission(3, "p1"));
        bus.publish(permission(4, "p2"));
        for n in 0..40u64 {
            bus.publish(EngineEvent::TabWillClose { tab: tab(100 + n) });
        }
        assert!(matches!(
            stalled.drain()[0],
            EngineEvent::EventsDropped { resync: true, .. }
        ));
        assert_eq!(
            bus.open_prompts(),
            vec![
                EngineEvent::ConfirmCloseWithDownloads {
                    window: window(1),
                    count: 2,
                    request: 7
                },
                permission(3, "p1"),
                permission(4, "p2"),
            ]
        );
        bus.publish(EngineEvent::PermissionDismissed {
            request_id: "p1".into(),
        });
        bus.publish(EngineEvent::TabWillClose { tab: tab(4) });
        assert_eq!(
            bus.settle_prompt(&PromptKey::CloseWithDownloads(7))
                .and_then(|event| event.window()),
            Some(window(1))
        );
        assert!(bus.open_prompts().is_empty());
        assert_eq!(bus.settle_prompt(&PromptKey::CloseWithDownloads(7)), None);
    }

    #[test]
    fn prompts_follow_their_window_and_their_open_flag() {
        let bus = EventBus::new();
        bus.publish(EngineEvent::ConfirmCloseWithDownloads {
            window: window(2),
            count: 1,
            request: 1,
        });
        bus.publish(EngineEvent::DeviceChooser {
            tab: Some(tab(1)),
            chooser: DeviceChooser {
                id: 5,
                open: true,
                ..DeviceChooser::default()
            },
        });
        bus.publish(EngineEvent::DeviceChooser {
            tab: Some(tab(1)),
            chooser: DeviceChooser {
                id: 5,
                open: true,
                options: vec![DeviceOption::default()],
                ..DeviceChooser::default()
            },
        });
        assert_eq!(bus.open_prompts().len(), 2);
        bus.publish(EngineEvent::WindowClosed { window: window(2) });
        bus.publish(EngineEvent::DeviceChooser {
            tab: Some(tab(1)),
            chooser: DeviceChooser {
                id: 5,
                open: false,
                ..DeviceChooser::default()
            },
        });
        assert!(bus.open_prompts().is_empty());
        bus.publish(permission(1, ""));
        assert!(bus.open_prompts().is_empty());
        bus.publish(EngineEvent::ConfirmCloseWithDownloads {
            window: window(3),
            count: 1,
            request: 99,
        });
        for n in 0..(OPEN_PROMPT_LIMIT as u64 + 5) {
            bus.publish(permission(n + 10, &format!("p{n}")));
        }
        let open = bus.open_prompts();
        assert_eq!(open.len(), OPEN_PROMPT_LIMIT);
        assert_eq!(
            open[0].prompt(),
            Some(PromptKey::CloseWithDownloads(99)),
            "a window waiting on its answer is never evicted"
        );
        assert_eq!(open[1].prompt(), Some(PromptKey::Permission("p6".into())));
        for n in 0..(OPEN_PROMPT_LIMIT as u64 + 3) {
            bus.publish(EngineEvent::ConfirmCloseWithDownloads {
                window: window(4),
                count: 1,
                request: 1000 + n,
            });
        }
        let open = bus.open_prompts();
        assert!(
            open.iter()
                .all(|event| matches!(event, EngineEvent::ConfirmCloseWithDownloads { .. }))
        );
        assert_eq!(open.len(), OPEN_PROMPT_LIMIT + 4);
        bus.close();
        assert!(bus.open_prompts().is_empty());
        bus.publish(permission(1, "late"));
        assert!(bus.open_prompts().is_empty());
    }

    #[test]
    fn every_subscriber_sees_events_in_the_order_the_ledger_did() {
        let bus = EventBus::new();
        let first = bus.subscribe();
        let second = bus.subscribe();
        let publisher = bus.clone();
        first.set_wake_hook(move || {
            if publisher
                .open_prompts()
                .iter()
                .any(|e| e.prompt() == Some(PromptKey::Permission("p".into())))
            {
                publisher.publish(EngineEvent::PermissionDismissed {
                    request_id: "p".into(),
                });
            }
        });
        bus.publish(permission(1, "p"));
        let order = |events: Vec<EngineEvent>| {
            events
                .iter()
                .map(|event| matches!(event, EngineEvent::PermissionRequested { .. }))
                .collect::<Vec<_>>()
        };
        assert_eq!(order(first.drain()), vec![true, false]);
        assert_eq!(order(second.drain()), vec![true, false]);
        assert!(bus.open_prompts().is_empty());
    }

    #[test]
    fn a_panicking_hook_cannot_stop_teardown() {
        let bus = EventBus::new();
        let first = bus.subscribe();
        let second = bus.subscribe();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        first.set_wake_hook(|| panic!("hook failure"));
        second.set_wake_hook(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        bus.publish(EngineEvent::Started);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        second.drain();
        first.drain();
        bus.close();
        assert!(first.is_finished());
        assert!(second.is_finished());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn heavy_publish_load_stays_bounded() {
        let bus = EventBus::with_capacity(64);
        let events = bus.subscribe();
        for n in 0..100_000u64 {
            bus.publish(EngineEvent::ProgressChanged {
                tab: tab(n % 16 + 1),
                progress: n as f64,
            });
        }
        assert!(events.queue.state.lock().slots.len() <= 16 * 2 + 33);
        let drained = events.drain();
        assert_eq!(drained.len(), 16);
        assert!(
            drained
                .iter()
                .all(|event| matches!(event, EngineEvent::ProgressChanged { .. }))
        );
        assert_eq!(
            drained.last(),
            Some(&EngineEvent::ProgressChanged {
                tab: tab(16),
                progress: 99_999.0
            })
        );
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UrlSender {
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
}
