import asyncio
import base64
import collections
import json
import re
from urllib.parse import parse_qsl, unquote, urlsplit

from ardia_cli.browse.errors import BrowseError, ConnectionLost, Usage

STEP_LIMIT = 200
BODY_BUDGET = 16 * 1024 * 1024
BODY_LIMIT = 2 * 1024 * 1024
BODIES_PER_STEP = 8
CAPTURE_BUDGET = 2.0
PROBE_BUDGET = 1.5
POST_LIMIT = 64 * 1024
READ_METHODS = {"GET", "HEAD"}
GRAPHQL_KEYS = {"query", "variables", "operationName", "extensions"}
CAPTURED_TYPES = {"XHR", "Fetch", "Document"}
RECORDED = {"open", "click", "dblclick", "fill", "type", "press", "keyboard", "select", "check", "uncheck", "find", "back", "forward",
            "reload", "scroll", "scrollintoview", "hover", "focus", "wait", "pushstate"}
ON_ELEMENT = {"click", "dblclick", "fill", "type", "select", "check", "uncheck", "hover", "focus", "scrollintoview"}
TYPING = {"fill", "type"}
KEPT_HEADERS = ("content-type", "accept", "x-requested-with")
CREDENTIAL_HEADER = re.compile(r"^(authorization|proxy-authorization|cookie)$|token|csrf|xsrf|api-?key|secret|session|signature|^x-auth", re.I)
SUSPECT_WORDS = {"logout", "signout", "unsubscribe", "delete", "remove", "destroy"}
GRAPHQL_WRITES = {"mutation", "subscription"}
NO_HUMANIZE = {"--no-humanize": "bool"}
COMMAND_FLAGS = {
    "open": {"--enable": "multi", "--init-script": "multi", "--capture-console": "bool", "--headers": "value", "--label": "value", "--show": "bool"},
    "click": {"--new-tab": "bool", "--button": "value", "--no-humanize": "bool"},
    "type": {"--no-humanize": "bool", "--delay": "value"},
    "find": {"--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool"},
}
SCRIPT = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
ATTRIBUTE = re.compile(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)""")
ASSIGNED = re.compile(r"^\s*(?:(?:window|self|globalThis)\.|var\s+|let\s+|const\s+)?([A-Za-z_$][\w$.]*(?:\[\s*['\"][^'\"]+['\"]\s*\])*)\s*=\s*(.+?)\s*;?\s*$", re.S)
FIELD = r"""(el) => {
  el = el || document.activeElement;
  if (!el || el === document.body || el === document.documentElement || !el.getAttribute) return null;
  const attr = (name) => el.getAttribute(name) || "";
  const type = attr("type").toLowerCase(), auto = attr("autocomplete").toLowerCase();
  const label = (el.labels && el.labels[0] && el.labels[0].textContent || "").trim();
  const words = [attr("name"), el.id || "", attr("aria-label"), attr("placeholder"), label].join(" ").toLowerCase();
  const secret = type === "password" || /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/.test(auto)
    || /pass|secret|token|otp|\bpin\b|cvv|cvc|card/.test(words);
  return { secret, field: attr("name") || el.id || attr("aria-label") || attr("placeholder") || label };
}"""


class Log:
    def __init__(self):
        self.steps: collections.deque = collections.deque()
        self.seq = 0
        self.saved_through = 0
        self.body_bytes = 0
        self.dropped = 0

    def add(self, step: dict):
        self.seq += 1
        step["seq"] = self.seq
        for index, request in enumerate(step.get("requests") or [], 1):
            request["id"] = f"s{self.seq}r{index}"
            self.body_bytes += request.get("bytes") or 0
        self.steps.append(step)
        while len(self.steps) > STEP_LIMIT:
            self.forget(self.steps.popleft())
            self.dropped += 1
        for older in self.steps:
            if self.body_bytes <= BODY_BUDGET:
                break
            self.forget(older, keep_step=True)

    def forget(self, step: dict, keep_step: bool = False):
        for request in step.get("requests") or []:
            if request.get("text") is not None:
                self.body_bytes -= request.get("bytes") or 0
                request["text"] = None
                request.pop("value", None)
                request["evicted"] = keep_step

    def find(self, seq: int) -> dict | None:
        return next((step for step in self.steps if step["seq"] == seq), None)


def log_of(state) -> Log:
    extras = state.extras
    log = extras.get("flow_log")
    if log is None:
        log = extras["flow_log"] = Log()
    return log


def base_domain(host: str) -> str:
    host = (host or "").lower().rstrip(".").strip("[]")
    if not host or ":" in host or re.fullmatch(r"[\d.]+", host) or "." not in host:
        return host
    labels = host.split(".")
    for suffix in SHARED_SUFFIXES:
        if host.endswith("." + suffix):
            return ".".join(labels[-(suffix.count(".") + 2):])
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


SECOND_LEVEL = {"co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "nhs", "sch"}
SHARED_SUFFIXES = ("github.io", "githubusercontent.com", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app",
                   "firebaseapp.com", "appspot.com", "herokuapp.com", "fly.dev", "onrender.com", "glitch.me", "blogspot.com",
                   "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com", "amplifyapp.com", "repl.co", "ngrok.io", "ngrok-free.app",
                   "trycloudflare.com", "wordpress.com", "tumblr.com", "substack.com", "myshopify.com", "lovable.app", "deno.dev")


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def first_party(url: str, bases: set) -> bool:
    host = host_of(url)
    return bool(host) and base_domain(host) in bases


def kept_headers(headers: dict | None) -> tuple[dict, bool]:
    kept, stripped = {}, False
    for name, value in (headers or {}).items():
        lower = str(name).lower()
        if CREDENTIAL_HEADER.search(lower):
            stripped = True
        elif lower in KEPT_HEADERS:
            kept[lower] = str(value)[:1024]
    return kept, stripped


def graphql_kinds(text: str) -> list[str] | None:
    text = re.sub(r'"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"', '""', text)
    text = re.sub(r"#[^\n]*", "", text)
    kinds: list[str] = []
    head: list[str] = []
    depth = 0
    for token in re.findall(r"[{}]|[A-Za-z_][A-Za-z0-9_]*|[^\s{}A-Za-z_]+", text):
        if token == "{":
            if depth == 0:
                kinds.append(head[0] if head else "query")
                head = []
            depth += 1
        elif token == "}":
            depth -= 1
            if depth < 0:
                return None
        elif depth == 0:
            head.append(token)
    if depth != 0 or head or not kinds:
        return None
    return kinds


def graphql_read(body: str | None) -> bool:
    if not body:
        return False
    try:
        parsed = json.loads(body)
    except ValueError:
        return False
    operations = parsed if isinstance(parsed, list) else [parsed]
    if not operations:
        return False
    for operation in operations:
        if not isinstance(operation, dict) or not set(operation) <= GRAPHQL_KEYS or not isinstance(operation.get("query"), str):
            return False
        kinds = graphql_kinds(operation["query"])
        if kinds is None or "query" not in kinds or not set(kinds) <= {"query", "fragment"}:
            return False
    return True


def decoded_text(text: str) -> str:
    for _ in range(3):
        once = unquote(text)
        if once == text:
            break
        text = once
    return text.lower()


def suspect(text: str, words: set) -> bool:
    tokens = [token for token in re.split(r"[^a-z]+", decoded_text(text)) if token]
    pairs = {first + second for first, second in zip(tokens, tokens[1:])}
    return bool((set(tokens) | pairs) & words)


def write_kind(method: str, url: str, body: str | None) -> str | None:
    method = str(method or "").upper()
    if method == "POST" and graphql_read(body):
        return None
    if method not in READ_METHODS:
        return "explicit"
    try:
        parts = urlsplit(url)
    except ValueError:
        return "suspected"
    if suspect(parts.path, SUSPECT_WORDS):
        return "suspected"
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if suspect(key, SUSPECT_WORDS) or suspect(value, SUSPECT_WORDS | GRAPHQL_WRITES):
            return "suspected"
    return None


def attributes(text: str) -> dict:
    return {name.lower(): value.strip("\"'") for name, value in ATTRIBUTE.findall(text)}


def embedded_json(html: str) -> list[tuple[dict, object, int]]:
    out = []
    index = 0
    for match in SCRIPT.finditer(html):
        attrs = attributes(match.group(1))
        kind = attrs.get("type", "").lower()
        if kind and "json" not in kind and kind not in ("text/javascript", "application/javascript", "module"):
            continue
        content = match.group(2).strip()
        if "json" not in kind:
            assigned = ASSIGNED.match(content)
            if not assigned:
                continue
            content = assigned.group(2).strip()
        if not content.startswith(("{", "[")):
            continue
        try:
            value = json.loads(content)
        except ValueError:
            continue
        spec = {"scriptId": attrs["id"]} if attrs.get("id") else {"scriptIndex": index}
        index += 1
        out.append((spec, value, len(content)))
    return out


def materialize(request: dict):
    if "value" in request:
        return request["value"]
    text = request.get("text")
    value = None
    if text is not None and request.get("kind") == "document":
        block = heaviest_block(text)
        if block is not None:
            request["spec"], value = block
    elif text is not None:
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        if not isinstance(value, (dict, list)):
            value = None
    request["value"] = value
    return value


def looks_readable(kind: str, text: str) -> bool:
    if kind == "document":
        lower = text.lower()
        return "<script" in lower and ("json" in lower or "__" in lower or "= {" in lower or "={" in lower)
    return text.lstrip()[:1] in ("{", "[")


def heaviest_block(html: str) -> tuple[dict, object] | None:
    blocks = embedded_json(html)
    if not blocks:
        return None
    spec, value, _ = max(blocks, key=lambda block: block[2])
    return spec, value


def extract_embedded(html: str, spec: dict):
    for found, value, _ in embedded_json(html):
        if ("scriptId" in spec and found.get("scriptId") == spec["scriptId"]) or ("scriptIndex" in spec and found.get("scriptIndex") == spec["scriptIndex"]):
            return value
    return None


def parse_args(name: str, argv: list[str]) -> tuple[dict, list[str]]:
    from ardia_cli.browse.commands import parse

    return parse(argv, COMMAND_FLAGS.get(name, NO_HUMANIZE))


def element_target(state, selector: str) -> dict | None:
    from ardia_cli.browse.state import parse_ref

    ref_id = parse_ref(selector)
    if not ref_id:
        return {"css": selector}
    ref = state.refs.get(ref_id)
    if ref is not None and ref.role and ref.name:
        return {"role": ref.role, "name": ref.name}
    return None


def on_element(target: dict, name: str, rest: list[str]) -> list[str]:
    if "css" in target:
        return [name, target["css"], *rest]
    action = "press" if name == "press" else name
    return ["find", "role", target["role"], action, *rest, "--name", target["name"], "--exact"]


async def field_of(state, page) -> dict | None:
    if page is None or page.session_id is None:
        return None
    return await page.call(FIELD, None, frame=state.frame_for(page) or page.main_frame, read=True)


SECRET_HINT = re.compile(r"pass|secret|token|otp|\bpin\b|cvv|cvc|card", re.I)


def registered_secret(text: str) -> bool:
    from ardia_cli.redact import redact

    return bool(text) and redact(text) != text


async def describe(state, page, name: str, argv: list[str], step: dict):
    try:
        options, args = parse_args(name, argv)
    except Usage:
        step["why"] = "its arguments didn't parse"
        return
    if name == "open":
        step["replay"] = ["open", args[0]] if args else None
        if not args:
            step["why"] = "open without a URL"
        return
    if name in ON_ELEMENT or (name == "press" and len(args) >= 2):
        if not args:
            return
        if name == "click" and options.get("new_tab"):
            step["why"] = "click --new-tab opens another tab"
            return
        target = element_target(state, args[0])
        rest = [" ".join(args[1:])] if name in TYPING else args[1:]
        if target is None:
            step["why"] = f"{args[0]} was a ref with no role and name to find it by"
        elif "role" in target and name == "scrollintoview":
            step["why"] = "scrollintoview of a ref has no role-based form"
        else:
            step["replay"] = on_element(target, name, rest)
        if name in TYPING:
            hint = " ".join(str(part) for part in target.values()) if target else args[0]
            step["typed"] = {"value": rest[0], "index": (4 if "role" in target else 2) if step["replay"] else None, "hint": hint}
            step["probe_after"] = True
        return
    if name == "keyboard":
        if len(args) >= 2 and args[0] in ("type", "inserttext"):
            text = " ".join(args[1:])
            step["replay"] = ["keyboard", args[0], text]
            step["typed"] = {"value": text, "index": 2}
            step["probe_after"] = True
        else:
            step["why"] = "an unknown keyboard command"
        return
    if name == "find":
        describe_find(options, args, step)
        return
    if name == "wait" and any(arg == "--fn" or arg.startswith("--fn=") for arg in argv):
        step["why"] = "wait --fn runs page script"
        return
    step["replay"] = [name, *argv]


def describe_find(options: dict, args: list[str], step: dict):
    from ardia_cli.browse.commands import find_arguments

    if not args:
        return
    locator, args, wanted = find_arguments(args, options.get("name"))
    head = ["find", locator]
    if locator == "nth":
        if len(args) < 2:
            return
        head += args[:2]
        rest = args[2:]
    else:
        if not args:
            return
        head.append(args[0])
        rest = args[1:]
    action = rest[0] if rest else "click"
    flags = (["--name", wanted] if wanted else []) + (["--exact"] if options.get("exact") else []) + (["--partial"] if options.get("partial") else [])
    if action in TYPING:
        text = " ".join(rest[1:])
        step["replay"] = [*head, action, text, *flags]
        step["typed"] = {"value": text, "index": len(head) + 1, "hint": " ".join([*head[2:], wanted or ""])}
        step["probe_after"] = True
    else:
        step["replay"] = [*head, action, *rest[1:], *flags]


async def begin(ctx, name: str, argv) -> dict | None:
    state = ctx.state
    extras = getattr(state, "extras", None)
    if name not in RECORDED or not isinstance(extras, dict):
        return None
    page = state.pages.get(state.current) if state.current else None
    step = {"command": [name, *argv], "before": page.url if page else "", "replay": None, "requests": [], "writes": []}
    try:
        await asyncio.wait_for(describe(state, page, name, list(argv), step), PROBE_BUDGET)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass
    step["outer"] = extras.get("flow_sink")
    extras["flow_sink"] = step
    return step


def abandon(ctx, step: dict | None):
    if step is not None:
        ctx.state.extras["flow_sink"] = step.pop("outer", None)


async def end(ctx, step: dict | None, error: BrowseError | None = None):
    if step is None:
        return
    state = ctx.state
    abandon(ctx, step)
    page = state.pages.get(state.current) if state.current else None
    step["url"] = page.url if page else ""
    step["ok"] = error is None
    if error is not None:
        step["error"] = error.code or "failed"
    typed = step.get("typed")
    if typed is not None:
        if step.pop("probe_after", False):
            try:
                typed.update(await asyncio.wait_for(field_of(state, page), PROBE_BUDGET) or {})
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        if registered_secret(typed.get("value") or "") or SECRET_HINT.search(typed.get("hint") or ""):
            typed["secret"] = True
    replaying = state.extras.get("flow_replay")
    if replaying is not None:
        replaying.append(step)
        return
    log_of(state).add(step)


def decoded(body: dict) -> str | None:
    text = body.get("body") or ""
    if body.get("base64Encoded"):
        try:
            text = base64.b64decode(text).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    return text


def readable_type(record: dict) -> str | None:
    mime = (record.get("mime") or "").lower()
    if record["type"] == "Document":
        return "document" if "html" in mime else None
    if "json" in mime or mime.startswith("text/plain") or not mime:
        return "json"
    return None


async def capture(page, watch):
    state = page.state
    extras = getattr(state, "extras", None)
    step = extras.get("flow_sink") if isinstance(extras, dict) else None
    if step is None or not watch.records:
        return
    try:
        await asyncio.wait_for(collect(page, watch, step), CAPTURE_BUDGET)
    except ConnectionLost:
        raise
    except (BrowseError, asyncio.TimeoutError):
        pass


async def collect(page, watch, step: dict):
    bases = {base_domain(host_of(url)) for url in (step.get("before") or "", page.url or "")} - {""}
    taken = 0
    for request_id in list(watch.order):
        record = watch.records.get(request_id)
        if record is None:
            continue
        url = record.get("raw") or ""
        if not first_party(url, bases):
            continue
        method = record["method"]
        status = record["statuses"][-1] if record["statuses"] else None
        headers, stripped = kept_headers(record.get("headers"))
        body = record.get("post")
        if body is None and record.get("has_post") and method not in READ_METHODS:
            try:
                body = (await page.send("Network.getRequestPostData", {"requestId": request_id}, timeout=CAPTURE_BUDGET)).get("postData")
            except BrowseError:
                body = None
        too_large = body is not None and len(body) > POST_LIMIT
        if too_large:
            body = None
        if record.get("has_post") and body is None:
            too_large = True
        kind = write_kind(method, url, body)
        if kind and record["type"] != "Preflight":
            step["writes"].append({"method": method, "url": url, "kind": kind, "status": status, "type": record["type"]})
        readable = readable_type(record) if record["type"] in CAPTURED_TYPES else None
        if readable is None or not record.get("done") or record.get("failed") or not status or not 200 <= status < 300 or taken >= BODIES_PER_STEP:
            continue
        try:
            text = decoded(await page.send("Network.getResponseBody", {"requestId": request_id}, timeout=CAPTURE_BUDGET))
        except BrowseError:
            continue
        if text is None or len(text) > BODY_LIMIT:
            continue
        if not looks_readable(readable, text):
            continue
        entry = {"method": method, "url": url, "type": record["type"], "status": status, "mime": record.get("mime") or "",
                 "headers": headers, "body": body, "strippedAuth": stripped, "kind": readable, "bytes": len(text), "text": text}
        if too_large:
            entry["bodyLost"] = True
        if readable == "document" and materialize(entry) is None:
            continue
        step["requests"].append(entry)
        taken += 1
