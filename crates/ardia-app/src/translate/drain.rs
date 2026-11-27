use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::rc::Rc;

use futures::StreamExt as _;
use futures::future::LocalBoxFuture;
use futures::stream::FuturesUnordered;
use serde_json::{Value, json};

pub const PACK_CHARS: usize = 600;
pub const FIRST_PACK_CHARS: usize = 60;
pub const PACK_PASSAGES: usize = 24;
pub const FAILED_PACKS_IN_A_ROW: u32 = 3;
pub const LONG_PASSAGE: usize = 200;
pub const PASSAGE_RETRIES: u32 = 2;
pub const PACK_SEPARATOR: &str = " · ";
pub const IN_FLIGHT: usize = 2;
const MAX_PIECES: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub struct Passage {
    pub id: i64,
    pub pieces: Vec<(i64, String)>,
    pub attempt: u32,
}

pub type Translated = (i64, Option<String>);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageBatch {
    pub passages: Vec<Passage>,
    pub more: bool,
    pub gone: bool,
    pub done: usize,
    pub total: usize,
}

impl PageBatch {
    pub fn parse(value: &Value) -> Option<PageBatch> {
        let object = value.as_object()?;
        let passages = object.get("passages")?.as_array()?;
        Some(PageBatch {
            passages: clean_passages(passages),
            more: object.get("more").and_then(Value::as_bool).unwrap_or(false),
            gone: object.get("gone").and_then(Value::as_bool).unwrap_or(false),
            done: object.get("done").and_then(Value::as_u64).unwrap_or(0) as usize,
            total: object.get("total").and_then(Value::as_u64).unwrap_or(0) as usize,
        })
    }
}

pub fn clean_passages(passages: &[Value]) -> Vec<Passage> {
    passages
        .iter()
        .filter_map(|passage| {
            let list = passage.as_array()?;
            let id = list.first()?.as_f64()? as i64;
            let pieces: Vec<(i64, String)> = list
                .get(1)?
                .as_array()?
                .iter()
                .filter_map(|piece| {
                    let piece = piece.as_array()?;
                    Some((
                        piece.first()?.as_f64()? as i64,
                        piece.get(1)?.as_str()?.to_owned(),
                    ))
                })
                .take(MAX_PIECES)
                .collect();
            let attempt = list.get(2).and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as u32;
            (!pieces.is_empty()).then_some(Passage {
                id,
                pieces,
                attempt,
            })
        })
        .collect()
}

pub fn results_json(results: &[Translated]) -> Value {
    Value::Array(results.iter().map(|(id, text)| json!([id, text])).collect())
}

fn size_of(passage: &Passage) -> usize {
    passage
        .pieces
        .iter()
        .map(|(_, text)| text.chars().count())
        .sum()
}

pub fn packs_of(passages: Vec<Passage>) -> Vec<Vec<Passage>> {
    let mut packs = Vec::new();
    let mut short: Vec<Passage> = Vec::new();
    let mut short_chars = 0;
    let separator = PACK_SEPARATOR.chars().count();
    for passage in passages {
        let size = size_of(&passage);
        if size < LONG_PASSAGE {
            let added = if short.is_empty() {
                size
            } else {
                size + separator
            };
            if !short.is_empty() && short_chars + added > PACK_CHARS {
                packs.push(std::mem::take(&mut short));
                short.push(passage);
                short_chars = size;
                continue;
            }
            short.push(passage);
            short_chars += added;
            continue;
        }
        if !short.is_empty() {
            packs.push(std::mem::take(&mut short));
        }
        short_chars = 0;
        packs.push(vec![passage]);
    }
    if !short.is_empty() {
        packs.push(short);
    }
    packs
}

fn untranslated(passage: &Passage) -> Vec<Translated> {
    passage.pieces.iter().map(|(id, _)| (*id, None)).collect()
}

fn translated_in(pack: &[Passage], results: &[Translated]) -> usize {
    let answered: HashSet<i64> = results
        .iter()
        .filter(|(_, text)| text.is_some())
        .map(|(id, _)| *id)
        .collect();
    pack.iter()
        .filter(|passage| passage.pieces.iter().any(|(id, _)| answered.contains(id)))
        .count()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainStage {
    Collect,
    Model,
    Apply,
}

pub trait DrainPort {
    fn holds(&self) -> bool;
    fn next(&self, max_chars: usize) -> LocalBoxFuture<'static, Option<PageBatch>>;
    fn translate(
        &self,
        pack: Vec<Passage>,
    ) -> LocalBoxFuture<'static, Result<Vec<Translated>, String>>;
    fn apply(&self, results: Vec<Translated>) -> LocalBoxFuture<'static, Result<(), String>>;
    fn on_stage(&self, _stage: DrainStage) {}
    fn on_applied(&self, _passages: usize, _total: usize) {}
    fn on_abandoned(&self, _passages: usize) {}
    fn on_outage(&self) {}
}

#[derive(Default)]
struct Shared {
    failure: Option<String>,
    last_error: Option<String>,
    failed_in_a_row: u32,
    pending_retries: usize,
    succeeded: usize,
    total: usize,
}

impl Shared {
    fn settle_retries(&mut self, pack: &[Passage], answered: impl Fn(&Passage) -> bool) {
        for passage in pack {
            if passage.attempt > 0 {
                self.pending_retries = self.pending_retries.saturating_sub(1);
            }
            if !answered(passage) && passage.attempt < PASSAGE_RETRIES {
                self.pending_retries += 1;
            }
        }
    }
}

async fn run_pack<P: DrainPort>(port: Rc<P>, shared: Rc<RefCell<Shared>>, pack: Vec<Passage>) {
    match port.translate(pack.clone()).await {
        Ok(results) => {
            if !port.holds() {
                return;
            }
            let translated = translated_in(&pack, &results);
            let answered: HashSet<i64> = results
                .iter()
                .filter(|(_, text)| text.is_some())
                .map(|(id, _)| *id)
                .collect();
            let total = {
                let mut shared = shared.borrow_mut();
                shared.settle_retries(&pack, |passage| {
                    passage.pieces.iter().all(|(id, _)| answered.contains(id))
                });
                if translated > 0 && shared.failure.is_none() {
                    shared.failed_in_a_row = 0;
                }
                if translated > 0 {
                    shared.succeeded += 1;
                }
                if shared.failure.is_none() {
                    port.on_stage(DrainStage::Apply);
                }
                shared.total
            };
            match port.apply(results).await {
                Ok(()) => {
                    if port.holds() {
                        port.on_applied(translated, total);
                    }
                }
                Err(error) => {
                    let mut shared = shared.borrow_mut();
                    if port.holds() && shared.failure.is_none() {
                        shared.failure = Some(error);
                        drop(shared);
                        port.on_outage();
                    }
                }
            }
        }
        Err(error) => {
            if !port.holds() {
                return;
            }
            let outage = {
                let mut shared = shared.borrow_mut();
                shared.last_error = Some(error.clone());
                shared.settle_retries(&pack, |_| false);
                let fresh = pack.iter().any(|passage| passage.attempt == 0);
                if fresh {
                    shared.failed_in_a_row += 1;
                }
                if fresh
                    && shared.failed_in_a_row >= FAILED_PACKS_IN_A_ROW
                    && shared.failure.is_none()
                {
                    shared.failure = Some(error);
                    true
                } else {
                    false
                }
            };
            if outage {
                port.on_stage(DrainStage::Model);
                port.on_outage();
            }
            let _ = port
                .apply(pack.iter().flat_map(untranslated).collect())
                .await;
        }
    }
}

pub async fn drain_passages<P: DrainPort + 'static>(port: Rc<P>) -> Result<bool, String> {
    let shared = Rc::new(RefCell::new(Shared::default()));
    let mut running: FuturesUnordered<LocalBoxFuture<'static, ()>> = FuturesUnordered::new();
    let mut backlog: VecDeque<Vec<Passage>> = VecDeque::new();
    let mut exhausted = false;
    let mut asked = false;
    let stage = |name: DrainStage| {
        if shared.borrow().failure.is_none() {
            port.on_stage(name);
        }
    };
    loop {
        if !port.holds() {
            return Ok(false);
        }
        if shared.borrow().failure.is_some() {
            break;
        }
        while running.len() < IN_FLIGHT {
            let Some(pack) = backlog.pop_front() else {
                break;
            };
            running.push(Box::pin(run_pack(
                Rc::clone(&port),
                Rc::clone(&shared),
                pack,
            )));
        }
        if running.len() < IN_FLIGHT && !exhausted {
            stage(DrainStage::Collect);
            let batch = port
                .next(if asked { PACK_CHARS } else { FIRST_PACK_CHARS })
                .await;
            asked = true;
            if !port.holds() {
                return Ok(false);
            }
            let Some(batch) = batch.filter(|batch| !batch.gone) else {
                return Ok(false);
            };
            shared.borrow_mut().total = batch.total;
            exhausted = !batch.more;
            backlog.extend(packs_of(batch.passages));
            if !backlog.is_empty() {
                stage(DrainStage::Model);
                continue;
            }
        }
        if running.is_empty() && backlog.is_empty() {
            break;
        }
        running.next().await;
        exhausted = false;
    }
    while running.next().await.is_some() {}
    if !port.holds() {
        return Ok(false);
    }
    let shared = shared.borrow();
    if let Some(failure) = shared.failure.clone() {
        port.on_abandoned(shared.pending_retries);
        return Err(failure);
    }
    if shared.succeeded == 0
        && let Some(error) = shared.last_error.clone()
    {
        return Err(error);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn passage(id: i64, text: &str) -> Passage {
        Passage {
            id,
            pieces: vec![(id * 10, text.to_owned())],
            attempt: 0,
        }
    }

    #[test]
    fn short_passages_share_packs_and_long_ones_stand_alone() {
        let long = "x".repeat(LONG_PASSAGE);
        let packs = packs_of(vec![
            passage(1, "a"),
            passage(2, "b"),
            passage(3, &long),
            passage(4, "c"),
        ]);
        assert_eq!(packs.len(), 3);
        assert_eq!(packs[0].len(), 2);
        assert_eq!(packs[1][0].id, 3);
        let many: Vec<Passage> = (0..10).map(|i| passage(i, &"y".repeat(150))).collect();
        let packs = packs_of(many);
        assert!(packs.iter().all(|pack| {
            pack.iter().map(size_of).sum::<usize>() + (pack.len() - 1) * 3 <= PACK_CHARS
        }));
    }

    #[test]
    fn page_batches_drop_malformed_passages() {
        let batch = PageBatch::parse(&json!({
            "passages": [[1, [[2, "hi"], ["x", 3]], 1], [4, []], "nope"],
            "more": true, "gone": false, "done": 1, "total": 3
        }))
        .expect("a batch");
        assert_eq!(batch.passages.len(), 1);
        assert_eq!(batch.passages[0].pieces, vec![(2, "hi".to_owned())]);
        assert_eq!(batch.passages[0].attempt, 1);
        assert!(batch.more);
        assert_eq!(batch.total, 3);
    }

    struct FakePage {
        batches: RefCell<VecDeque<PageBatch>>,
        applied: RefCell<Vec<Translated>>,
        fail: bool,
        holding: Cell<bool>,
    }

    impl DrainPort for FakePage {
        fn holds(&self) -> bool {
            self.holding.get()
        }

        fn next(&self, _max: usize) -> LocalBoxFuture<'static, Option<PageBatch>> {
            let batch = self.batches.borrow_mut().pop_front().unwrap_or(PageBatch {
                more: false,
                ..PageBatch::default()
            });
            Box::pin(async move { Some(batch) })
        }

        fn translate(
            &self,
            pack: Vec<Passage>,
        ) -> LocalBoxFuture<'static, Result<Vec<Translated>, String>> {
            let fail = self.fail;
            Box::pin(async move {
                if fail {
                    return Err("model down".to_owned());
                }
                Ok(pack
                    .iter()
                    .flat_map(|p| p.pieces.iter().map(|(id, t)| (*id, Some(t.to_uppercase()))))
                    .collect())
            })
        }

        fn apply(&self, results: Vec<Translated>) -> LocalBoxFuture<'static, Result<(), String>> {
            self.applied.borrow_mut().extend(results);
            Box::pin(async { Ok(()) })
        }
    }

    fn page(fail: bool) -> Rc<FakePage> {
        Rc::new(FakePage {
            batches: RefCell::new(VecDeque::from(vec![
                PageBatch {
                    passages: vec![passage(1, "one"), passage(2, "two")],
                    more: true,
                    total: 4,
                    ..PageBatch::default()
                },
                PageBatch {
                    passages: vec![passage(3, "three"), passage(4, "four")],
                    more: false,
                    total: 4,
                    ..PageBatch::default()
                },
            ])),
            applied: RefCell::new(Vec::new()),
            fail,
            holding: Cell::new(true),
        })
    }

    #[test]
    fn drains_every_batch_and_applies_translations() {
        let page = page(false);
        let done = futures::executor::block_on(drain_passages(Rc::clone(&page)));
        assert_eq!(done, Ok(true));
        let applied = page.applied.borrow();
        assert_eq!(applied.len(), 4);
        assert!(applied.contains(&(30, Some("THREE".to_owned()))));
    }

    #[test]
    fn a_dead_model_fails_after_its_packs_and_restores_nothing() {
        let page = page(true);
        let done = futures::executor::block_on(drain_passages(Rc::clone(&page)));
        assert_eq!(done, Err("model down".to_owned()));
        assert!(page.applied.borrow().iter().all(|(_, text)| text.is_none()));
    }

    #[test]
    fn a_released_page_stops_quietly() {
        let page = page(false);
        page.holding.set(false);
        assert_eq!(
            futures::executor::block_on(drain_passages(Rc::clone(&page))),
            Ok(false)
        );
    }
}
