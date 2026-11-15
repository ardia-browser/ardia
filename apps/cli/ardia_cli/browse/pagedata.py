import json

from ardia_cli.browse.errors import BrowseError, Usage

SCRIPTS = """() => {
  const out = [];
  let total = 0;
  for (const script of document.querySelectorAll("script:not([src])")) {
    const text = script.textContent || "";
    if (!text.trim() || text.length > 8000000 || total + text.length > 24000000) continue;
    const type = (script.getAttribute("type") || "").toLowerCase();
    if (type && !type.includes("json") && !["text/javascript", "application/javascript", "module"].includes(type)) continue;
    if (!type.includes("json") && !/^\\s*(?:window\\.|self\\.|globalThis\\.|var |let |const )?[\\w$.\\[\\]"']+\\s*=\\s*[\\[{]/.test(text.slice(0, 400))) continue;
    total += text.length;
    out.push({ id: script.id || "", type, text });
  }
  return out;
}"""
KEY_PREVIEW = 12
FIELD_PREVIEW = 8


def blocks_of(scripts: list[dict]) -> list[dict]:
    from ardia_cli.browse import flowlog

    found = []
    for script in scripts or []:
        attrs = (f' id="{script["id"]}"' if script.get("id") else "") + (f' type="{script["type"]}"' if script.get("type") else "")
        for _, value, size in flowlog.embedded_json(f"<script{attrs}>{script['text']}</script>"):
            kind = "ld+json" if "ld+json" in script.get("type", "") else ("json" if "json" in script.get("type", "") else "assigned")
            found.append({"id": script.get("id") or None, "kind": kind, "size": size, "value": value})
    for number, block in enumerate(found, 1):
        block["block"] = number
    return found


def summary(block: dict) -> str:
    from ardia_cli.browse import shape

    value = block["value"]
    name = f"#{block['id']}" if block["id"] else block["kind"]
    head = f"[{block['block']}] {name} ({block['kind']}, {block['size']:,} chars)"
    if isinstance(value, dict):
        keys = list(value)
        head += ": keys " + ", ".join(map(str, keys[:KEY_PREVIEW])) + (" …" if len(keys) > KEY_PREVIEW else "")
    elif isinstance(value, list):
        head += f": a list of {len(value)}"
    found = shape.main_list(value)
    if found and found[1]:
        path, items = found
        fields = shape.item_fields(items)
        head += (f"\n    main list {path or '(the block itself)'}: {len(items)} items with "
                 + ", ".join(fields[:FIELD_PREVIEW]) + (" …" if len(fields) > FIELD_PREVIEW else ""))
    return head


def pick_block(blocks: list[dict], wanted: str | None) -> dict:
    if wanted is None:
        return max(blocks, key=lambda block: block["size"])
    for block in blocks:
        if str(block["block"]) == wanted or (block["id"] and block["id"] == wanted.lstrip("#")):
            return block
    raise Usage(f"--block takes a block number (1–{len(blocks)}) or a script id from `read --data`, not {wanted!r}")


async def run(ctx, page, frame, options: dict):
    from ardia_cli import command_metrics
    from ardia_cli.browse import shape
    from ardia_cli.browse.commands import Result, render_json

    scripts = await page.call(SCRIPTS, frame=frame, read=True)
    blocks = blocks_of(scripts)
    command_metrics.flag("read_data", True)
    command_metrics.count("read_data_blocks", len(blocks))
    if not blocks:
        raise BrowseError("This page embeds no JSON data (no __NEXT_DATA__, JSON-LD, application/json script or window state); "
                          "read its text with `read` instead", code="no_data")
    wanted = options.get("block")
    plan = shape.parse_shape(options.get("fields"), options.get("where"), options.get("limit"))
    if plan.empty and wanted is None:
        listing = [{key: block[key] for key in ("block", "id", "kind", "size")} for block in blocks]
        text = f"{len(blocks)} data block{'s' if len(blocks) != 1 else ''} on this page (pick one with --block N; shape it with --fields a,b.c --where f=v --limit n):\n"
        return Result({"blocks": listing, "url": page.url}, text + "\n".join(summary(block) for block in blocks), page_content=True)
    block = pick_block(blocks, wanted)
    shaped = shape.apply(block["value"], plan) if not plan.empty else block["value"]
    if not plan.empty:
        command_metrics.flag("read_data_shaped", True)
    return Result({"block": block["block"], "id": block["id"], "kind": block["kind"], "url": page.url, "data": shaped},
                  render_json(shaped), page_content=True)
