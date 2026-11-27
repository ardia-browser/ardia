# GPUI fast checks

Three layers find slow or broken GPUI code without running the app or the test suites. `scripts/check-fast.sh` runs
the first two in about a minute on a warm target dir; the third runs inside debug builds.

```sh
scripts/check-fast.sh              # pattern rules, render reach, clippy, rustfmt on files changed since the last run
scripts/check-fast.sh --no-clippy  # the pattern layers only (a few seconds)
scripts/check-fast.sh --all-files  # rustfmt every .rs file under crates/, not only changed ones
scripts/lint-patterns.sh --test    # the ast-grep rules alone, after their own snippet tests
node scripts/lint-render-reach.mjs --depth 6
```

The final merge check runs `scripts/check-fast.sh` before the tests.

## Setup

ast-grep is the only extra tool: `brew install ast-grep` (or `cargo install ast-grep --locked`). The scripts also use
`node` (any recent version) and the pinned Rust toolchain's `clippy` and `rustfmt`.

## 1. Pattern rules (ast-grep)

`sgconfig.yml` at the repo root points at `tools/lint-rules/`: `rules/` (one rule per file), `utils/` (shared matchers
such as "inside a render body" or "inside a listener closure") and `tests/` (valid and invalid snippets for every rule;
`ast-grep test --skip-snapshot-tests` runs them). Rules scan `crates/` and ignore `third_party/`, tests and build
scripts unless noted. Errors fail the check; warnings are printed.

| Rule | Level | Catches |
|------|-------|---------|
| `squared-alpha` | error | `c.opacity(c.a * k)` and friends: `opacity` already multiplies the colour's alpha |
| `list-outside-virtual-list` | error | `uniform_list(` or `ListState::new(` outside `primitives/virtual_list.rs` |
| `blocking-in-render` | error | file, socket, keychain, channel waits, `block_on`, sleeps in `render`, `render_root` or window-open paths |
| `full-cover-listener` | error | `absolute().inset_0()` layers with pointer listeners and no active-drag guard (the page-click regression) |
| `sleep-on-main-thread` | error | `thread::sleep` in render code or in functions that take `&mut App`, `&mut Window` or `&mut Context` |
| `debug-print` | error | `println!`, `eprintln!`, `dbg!` in app code (command-line mains are listed in the rule) |
| `no-comments` | error | comments in Rust code (AGENTS.md); attributes, `SAFETY:` notes and licence headers stay |
| `clone-in-render` | warning | cloning a whole entity state or a collection field inside a render body |
| `collect-then-iterate` | warning | `.collect::<Vec<_>>()` followed by `.iter()`, `.into_iter()`, `.len()` or `.is_empty()` |
| `flex-text-without-min-width` | warning | `.flex_1()` text columns without `.min_w_0()` (the consent card and settings overlaps) |
| `unwrap-on-io` | warning | `unwrap`/`expect` on file, IPC or parse results in app code |

Rules from the GPUI skills (`~/.claude/skills/gpui-*`), each tagged with its source in its message and `metadata`:

| Rule | Level | Skill guideline |
|------|-------|-----------------|
| `nested-entity-update` | error | troubleshooting, fundamentals: updating an entity inside its own update panics |
| `dropped-task` | error | code-quality, async: `let _ = cx.spawn(..)` cancels the task at once |
| `dropped-subscription` | error | troubleshooting, entities: `let _ = cx.subscribe(..)` drops the subscription |
| `weak-upgrade-unwrap` | error | troubleshooting, entities: `weak.upgrade().unwrap()` |
| `unwrap-entity-in-async` | error | async: unwrapping `this.update(..)` in a task whose entity may be gone |
| `blocking-in-foreground-task` | error | async: blocking work in `cx.spawn` instead of `background_spawn` |
| `smol-timer` | error | testing, code-quality: smol timers instead of gpui's executor timers |
| `plain-test-with-gpui-context` | error | testing: a `#[test]` taking `TestAppContext` instead of `#[gpui::test]` |
| `missing-notify` | warning | entities, actions, async: an update closure writes fields and never calls `notify()` or `emit()` |
| `consecutive-entity-updates` | warning | fundamentals: two updates of the same entity in a row |
| `mutate-in-render` | warning | code-quality, elements: `render()` writing view state |
| `rc-refcell-view-state` | warning | entities: `Rc<RefCell<..>>` view state instead of an entity |
| `string-churn-in-render` | warning | elements, code-quality: `.child(x.to_string())` in render instead of `SharedString` |

Skill guidelines left out, because they conflict with our rules or can't be checked from syntax: avoiding `mod.rs`
files (our crates use them), "comment only the why" (no comments at all here), the spacing scale `p_1()`/`p_2()` (Dia's
measured pixel values win), doc comments on actions (no comments), `let _ =` on every fallible call (we discard
channel-send results on purpose), `WeakEntity` for back-references and safe indexing (need types; clippy's
`indexing_slicing` is far too noisy here), focus tracking for key handlers (a focused child satisfies it, which syntax
can't see), `use gpui::*`, `.when()` over `if`, and the `-q`/`./script/clippy` build habits.

Exceptions: a finding a rule can't tell from a real one goes into that rule's `ignores` with the reason in its `note`.
`tools/lint-rules/pending.txt` lists findings in code another change is replacing (`<rule> <path> <reason>`); they print
as `pending` and don't fail.

### Render reach

`scripts/lint-render-reach.mjs` follows same-crate calls (`f()`, `self.f()`, `Self::f()`, `crate::..::f()`) from every
`render`, `render_root` and `open_*window*` function, four levels deep by default, skipping listener closures and
spawned tasks, and fails when a blocking call is reachable. It parses the tree once (`tools/lint-rules/reach-sgconfig.yml`
runs its three rules in one ast-grep pass). It is a name-based approximation of a call graph: a name
with more than four definitions in the crate isn't followed, and trait dispatch isn't seen. Accepted findings go into
`tools/lint-rules/reach-allow.txt` as `<file>::<function> <reason>`. dylint was weighed for a MIR call-graph lint and
not used: it needs a nightly toolchain next to the pinned 1.100, rebuilds the workspace under that toolchain on every
run (minutes, not seconds) and tracks rustc internals that change every six weeks.

## 2. Clippy

`[workspace.lints]` in `Cargo.toml` denies clippy's `perf` group plus `redundant_clone`, `needless_collect`,
`large_enum_variant`, `inefficient_to_string`, `unnecessary_to_owned`, `manual_memcpy`, `large_stack_arrays` and
`let_underscore_future`, and warns on `trivially_copy_pass_by_ref`. Every crate under `crates/` opts in with
`[lints] workspace = true`; `third_party/gpui` stays on its own settings. Where a lint can't be met (a borrow that needs
the collect, a serde or validator signature that takes `&T`) the code carries `#[expect(lint, reason = "..")]`.
The formatting step remembers its last run in `$CARGO_TARGET_DIR/check-fast/` (default `target/check-fast/`): it
checks only files changed since then plus the files that failed last time; `--all-files` checks everything.

`check-fast.sh` runs clippy with `-D warnings` on every crate that builds on macOS; the Linux-only plugin crates
(`ardia-plugin-jail`, `ardia-plugin-integration`, `ardia-plugin-host`) and `ardia-update-verify` need their own hosts.

## 3. Strict mode (debug builds)

See [Strict mode](perf/README.md#gpui-strict-mode-debug-builds) in the perf guide: main-thread blocking, frames over
8 ms and allocation-heavy frames, logged once per call site and listed under `strict` in the socket's `profile` reply.
