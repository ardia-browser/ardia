import base64
import ipaddress
import json
import os
import re
import stat
import time
from pathlib import Path
from urllib.parse import parse_qsl, quote, quote_plus, unquote, unquote_plus, urlsplit, urlunsplit

from ardia_cli.browse import flowlog, paths
from ardia_cli.browse import shape as shaping
from ardia_cli.browse.commands import Result, command, normalize_url, parse
from ardia_cli.browse.errors import BrowseError, Usage

VERSION = 1
DIR_NAME = "Flows"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PARAM = re.compile(r"\{\{([a-z][a-z0-9_]{0,23})\}\}")
PARAM_NAME = re.compile(r"[a-z][a-z0-9_]{0,23}")
FIELD_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,23}(\.[A-Za-z_][A-Za-z0-9_]{0,23})?")
SAFE_WORD = re.compile(r"[A-Za-z][A-Za-z_.-]{0,31}")
SMALL_NUMBER = 10000
EMAIL = re.compile(r"[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"\+?\d[\d\s().-]{5,}\d")
MAX_DESCRIPTION = 120
HINT_DESCRIPTION = 80
MAX_EXAMPLE = 40
REPLAYABLE = {"open", "click", "dblclick", "fill", "type", "press", "keyboard", "select", "check", "uncheck", "find", "back", "forward",
              "reload", "scroll", "scrollintoview", "hover", "focus", "wait"}
REPLAY_FLAGS = {"--name", "--exact", "--partial", "--text", "--url", "--load", "--timeout", "--state", "--no-humanize"}
FIND_ACTIONS = {"click", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus", "dblclick", "text"}
MAX_FLOW = 4 * 1024 * 1024
REDACTED = "<redacted>"
MIN_SUBSTRING = 3
NOISE_KEY = re.compile(r"^(utm_.*|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_ga|_gl|ref|ref_src|spm|igshid)$", re.I)
CREDENTIAL_WORDS = {"token", "auth", "apikey", "key", "sig", "signature", "secret", "password", "passwd", "pwd", "pass", "csrf", "xsrf",
                    "session", "sessionid", "sid", "jwt", "otp", "nonce", "credential", "credentials", "bearer", "hmac", "accesstoken"}
SIGNATURE_DEPTH = 6
SIGNATURE_KEYS = 80
HINT_LIMIT = 5
FIELDS = {"version", "name", "description", "site", "origin", "startUrl", "hosts", "createdAt", "createdBy", "params", "output", "verified",
          "replayable", "redactedSteps", "writes", "steps"}
REQUIRED = ("version", "name", "site", "origin", "startUrl", "hosts", "params", "output", "steps")
SAVE_FLAGS = {"--from": "value", "--to": "value", "--param": "multi", "--output": "value", "--description": "value"}
RUN_FLAGS = {"--param": "multi", "--fields": "value", "--where": "multi", "--limit": "value", "--allow-write": "value", "--tier": "value",
             "--site": "value", "--timeout": "value"}
SITE_FLAGS = {"--site": "value"}
USAGE = ("Usage: ardia browse flow steps [--all] | save <name> [--from n] [--to n] [--param k=v] [--output id] [--description text]\n"
         "  | run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n] [--allow-write all|w1,w2] [--tier page|replay]\n"
         "  | list [site] | show <name> [--site s] | rm <name> [--site s]")


def placeholder(name: str) -> str:
    return "{{" + name + "}}"


def check_name(name: str) -> str:
    if not isinstance(name, str) or not NAME.match(name):
        raise Usage(f"A flow name is 1 to 64 letters, digits, '-' or '_', starting with a letter or digit, not {name!r}")
    return name


def slug(text: str) -> str | None:
    name = re.sub(r"[^a-z0-9]+", "_", re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(text or "")).lower()).strip("_")
    return name if PARAM_NAME.fullmatch(name) else None


def credential_key(key: str) -> bool:
    words = [word.lower() for word in re.split(r"[_\-.\[\]\s]+|(?<=[a-z])(?=[A-Z])", unquote_plus(str(key))) if word]
    words += [word[:-1] for word in words if word.endswith("s")]
    return any(word in CREDENTIAL_WORDS for word in words) or unquote_plus(str(key)).lower().replace("-", "").replace("_", "") in CREDENTIAL_WORDS


def personal(text: str) -> bool:
    text = str(text)
    return bool(EMAIL.search(text) or PHONE.search(text) or (re.search(r"\d", text) and re.search(r"[A-Za-z]", text) and re.search(r"\s", text.strip())))


def secret_like(text: str) -> bool:
    text = str(text)
    return len(text) >= 20 and bool(re.search(r"\d", text)) and bool(re.search(r"[A-Za-z]", text))


def safe_leaf(value) -> bool:
    if value is None or isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return abs(value) < SMALL_NUMBER
    if not isinstance(value, str):
        return False
    if PARAM.fullmatch(value) or SAFE_WORD.fullmatch(value) or value == "":
        return True
    return bool(re.fullmatch(r"-?\d{1,4}", value))


def graphql_text_safe(text: str) -> bool:
    stripped = re.sub(r"#[^\n]*", "", text)
    return '"' not in stripped and not re.search(r"\d{5,}", stripped)


def body_problem(body: str | None, kind: str | None) -> str | None:
    if body is None:
        return None
    if kind == "form":
        for pair in body.split("&"):
            key, _, value = pair.partition("=")
            value = unquote_plus(value)
            if not safe_leaf(value) or (credential_key(key) and value and not PARAM.fullmatch(value)):
                return "its body held a value a flow doesn't keep (only params, small numbers, true/false and short words)"
        return None
    if kind != "json":
        return "its body isn't JSON or a form, so a flow can't keep it safely"
    problems = []

    def walk(value, top: bool):
        if isinstance(value, dict):
            for key, inner in value.items():
                if top and key == "query" and isinstance(inner, str) and flowlog.graphql_kinds(inner) is not None:
                    if not graphql_text_safe(inner):
                        problems.append(key)
                    continue
                if credential_key(key) and not (isinstance(inner, str) and PARAM.fullmatch(inner)) and inner not in (None, ""):
                    problems.append(key)
                    continue
                walk(inner, False)
        elif isinstance(value, list):
            for inner in value:
                walk(inner, top and isinstance(inner, dict))
        elif not safe_leaf(value):
            problems.append(value)

    walk(json.loads(body), True)
    return "its body held a value a flow doesn't keep (only params, small numbers, true/false and short words)" if problems else None


def url_problem(url: str) -> str | None:
    try:
        parts = urlsplit(url)
    except ValueError:
        return "its URL doesn't parse"
    segments = [flowlog.decoded_text(segment) for segment in parts.path.split("/") if segment]
    for segment in segments:
        if PARAM.fullmatch(segment):
            continue
        if credential_key(segment) or secret_like(segment) or personal(segment) or ":" in segment:
            return "its URL path looks like it holds a credential or personal data"
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if PARAM.fullmatch(value) or value == REDACTED or credential_key(key):
            continue
        if personal(value) or secret_like(value):
            return "its URL query holds what looks like personal data or a credential"
    return None


def site_of(url: str) -> str | None:
    from ardia_cli import notes

    site = notes.page_site(url)
    if site is None:
        return None
    match = re.fullmatch(r"(\[[^\]]+\]|[^:]+)(:\d+)?", site)
    if not match:
        return None
    host = match.group(1)
    base = host if host.startswith("[") else flowlog.base_domain(host)
    return base + (match.group(2) or "")


def netloc_of(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower().rpartition("@")[2]
    except ValueError:
        return ""


def signature(value, depth: int = 0):
    if isinstance(value, dict):
        if depth >= SIGNATURE_DEPTH:
            return "object"
        return {str(key): signature(inner, depth + 1) for key, inner in list(value.items())[:SIGNATURE_KEYS]}
    if isinstance(value, list):
        if depth >= SIGNATURE_DEPTH:
            return "array"
        return [signature(value[0], depth + 1)] if value else []
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if value is None:
        return "null"
    return "string"


def joined(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def drift(recorded, value, path: str = "") -> str | None:
    where = path or "the answer"
    if isinstance(recorded, dict):
        if not isinstance(value, dict):
            return f"{where} is no longer an object"
        for key, inner in recorded.items():
            if key not in value:
                return f"{joined(path, key)} is missing"
            found = drift(inner, value[key], joined(path, key))
            if found:
                return found
        return None
    if isinstance(recorded, list):
        if not isinstance(value, list):
            return f"{where} is no longer a list"
        return drift(recorded[0], value[0], path + "[0]") if recorded and value else None
    if recorded == "object":
        return None if isinstance(value, dict) else f"{where} is no longer an object"
    if recorded == "array":
        return None if isinstance(value, list) else f"{where} is no longer a list"
    if recorded == "null" or value is None:
        return None
    now = "an object" if isinstance(value, dict) else "a list" if isinstance(value, list) else f"a {signature(value)}"
    return None if signature(value) == recorded else f"{where} was a {recorded}, now {now}"


def list_gone(path: str | None, value) -> bool:
    if not path:
        return False
    return not isinstance(shaping.lookup(value, path), list)


def encoded_forms(example: str, in_path: bool) -> list[str]:
    forms = [quote(example, safe="")] if in_path else [quote_plus(example), quote(example, safe="")]
    return list(dict.fromkeys(forms + [example]))


def template_part(text: str, values: list[tuple[str, str]], in_path: bool) -> str:
    decoded = unquote(text) if in_path else unquote_plus(text)
    for name, example in values:
        if example and decoded == example:
            return placeholder(name)
    for name, example in values:
        if len(example) < MIN_SUBSTRING:
            continue
        for form in encoded_forms(example, in_path):
            if form in text:
                text = text.replace(form, placeholder(name))
                break
    return text


def template_pair(pair: str, values: list[tuple[str, str]]) -> str:
    key, sep, value = pair.partition("=")
    return key + "=" + template_part(value, values, False) if sep else pair


def template_url(url: str, values: list[tuple[str, str]]) -> str:
    parts = urlsplit(url)
    path = "/".join(template_part(segment, values, True) for segment in parts.path.split("/"))
    query = "&".join(template_pair(pair, values) for pair in parts.query.split("&")) if parts.query else ""
    return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def graphql_text(value) -> bool:
    return isinstance(value, str) and bool(re.match(r"\s*(query|mutation|subscription|fragment|\{)", value))


def template_json(value, values: list[tuple[str, str]], top: bool = False):
    if isinstance(value, dict):
        return {key: inner if top and key == "query" and graphql_text(inner) else template_json(inner, values) for key, inner in value.items()}
    if isinstance(value, list):
        return [template_json(inner, values) for inner in value]
    if isinstance(value, str):
        for name, example in values:
            if example and value == example:
                return placeholder(name)
        for name, example in values:
            if len(example) >= MIN_SUBSTRING and example in value:
                value = value.replace(example, placeholder(name))
        return value
    return value


def form_like(body: str, content_type: str) -> bool:
    return "x-www-form-urlencoded" in content_type or bool(re.fullmatch(r"[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*", body))


def body_type(body: str | None, content_type: str) -> str | None:
    if body is None:
        return None
    try:
        if isinstance(json.loads(body), (dict, list)):
            return "json"
    except ValueError:
        pass
    return "form" if form_like(body, content_type) else "text"


def step_url(url: str, values: list[tuple[str, str]], secrets: list[str]) -> str:
    from ardia_cli.browse.changes import clean_url

    if not url or any(carries(url, secret) for secret in secrets):
        return REDACTED if url else ""
    try:
        return clean_url(template_url(url, values))
    except ValueError:
        return REDACTED


def is_local(host: str) -> bool:
    host = (host or "").lower().strip("[]").rstrip(".")
    if host == "localhost" or host.endswith(".localhost") or not host:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local or address.is_reserved or address.is_unspecified or address.is_multicast


def host_allowed(host: str, start_host: str) -> bool:
    hostname = (urlsplit("//" + host).hostname or "") if "//" not in host else (urlsplit(host).hostname or "")
    if not hostname or flowlog.base_domain(hostname) != flowlog.base_domain(start_host):
        return False
    if is_local(hostname) or is_local(start_host):
        return hostname == start_host.lower()
    return True


def redact_body(body: str | None, kind: str | None) -> tuple[str | None, bool]:
    if body is None:
        return None, False
    if kind == "form":
        pairs, touched = [], False
        for pair in body.split("&"):
            key, sep, value = pair.partition("=")
            if sep and value and not PARAM.fullmatch(value) and credential_key(key):
                pairs.append(f"{key}={REDACTED}")
                touched = True
            else:
                pairs.append(pair)
        return "&".join(pairs), touched
    if kind == "json":
        found = []

        def walk(value):
            if isinstance(value, dict):
                out = {}
                for key, inner in value.items():
                    if isinstance(inner, str) and inner and not PARAM.fullmatch(inner) and credential_key(str(key)):
                        found.append(key)
                        out[key] = REDACTED
                    else:
                        out[key] = walk(inner)
                return out
            if isinstance(value, list):
                return [walk(inner) for inner in value]
            return value

        cleaned = walk(json.loads(body))
        return (json.dumps(cleaned, ensure_ascii=False, separators=(",", ":")) if found else body), bool(found)
    return body, False


def template_body(body: str | None, kind: str | None, values: list[tuple[str, str]]) -> str | None:
    if body is None:
        return None
    if kind == "json":
        return json.dumps(template_json(json.loads(body), values, top=True), ensure_ascii=False, separators=(",", ":"))
    if kind == "form":
        return "&".join(template_pair(pair, values) for pair in body.split("&"))
    for name, example in values:
        if len(example) >= MIN_SUBSTRING and example in body:
            body = body.replace(example, placeholder(name))
    return body


def fill_text(text: str, values: dict, encode=lambda value: value) -> str:
    return PARAM.sub(lambda match: encode(values[match.group(1)]) if match.group(1) in values else match.group(0), text)


def fill_pair(pair: str, values: dict) -> str:
    key, sep, value = pair.partition("=")
    return key + sep + fill_text(value, values, quote_plus) if sep else pair


def fill_url(url: str, values: dict) -> str:
    parts = urlsplit(url)
    path = "/".join(fill_text(segment, values, lambda value: quote(value, safe="")) for segment in parts.path.split("/"))
    query = "&".join(fill_pair(pair, values) for pair in parts.query.split("&")) if parts.query else ""
    return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def fill_json(value, values: dict):
    if isinstance(value, dict):
        return {key: fill_json(inner, values) for key, inner in value.items()}
    if isinstance(value, list):
        return [fill_json(inner, values) for inner in value]
    if isinstance(value, str):
        return fill_text(value, values)
    return value


def fill_body(body: str | None, kind: str | None, values: dict) -> str | None:
    if body is None:
        return None
    if kind == "json":
        return json.dumps(fill_json(json.loads(body), values), ensure_ascii=False, separators=(",", ":"))
    if kind == "form":
        return "&".join(fill_pair(pair, values) for pair in body.split("&"))
    for name in PARAM.findall(body):
        if name in values and re.search(r"[\r\n]", values[name]):
            raise Usage(f"--param {name} has a line break, which this flow's plain-text request body can't carry")
    return fill_text(body, values)


def redact_credentials(url: str) -> tuple[str, bool]:
    try:
        parts = urlsplit(url)
    except ValueError:
        return REDACTED, True
    touched = False
    pairs = []
    for pair in parts.query.split("&") if parts.query else []:
        key, sep, value = pair.partition("=")
        if sep and value and not PARAM.fullmatch(value) and (credential_key(key) or personal(unquote_plus(value)) or secret_like(unquote_plus(value))):
            pairs.append(f"{key}={REDACTED}")
            touched = True
        else:
            pairs.append(pair)
    fragment = parts.fragment
    if "=" in fragment:
        fragment, touched = "", True
    netloc = parts.netloc.rpartition("@")[2]
    touched = touched or netloc != parts.netloc
    return urlunsplit((parts.scheme, netloc, parts.path, "&".join(pairs), fragment)), touched


def carries(text: str | None, secret: str) -> bool:
    if not text or not secret:
        return False
    raw = secret.encode()
    encoded = base64.b64encode(raw).decode()
    forms = {secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret, ensure_ascii=False)[1:-1], encoded, encoded.rstrip("="),
             base64.urlsafe_b64encode(raw).decode().rstrip("="), raw.hex(), raw.hex().upper()}
    lowered = text.lower()
    return any(form and (form in text or (form.isalnum() and form.lower() == form and form in lowered)) for form in forms)


def scrub(value, secrets: list[str]):
    if isinstance(value, str):
        return REDACTED if any(carries(value, secret) for secret in secrets) else value
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item, secrets) for key, item in value.items()}
    return value


def default_output(requests: list[dict]) -> str:
    def uses_param(request):
        return "{{" in request["url"] or "{{" in (request.get("body") or "")

    pool = [request for request in requests if uses_param(request)] or requests
    return max(pool, key=lambda request: request["expect"]["bytes"])["id"] if pool else ""


def is_write(request: dict) -> bool:
    return flowlog.write_kind(request["method"], request["url"], request.get("body")) is not None


def body_value(request: dict):
    return flowlog.materialize(request)


def start_url(steps: list[dict]) -> str:
    first = steps[0]
    if first["command"][0] == "open" and str(first.get("url") or "").startswith(("http://", "https://")):
        return first["url"]
    return first.get("before") or ""


def build_flow(name: str, steps: list[dict], given: dict | None = None, output: str | None = None, description: str | None = None,
               tool_version: str = "") -> tuple[dict, dict]:
    given = dict(given or {})
    check_name(name)
    if not steps:
        raise BrowseError("No recorded steps in that range; `ardia browse flow steps --all` lists what this session recorded", code="no_steps")
    start = start_url(steps)
    if not start.startswith(("http://", "https://")):
        raise BrowseError("flow save needs a range that starts on a web page: begin it with `open <url>` or pick it with --from", code="not_a_web_page")
    parts = urlsplit(start)
    origin = f"{parts.scheme}://{netloc_of(start)}"
    site = site_of(start)
    base = flowlog.base_domain(parts.hostname or "")
    secrets = [step["typed"]["value"] for step in steps if (step.get("typed") or {}).get("secret") and step["typed"].get("value")]
    params: list[dict] = []
    named: dict[str, str] = {}

    def add(hint: str, value: str, source: str, example: bool) -> str:
        if value in named:
            return named[value]
        taken = {param["name"] for param in params}
        candidate = slug(hint)
        if candidate is None or candidate in taken:
            number = 1
            while f"p{number}" in taken:
                number += 1
            candidate = f"p{number}"
        params.append({"name": candidate, "example": value if example and not personal(value) and not secret_like(value) else None, "source": source})
        named[value] = candidate
        return candidate

    for key in given:
        if not PARAM_NAME.fullmatch(key):
            raise Usage(f"A param name is lowercase letters, digits and '_', starting with a letter, not {key!r}")
    by_given = {value: key for key, value in given.items()}
    for step in steps:
        typed = step.get("typed") or {}
        value = typed.get("value")
        if not value or typed.get("secret"):
            continue
        if value in by_given:
            add(by_given[value], value, "typed", True)
        else:
            add(typed.get("field") or "text", value, "typed", False)
    for key, value in given.items():
        if value not in named:
            add(key, value, "given", True)

    captured = []
    dropped = []
    for step in steps:
        for request in step.get("requests") or []:
            if body_value(request) is None:
                if request.get("evicted"):
                    dropped.append({"id": request["id"], "why": "its body was dropped to keep the recording small; record it again"})
                continue
            if flowlog.base_domain(flowlog.host_of(request["url"])) != base:
                continue
            if any(carries(request["url"], secret) or carries(request.get("body"), secret) for secret in secrets):
                dropped.append({"id": request["id"], "why": "it sent a value typed into a secret field"})
                continue
            if request.get("bodyLost"):
                dropped.append({"id": request["id"], "why": "its request body couldn't be read whole"})
                continue
            captured.append((step, request))

    for url in [start] + [step.get("url") or "" for step in steps if step["command"][0] == "open"]:
        for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=False):
            if NOISE_KEY.match(key) or credential_key(key) or value in named:
                continue
            if any(carries(request["url"], value) or carries(request.get("body"), value) for _, request in captured):
                add(key, value, "query", True)

    values = sorted(((param["name"], value) for value, param_name in named.items() for param in params if param["name"] == param_name),
                    key=lambda pair: len(pair[1]), reverse=True)
    kept_by_step: dict[int, list] = {}
    requests = []
    hosts = {netloc_of(start)}
    for step, request in captured:
        content_type = (request.get("headers") or {}).get("content-type", "")
        kind = body_type(request.get("body"), content_type)
        templated = template_url(request["url"], values)
        body = template_body(request.get("body"), kind, values)
        problem = url_problem(templated) or body_problem(body, kind)
        if problem:
            dropped.append({"id": request["id"], "why": problem})
            continue
        url, redacted = redact_credentials(templated)
        value = body_value(request)
        found = shaping.main_list(value)
        expect = {"status": request.get("status"), "mime": request.get("mime") or "", "signature": signature(value), "bytes": request.get("bytes") or 0,
                  "list": found[0] if found else None, "listRoot": isinstance(value, list),
                  "itemFields": [field for field in shaping.item_fields(found[1]) if FIELD_NAME.fullmatch(field)] if found else []}
        if request.get("kind") == "document":
            expect["extract"] = request.get("spec")
        body, body_redacted = redact_body(body, kind)
        kept = {"id": request["id"], "method": request["method"], "url": url, "headers": request.get("headers") or {},
                "body": body, "bodyType": kind, "kind": request.get("kind") or "json", "expect": expect}
        if request.get("strippedAuth") or body_redacted or redacted:
            kept["strippedAuth"] = True
        if redacted:
            kept["redacted"] = True
        kept_by_step.setdefault(step["seq"], []).append(kept)
        requests.append(kept)
        hosts.add(netloc_of(request["url"]))
    if not requests:
        why = "; ".join(f"{item['id']}: {item['why']}" for item in dropped)
        raise BrowseError("Nothing to save: the steps in that range caused no first-party JSON answers or pages with embedded JSON a flow can keep "
                          f"(`flow steps` lists what each step caused){'; left out ' + why if why else ''}", data={"dropped": dropped}, code="nothing_to_save")
    if output is not None and output not in {request["id"] for request in requests}:
        raise Usage(f"--output {output} isn't one of the requests kept: {', '.join(request['id'] for request in requests)}")

    saved_steps = []
    redacted_steps = []
    not_replayable = []
    for step in steps:
        command = list(step["replay"]) if step.get("replay") else None
        typed = step.get("typed") or {}
        hidden = False
        if command is not None and typed.get("index") is not None and typed["index"] < len(command):
            if typed.get("secret"):
                command[typed["index"]] = REDACTED
                hidden = True
            elif typed.get("value") in named:
                command[typed["index"]] = placeholder(named[typed["value"]])
        if command is not None and command[0] == "open" and len(command) > 1:
            command[1], touched = redact_credentials(template_url(normalize_url(command[1]), values))
            hidden = hidden or touched
        if command is not None and secrets:
            scrubbed = scrub(command, secrets)
            hidden = hidden or scrubbed != command
            command = scrubbed
        after = step_url(step.get("url") or "", values, secrets)
        if hidden:
            redacted_steps.append(step["seq"])
        if command is None:
            not_replayable.append({"seq": step["seq"], "why": step.get("why") or "it can't be replayed"})
        saved = {"seq": step["seq"], "command": command, "url": after, "ok": bool(step.get("ok", True)), "requests": kept_by_step.get(step["seq"], [])}
        if command is None:
            saved["why"] = step.get("why") or "it can't be replayed"
        saved_steps.append(saved)

    writes = []
    for step in steps:
        for write in step.get("writes") or []:
            if flowlog.base_domain(flowlog.host_of(write["url"])) != base:
                continue
            url = step_url(write["url"], values, secrets)
            writes.append({"id": f"w{len(writes) + 1}", "method": write["method"], "url": url, "kind": write["kind"], "step": step["seq"]})
    for request in requests:
        if is_write(request):
            match = next((write for write in writes if write["step"] == int(request["id"][1:].split("r")[0]) and write["method"] == request["method"]
                          and "request" not in write), None)
            if match is not None:
                match["request"] = request["id"]
    start_saved, start_hidden = redact_credentials(scrub(template_url(start, values), secrets))
    flow = {
        "version": VERSION, "name": name, "description": " ".join(str(description or "").split())[:MAX_DESCRIPTION] or None, "site": site, "origin": origin,
        "startUrl": start_saved, "hosts": sorted(host for host in hosts if host), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "createdBy": {"tool": "ardia browse", "version": tool_version}, "params": params, "output": output or default_output(requests),
        "verified": True, "replayable": not redacted_steps and not not_replayable and not start_hidden, "redactedSteps": redacted_steps,
        "writes": writes, "steps": saved_steps,
    }
    report = {"requests": [{"id": request["id"], "method": request["method"], "url": request["url"], "kind": request["kind"],
                            "list": request["expect"]["list"], "write": is_write(request)} for request in requests],
              "params": params, "writes": writes, "notReplayable": not_replayable, "redactedSteps": redacted_steps, "dropped": dropped,
              "output": flow["output"]}
    return flow, report


def output_request(flow: dict) -> dict | None:
    return next((request for step in flow["steps"] for request in step.get("requests") or [] if request["id"] == flow["output"]), None)


def invalid(why: str) -> BrowseError:
    return BrowseError(f"That flow file {why}; save the flow again", code="flow_invalid")


def check_command(command, flow: dict, start_host: str):
    if command is None:
        return
    if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
        raise invalid("has a step that isn't a list of words")
    name, args = command[0], command[1:]
    if name not in REPLAYABLE:
        raise invalid(f"replays `{name[:20]}`, which a flow never runs")
    flags = [arg.split("=", 1)[0] for arg in args if arg.startswith("--")]
    if any(flag not in REPLAY_FLAGS for flag in flags):
        raise invalid(f"passes {', '.join(flag for flag in flags if flag not in REPLAY_FLAGS)[:60]} to `{name}`")
    if name == "open":
        if len(args) != 1:
            raise invalid("has an `open` without exactly one URL")
        target = fill_text(args[0], {param["name"]: "x" for param in flow["params"]})
        if not target.startswith(("http://", "https://")) or not host_allowed(urlsplit(target).netloc, start_host):
            raise invalid("opens a page off its site")
    if name == "keyboard" and (not args or args[0] not in ("type", "inserttext")):
        raise invalid("has a keyboard step other than type or inserttext")
    if name == "find":
        actions = [arg for arg in args if arg in FIND_ACTIONS]
        if not actions:
            raise invalid("has a find step with no action it allows")
    if name == "wait" and any(arg.startswith(("http:", "https:", "javascript:")) for arg in args):
        raise invalid("has a wait step with a URL")


def validate(flow, site: str | None = None, name: str | None = None) -> dict:
    if not isinstance(flow, dict):
        raise invalid("isn't a JSON object")
    if flow.get("version") != VERSION:
        raise invalid(f"is version {str(flow.get('version'))[:10]!r}; this ardia reads version {VERSION}.")
    unknown = sorted(set(flow) - FIELDS)
    missing = [key for key in REQUIRED if key not in flow]
    if unknown or missing:
        raise invalid("has " + "; ".join(part for part in (f"unknown fields {', '.join(unknown)[:80]}" if unknown else "",
                                                             f"missing {', '.join(missing)}" if missing else "") if part))
    start = flow["startUrl"]
    if not isinstance(start, str) or not start.startswith(("http://", "https://")):
        raise invalid("has a start URL that isn't a web page")
    start_host = (urlsplit(start).hostname or "").lower()
    if (site is not None and flow["site"] != site) or (name is not None and flow["name"] != name) or site_of(start) != flow["site"]:
        raise invalid("has a site or name that doesn't match where it's stored")
    if flow["origin"] != f"{urlsplit(start).scheme}://{netloc_of(start)}":
        raise invalid("has an origin that isn't its start URL's")
    if not isinstance(flow["hosts"], list) or netloc_of(start) not in flow["hosts"]:
        raise invalid("doesn't list its start URL's host")
    for host in flow["hosts"]:
        if not isinstance(host, str) or not host_allowed(host, start_host):
            raise invalid(f"allows {str(host)[:60]}, which isn't on {flow['site']} or is a local address")
    description = flow.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > MAX_DESCRIPTION or "\n" in description):
        raise invalid("has a description longer than one short line")
    if not isinstance(flow["params"], list) or not all(isinstance(param, dict) and isinstance(param.get("name"), str)
                                                        and PARAM_NAME.fullmatch(param["name"]) for param in flow["params"]):
        raise invalid("has a param whose name isn't a short identifier")
    if not isinstance(flow["steps"], list):
        raise invalid("has no list of steps")
    for step in flow["steps"]:
        if not isinstance(step, dict):
            raise invalid("has a step that isn't an object")
        check_command(step.get("command"), flow, start_host)
        for request in step.get("requests") or []:
            url = request.get("url") if isinstance(request, dict) else None
            if not isinstance(url, str) or not url.startswith(("http://", "https://")) or netloc_of(url) not in flow["hosts"]:
                raise invalid("has a request to a host it doesn't list")
            fields = (request.get("expect") or {}).get("itemFields") or []
            if not all(isinstance(field, str) and FIELD_NAME.fullmatch(field) for field in fields):
                raise invalid("has an item field that isn't a short identifier")
    for write in flow.get("writes") or []:
        if not isinstance(write, dict) or not host_allowed(netloc_of(str(write.get("url") or "")), start_host):
            raise invalid("lists a write off its site")
    if output_request(flow) is None:
        raise invalid("has no output request")
    return flow


def check_site(site: str) -> str:
    from ardia_cli import notes

    if not isinstance(site, str) or not notes.HOST.match(site):
        raise Usage(f"{site!r} isn't a site (host[:port])")
    return site


def open_site(root: Path, site: str, create: bool) -> int | None:
    try:
        return paths.open_private(root, DIR_NAME, check_site(site), create=create)
    except FileNotFoundError:
        return None
    except paths.PathError as error:
        if not create and "doesn't exist" in str(error):
            return None
        raise BrowseError(str(error)) from None


def save(root: Path, flow: dict) -> Path:
    folder = open_site(root, flow["site"], create=True)
    name = check_name(flow["name"]) + ".json"
    data = json.dumps(flow, ensure_ascii=False, indent=1).encode()
    if len(data) > MAX_FLOW:
        os.close(folder)
        raise BrowseError(f"That flow would be {len(data):,} bytes; the limit is {MAX_FLOW // (1024 * 1024)} MB. Save a narrower range (--from, --to)",
                          code="flow_too_large")
    temp = f".{name}.{os.getpid()}.tmp"
    try:
        fd = paths.open_private_file(temp, folder, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        os.rename(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
    finally:
        os.close(folder)
    return root / DIR_NAME / flow["site"] / name


def load(root: Path, site: str, name: str) -> dict:
    if name not in names(root, site):
        raise BrowseError(f"No flow {check_name(name)} for {site}", code="no_flow")
    folder = open_site(root, site, create=False)
    try:
        flow = paths.read_private_json(name + ".json", folder, limit=MAX_FLOW)
    except (paths.PathError, OSError) as error:
        raise BrowseError(f"Can't read flow {name} for {site}: {error}", code="flow_invalid") from None
    finally:
        os.close(folder)
    if flow is None:
        raise BrowseError(f"Flow {name} for {site} isn't valid JSON; save it again", code="flow_invalid")
    return validate(flow, site, name)


def sites(root: Path) -> list[str]:
    try:
        folder = paths.open_private(root, DIR_NAME, create=False)
    except (FileNotFoundError, paths.PathError):
        return []
    try:
        return sorted(entry for entry in os.listdir(folder) if not entry.startswith(".") and stat.S_ISDIR(os.stat(entry, dir_fd=folder, follow_symlinks=False).st_mode))
    finally:
        os.close(folder)


def names(root: Path, site: str) -> list[str]:
    folder = open_site(root, site, create=False)
    if folder is None:
        return []
    try:
        return sorted(entry[:-5] for entry in os.listdir(folder) if entry.endswith(".json") and not entry.startswith(".") and NAME.match(entry[:-5]))
    finally:
        os.close(folder)


def listing(root: Path, site: str | None = None) -> list[dict]:
    rows = []
    for one in [site] if site else sites(root):
        for name in names(root, one):
            try:
                rows.append(summary(load(root, one, name)))
            except BrowseError as error:
                rows.append({"site": one, "name": name, "error": error.message})
    return rows


def summary(flow: dict) -> dict:
    request = output_request(flow) or {}
    return {"site": flow["site"], "name": flow["name"], "description": flow.get("description"),
            "params": [{"name": param["name"], "example": param.get("example"), "source": param.get("source")} for param in flow["params"]],
            "itemFields": (request.get("expect") or {}).get("itemFields") or [], "verified": bool(flow.get("verified", True)),
            "writes": len(flow.get("writes") or []), "replayable": bool(flow.get("replayable"))}


def remove(root: Path, site: str, name: str) -> bool:
    folder = open_site(root, site, create=False)
    if folder is None:
        return False
    try:
        try:
            os.unlink(check_name(name) + ".json", dir_fd=folder)
        except FileNotFoundError:
            return False
        return True
    finally:
        os.close(folder)


def locate(root: Path, name: str, site: str | None, page_url: str | None) -> str:
    check_name(name)
    if site:
        return check_site(site)
    found = [one for one in sites(root) if name in names(root, one)]
    if len(found) == 1:
        return found[0]
    here = site_of(page_url) if page_url else None
    if here in found:
        return here
    if not found:
        raise BrowseError(f"No saved flow named {name} (`ardia browse flow list` lists them)", code="no_flow")
    raise Usage(f"{name} is saved for {', '.join(found)}; pick one with --site <site>")


def clipped(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def signature_line(row: dict, limit: int = MAX_DESCRIPTION) -> str:
    params = ", ".join(param["name"] for param in row.get("params") or [])
    described = f" [saved description: {json.dumps(clipped(row['description'], limit), ensure_ascii=False)}]" if row.get("description") else ""
    return f"{row['name']}({params}){described}"


def listing_text(rows: list[dict]) -> str:
    lines = []
    for row in rows:
        if row.get("error"):
            lines.append(f"{row['site']}  {row['name']}  (unreadable: {row['error']})")
            continue
        fields = ", ".join(row["itemFields"][:12]) + (" …" if len(row["itemFields"]) > 12 else "")
        examples = ", ".join(f"{param['name']}={json.dumps(clipped(param['example'], MAX_EXAMPLE), ensure_ascii=False)}"
                             for param in row["params"] if param.get("example"))
        extra = "; ".join(part for part in (f"examples {examples}" if examples else "", f"items: {fields}" if fields else "",
                                             "unverified" if not row["verified"] else "", f"{row['writes']} write(s)" if row["writes"] else "") if part)
        lines.append(f"{row['site']}  {signature_line(row)}" + (f"  [{extra}]" if extra else ""))
    return "\n".join(lines) or "No saved flows yet (`ardia browse flow save <name>` after doing the task once)"


def show_text(flow: dict) -> str:
    lines = [f"{flow['name']} on {flow['site']}" + (f" [saved description: {json.dumps(flow['description'], ensure_ascii=False)}]" if flow.get("description") else ""),
             f"start: {flow['startUrl']}"]
    for param in flow["params"]:
        example = f" (recorded: {param['example']})" if param.get("example") else " (required)"
        lines.append(f"param {param['name']} [{param.get('source')}]{example}")
    for step in flow["steps"]:
        command = " ".join(step["command"]) if step.get("command") else f"(not replayable: {step.get('why')})"
        lines.append(f"[{step['seq']}] {command}")
        for request in step.get("requests") or []:
            mark = " ← output" if request["id"] == flow["output"] else ""
            lines.append(f"    {request['id']} {request['method']} {request['url']} ({request['kind']}){mark}")
    for write in flow.get("writes") or []:
        lines.append(f"write {write['id']}: {write['method']} {write['url']} ({write['kind']}, step {write['step']})")
    if not flow.get("verified", True):
        lines.append("unverified: the last run saw the answer's shape change; save it again")
    return "\n".join(lines)


def run_local(root: Path, args: list[str], page_url: str | None = None) -> Result:
    action = args[0] if args else "list"
    if action == "list":
        _, positional = parse(args[1:], SITE_FLAGS)
        site = check_site(site_of(positional[0]) or positional[0]) if positional else None
        rows = listing(root, site)
        return Result({"flows": rows}, listing_text(rows), page_content=True)
    if action == "show":
        options, positional = parse(args[1:], SITE_FLAGS)
        if not positional:
            raise Usage("Usage: ardia browse flow show <name> [--site s]")
        site = locate(root, positional[0], options.get("site"), page_url)
        flow = load(root, site, positional[0])
        return Result({"flow": flow}, show_text(flow), page_content=True)
    if action in ("rm", "remove", "delete"):
        options, positional = parse(args[1:], SITE_FLAGS)
        if not positional:
            raise Usage("Usage: ardia browse flow rm <name> [--site s]")
        site = locate(root, positional[0], options.get("site"), page_url)
        removed = remove(root, site, positional[0])
        return Result({"site": site, "name": positional[0], "removed": removed},
                      f"✓ Removed flow {positional[0]} for {site}" if removed else f"No flow {positional[0]} for {site}")
    raise Usage(USAGE)


def runs_locally(args: list[str]) -> bool:
    return (args[:1] or ["list"])[0] in ("list", "show", "rm", "remove", "delete")


def hint(state, url: str | None) -> str | None:
    from ardia_cli import command_metrics

    config = getattr(state, "config", None)
    root = config.get("data_root") if isinstance(config, dict) else None
    site = site_of(url) if url else None
    if not root or site is None or not isinstance(getattr(state, "extras", None), dict):
        return None
    shown = state.extras.setdefault("flow_hinted", set())
    if site in shown:
        return None
    try:
        rows = [row for row in listing(Path(root), site) if not row.get("error")]
    except BrowseError:
        return None
    if not rows:
        return None
    shown.add(site)
    command_metrics.flag("flow_hint_shown", True)
    more = f"; … {len(rows) - HINT_LIMIT} more: `ardia browse flow list {site}`" if len(rows) > HINT_LIMIT else ""
    return (f"# saved flows for {site} (`ardia browse flow run <name> --param k=v`, `flow show <name>`): "
            + "; ".join(signature_line(row, HINT_DESCRIPTION) for row in rows[:HINT_LIMIT]) + more)


def parse_params(values: list[str] | None) -> dict:
    params = {}
    for item in values or []:
        key, sep, value = item.partition("=")
        if not sep or not key:
            raise Usage(f"--param takes name=value, not {item!r}")
        params[key.strip()] = value
    return params


def seq_of(value: str | None, what: str) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).lstrip("s"))
    except ValueError:
        raise Usage(f"{what} takes a step number from `flow steps`, not {value!r}") from None


def save_range(log: flowlog.Log, first: int | None, last: int | None) -> list[dict]:
    steps = list(log.steps)
    if last is None:
        last = steps[-1]["seq"] if steps else 0
    if first is None:
        fresh = [step for step in steps if step["seq"] > log.saved_through and step["seq"] <= last]
        opens = [step["seq"] for step in fresh if step["command"][0] == "open"]
        first = opens[-1] if opens else (fresh[0]["seq"] if fresh else last + 1)
    return [step for step in steps if first <= step["seq"] <= last]


def shown_url(url: str) -> str:
    from ardia_cli.browse.changes import masked_url

    return masked_url(redact_credentials(url)[0])


def masked_part(part: str, typed: dict) -> str:
    if typed.get("secret") and part == typed.get("value"):
        return REDACTED
    if re.match(r"(?i)^[a-z][a-z0-9+.-]*://", part) or re.match(r"(?i)^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?/.*[?#]", part):
        return shown_url(normalize_url(part))
    return part


def shown_command(step: dict) -> list[str]:
    typed = step.get("typed") or {}
    return [masked_part(part, typed) for part in step.get("replay") or step["command"]]


def step_line(step: dict) -> list[str]:
    status = "" if step.get("ok", True) else f"  ✗ {step.get('error') or 'failed'}"
    lines = [f"[{step['seq']}] {' '.join(shown_command(step))}  → {shown_url(step.get('url') or '') if step.get('url') else '(no page)'}{status}"]
    for request in step.get("requests") or []:
        kind = request.get("kind") or "json"
        body = "" if body_value(request) is not None else " (body dropped)"
        lines.append(f"    {request['id']} {request['method']} {shown_url(request['url'])} {request.get('status')} {kind}{body}")
    for write in step.get("writes") or []:
        lines.append(f"    write: {write['method']} {shown_url(write['url'])} {write.get('status') or 'pending'}")
    if step.get("why"):
        lines.append(f"    not replayable: {step['why']}")
    return lines


def steps_result(log: flowlog.Log, everything: bool) -> Result:
    steps = [step for step in log.steps if everything or step["seq"] > log.saved_through]
    rows = [{"seq": step["seq"], "command": shown_command(step), "url": shown_url(step["url"]) if step.get("url") else None, "ok": step.get("ok", True),
             "requests": [{"id": request["id"], "method": request["method"], "url": shown_url(request["url"]), "status": request.get("status"),
                           "kind": request.get("kind")} for request in step.get("requests") or []],
             "writes": len(step.get("writes") or [])} for step in steps]
    lines = [line for step in steps for line in step_line(step)]
    if log.dropped:
        lines.insert(0, f"({log.dropped} older steps dropped)")
    empty = ("Nothing recorded since the last save" if log.steps else "Nothing recorded yet: open a page and do the task once "
             "(open, click, fill, select, press …), then `flow save <name>`")
    return Result({"steps": rows, "savedThrough": log.saved_through, "dropped": log.dropped}, "\n".join(lines) or empty, page_content=True)


def save_text(name: str, path: Path, flow: dict, report: dict) -> str:
    lines = [f"✓ Saved flow {name} for {flow['site']} ({path})"]
    for request in report["requests"]:
        mark = " ← output" if request["id"] == report["output"] else ""
        detail = f", list {request['list']}" if request.get("list") else ""
        lines.append(f"  {request['id']} {request['method']} {shown_url(request['url'])} ({request['kind']}{detail}){mark}")
    for param in report["params"]:
        how = f"recorded {param['example']}" if param.get("example") else "no recorded value: runs pass it"
        lines.append(f"  param {param['name']} ({param['source']}; {how})")
    if not report["params"]:
        lines.append("  no params: name a typed or URL value with --param k=v to make one")
    for write in report["writes"]:
        lines.append(f"  write {write['id']}: {write['method']} {shown_url(write['url'])} ({write['kind']}); runs need --allow-write {write['id']}")
    for step in report["notReplayable"]:
        lines.append(f"  step {step['seq']} can't be replayed: {step['why']}")
    if report["redactedSteps"]:
        lines.append(f"  steps {', '.join(map(str, report['redactedSteps']))} held a secret, so it's redacted and the flow never replays them")
    for item in report["dropped"]:
        lines.append(f"  left out {item['id']}: {item['why']}")
    usage = " ".join(f"--param {param['name']}=…" for param in report["params"])
    lines.append(f"→ ardia browse flow run {name}" + (f" {usage}" if usage else "") + " [--fields a,b] [--where f=v] [--limit n]")
    return "\n".join(lines)


@command("flow")
async def cmd_flow(ctx, argv):
    from ardia_cli import __version__, command_metrics

    state = ctx.state
    root = Path(state.config["data_root"])
    action = argv[0] if argv else "list"
    rest = list(argv[1:])
    log = flowlog.log_of(state)
    if action == "steps":
        options, _ = parse(rest, {"--all": "bool"})
        return steps_result(log, bool(options.get("all")))
    if action == "save":
        options, positional = parse(rest, SAVE_FLAGS)
        if len(positional) != 1:
            raise Usage("Usage: ardia browse flow save <name> [--from n] [--to n] [--param k=v] [--output id] [--description text]")
        steps = save_range(log, seq_of(options.get("from"), "--from"), seq_of(options.get("to"), "--to"))
        flow, report = build_flow(positional[0], steps, parse_params(options.get("param")), options.get("output"), options.get("description"), __version__)
        path = save(root, flow)
        log.saved_through = max(log.saved_through, steps[-1]["seq"])
        state.extras.setdefault("flow_hinted", set()).add(flow["site"])
        command_metrics.flag("flow_saved", True)
        command_metrics.count("flow_requests_kept", len(report["requests"]))
        command_metrics.count("flow_params", len(report["params"]))
        command_metrics.count("flow_writes", len(report["writes"]))
        return Result({"flow": summary(flow), "path": str(path), **report}, save_text(positional[0], path, flow, report))
    if action == "run":
        from ardia_cli.browse import flowrun

        options, positional = parse(rest, RUN_FLAGS)
        if len(positional) != 1:
            raise Usage("Usage: ardia browse flow run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n] [--allow-write all|w1]")
        page = state.pages.get(state.current) if state.current else None
        site = locate(root, positional[0], options.get("site"), page.url if page else None)
        flow = load(root, site, positional[0])
        return await flowrun.run(ctx, root, flow, options)
    if runs_locally([action]):
        page = state.pages.get(state.current) if state.current else None
        return run_local(root, [action, *rest], page.url if page else None)
    raise Usage(USAGE)
