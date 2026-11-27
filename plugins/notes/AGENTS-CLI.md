# Notes from the command line (for agents)

Every part of Notes is a tool: `ardia plugins call notes <tool> '<json>'`. The JSON is `{"action": "...", ...fields}`.
Start with `describe` (or `describe {"topic": "rows"}`): it lists every action, field, enum and default as data.
Errors name the field and the nearest valid value; read them and retry.

## Read

```sh
ardia plugins call notes pages '{"action":"tree"}'
ardia plugins call notes search '{"query":"roadmap"}'
ardia plugins call notes content '{"action":"get","page":"Getting Started","ids":true}'   # Markdown with {#blockId}
ardia plugins call notes content '{"action":"get","page":"<id>","format":"blocks"}'      # BlockNote JSON
```

A page is named by id, `ardia://notes/…` address, or exact title.

## Write page content

- Whole page: `content set {page, markdown}`. It merges: blocks you didn't change (matched by `{#id}` or by text)
  keep their ids, comments and other people's edits. `mode: "replace"` rewrites everything.
- Surgical: `content patch {page, ops: [...]}`. Ops: `insert` (after/before/parent), `update` (type, props, markdown
  or content), `delete`, `move`, `replace`, `replace_text` (find/replace keeping formatting), `children`. All ops are
  checked before any applies.
- Append: `content append {page, markdown}`.

Edits show live in open pages. Markdown: GFM, plus `<details><summary>…` toggles (`## …` in the summary for a toggle
heading), `> [!💡] text` callouts, `::page[Title](id)`, `::database[Title](id)`, `::bookmark(url)`, `:::columns`,
`@page(id)`, `@user(Name)`, `@date(YYYY-MM-DD)`, `<span color="red">`, and `{#id textColor=red}` at the end of a
block's first line. `describe {"topic":"markdown"}` has the full list. Blocks JSON keeps everything (table cell
colours too).

## Databases

```sh
ardia plugins call notes database '{"action":"create","title":"Roadmap","properties":[{"name":"Status","type":"status"},{"name":"Points","type":"number"}]}'
ardia plugins call notes rows '{"action":"create","database":"Roadmap","rows":[{"title":"Sync v2","properties":{"Status":"In progress","Points":8}}]}'
ardia plugins call notes rows '{"action":"query","database":"Roadmap","filter":[{"prop":"Points","cond":"gte","value":5}],"sorts":[{"prop":"Points","dir":"desc"}]}'
ardia plugins call notes views '{"action":"add","database":"Roadmap","type":"board","groupBy":{"prop":"Status"}}'
```

Properties and options are named by name. Values: select/status by option name (new select options are made),
dates `YYYY-MM-DD` or `{start,end}`, people by name or `"me"`, relations by row title or id, `null` clears.
Formulas use `prop("Name")`. A row's body is page content: `content get {page: <row id>}`.

## Everything else

`pages` (create/update/move/duplicate/archive/open), `comments`, `history`, `templates`, `trash`, `files` (base64
upload, `file:<sha256>` refs), `export` (Markdown or HTML), `import` (`markdown`, or `start` an app export through
Ardia's picker), `workspaces`, `me`.

Deleting for good needs the page in the trash or `permanent: true`; `trash empty` and `workspaces leave` need
`confirm: true`. Locked pages refuse content edits unless `force: true`.
