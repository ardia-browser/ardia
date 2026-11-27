# Virtual lists and grids (GPUI)

Every list and grid in the GPUI app goes through one helper: `crate::primitives::virtual_list`
(`crates/ardia-ui/src/primitives/virtual_list.rs`). Don't use gpui's `uniform_list` or `ListState` directly.

## How it works

The helper renders inside a scroll container you already have (any `div` with `overflow_y_scroll()` and
`track_scroll(&handle)`), so it can sit next to other content (headers, pinned grids, footers) and can be
nested (a folder's rows inside the sidebar list). Each frame it:

1. stacks the items from their heights (points) into rows, or wraps them into grid rows;
2. reads the scroll offset and viewport from the `ScrollHandle`, and the list's own top inside the scroll
   content from the previous frame;
3. builds only the rows in view plus `overscan` (default 240 pt) above and below, plus any `keep` keys;
4. fills the skipped runs with plain spacers of the exact same height, so scroll extent, scroll bars and
   everything below the list stay where they were;
5. measures what it drew, by key, and redraws once more when a measured height or the list's top differs from
   what it assumed.

A list renders every row, exactly as before, when it has at most `SMALL_LIST_ROWS` (40) rows and its whole
content fits in the viewport plus the overscan on both sides. Otherwise (many rows, or a few very tall ones such
as open sidebar groups) it virtualizes, and the rendering cost per frame is the rows on screen, not the list
length.

## API

```rust
use crate::primitives::virtual_list::{virtual_list, VirtualItem, Columns, Align};

let handle = virtual_list::scroll_handle("history:main");
div()
    .id("history")
    .overflow_y_scroll()
    .track_scroll(&handle)
    .child(
        virtual_list("history:main", &handle)
            .items(rows.iter().map(|r| VirtualItem::new(r.id.clone(), ROW_HEIGHT)))
            .gap(2.0)
            .keep(selected.iter().cloned())
            .render_all(dragging)
            .scope(window_id.as_str())
            .empty(|| empty_state(c))
            .render(|ix, item| row(c, &rows[ix])),
    )
```

Builder (all optional except `items` and `render`):

| Call | Meaning |
| --- | --- |
| `virtual_list(key, &ScrollHandle)` | `key` names the list; its measured heights and positions are kept under it. |
| `.items(iter of VirtualItem)` | `VirtualItem::new(key, height)` for a row, `VirtualItem::header(key, height)` for a section header. Heights are in points; an estimate is fine, the helper measures and corrects. Keys must be unique in the list. |
| `.items_with(revision, count, Fn(index) -> VirtualItem)` | The fast form for long lists. While `revision` and `count` stay the same, the helper skips building items and reuses its cached layout, so a frame costs only the rows on screen. Bump `revision` whenever any key or height changes (for example the `Arc` pointer of the data the rows come from). |
| `.gap(pt)` | Vertical gap between rows (list mode). |
| `.grid(Columns, row_height, column_gap, row_gap)` | Grid mode. `Columns::Fixed(n)` or `Columns::Adaptive { min_width, width, gap }`. Headers span a full row and start a new grid row. The render closure returns one cell; the helper lays the cells of a row out side by side. |
| `.overscan(pt)` | Extra distance rendered above and below the viewport. |
| `.keep(keys)` | Always render these items even off screen: the selected row, the row being dragged, a row whose geometry another element reads. |
| `.render_all(bool)` | Render every row this frame, e.g. while a drag snapshot needs every row's frame. |
| `.small_list_rows(n)` | Lists with at most `n` rows render everything when their content also fits in the viewport plus overscan (default 40; `0` always virtualizes). |
| `.scope(str)` | Groups lists (e.g. by window) for `painted_all`. |
| `.empty(FnOnce() -> AnyElement)` | What to show when there are no items. |
| `.render(FnMut(index, &VirtualItem) -> AnyElement) -> AnyElement` | Builds the list. The closure is called only for rows that are drawn. It can borrow from the caller's render (`&Chrome` etc.). |

Free functions, all keyed by the list key:

| Function | Use |
| --- | --- |
| `scroll_handle(key) -> ScrollHandle` | A scroll handle remembered per key, so scroll position survives re-renders and closing and reopening a view. |
| `scroll_to(key, item_key, Align::{Nearest, Top, Center}) -> bool` | Scrolls the list's handle so the item shows; works for rows that aren't drawn. |
| `step(key, from: Option<&str>, delta) -> Option<SharedString>` | Keyboard selection: the item `delta` rows away, skipping headers and stopping at the ends. Pair with `scroll_to(.., Align::Nearest)` and `.keep([selected])`. |
| `item_top(key, item_key) -> Option<f32>` | The item's top inside the list, in points, drawn or not. |
| `moved(key, item_key) -> Option<f32>` | How far a drawn item moved since the previous frame (old top minus new top), for reorder and drag slide animations. |
| `visible_items(key) -> Vec<SharedString>` | The keys drawn in the last frame. |
| `painted_all(scope) -> bool` | Whether every list in the scope drew all its rows last frame (drag code waits for this before snapshotting row frames). |
| `forget(key)` | Drops a list's memory and scroll handle when its view closes for good. |
| `band(key, item_key) -> Option<(f32, f32)>` | The visible span plus overscan, in that item's own coordinates (0 is its top). `None` when the list drew every row. For an item that holds its own rows (an open group, a folder), so it can skip the ones outside the band. |
| `outside_band(band, top, height) -> bool` | Whether a child at `top`/`height` inside the item lies outside `band`. Replace such children with a spacer of the same height. |

## Rules for callers

- Give rows a fixed `flex_none` height equal to (or close to) the height you pass. Animated rows (folding,
  appearing) are fine: drawn rows lay out naturally and are measured.
- Anything that reads a row's on-screen geometry (selection pill, drop targets) must `keep` that row, or
  `render_all` while it needs every row.
- Per-row element reuse across frames isn't available in immediate mode without turning each row into a cached
  view; the helper bounds the work per frame to the rows on screen instead, and caches heights and positions
  by key.
- Precompute anything O(N) (sorting, grouping, lookups) once per state change, not per frame.
- Cost per frame: the helper caches its layout (row tops), a key→index map and the measured heights by position,
  and rebuilds them only when the items, the shape or a measured height change. With `.items(...)` it still
  compares the new items with the cached ones (cheap, but O(N)); with `.items_with(revision, ..)` an unchanged
  revision costs nothing. `keep`, `scroll_to`, `step`, `item_top` and `band` use the index map, not scans.
- `cargo test -p ardia-ui --lib ten_thousand -- --ignored --nocapture` prints the frame cost of a 10,000-row list
  against a 30-row one, for both forms.

## Checks

`scripts/check-fast.sh` flags any `uniform_list(` or `ListState::new(` outside this helper (`list-outside-virtual-list`), with the other GPUI pattern rules, clippy and rustfmt; see [GPUI fast checks](gpui-checks.md).
