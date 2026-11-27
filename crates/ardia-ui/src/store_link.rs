use ardia_state::{BrowserStore, Interest, Subscription, Topics};
use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui::{Context, Task, Window};

pub struct StoreLink {
    _subscription: Subscription,
    _task: Task<()>,
}

impl StoreLink {
    pub fn new<V: 'static>(
        store: &BrowserStore,
        interest: Interest,
        window: &Window,
        cx: &mut Context<V>,
        on_change: fn(&mut V, Topics, &mut Window, &mut Context<V>),
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded::<Topics>();
        let first = sender.clone();
        let subscription = store.subscribe(interest, move |update| {
            let _ = sender.unbounded_send(update.changes.topics);
        });
        let _ = first.unbounded_send(Topics::ALL);
        let task = cx.spawn_in(window, async move |view, cx| {
            while let Some(mut topics) = receiver.next().await {
                while let Ok(more) = receiver.try_recv() {
                    topics = topics | more;
                }
                if view
                    .update_in(cx, |view, window, cx| on_change(view, topics, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        StoreLink {
            _subscription: subscription,
            _task: task,
        }
    }
}
