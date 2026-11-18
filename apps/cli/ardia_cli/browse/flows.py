import json
import os
import re
import stat
import time
from pathlib import Path
from urllib.parse import parse_qsl, quote, quote_plus, unquote, unquote_plus, urlsplit, urlunsplit

from ardia_cli.browse import flowlog, flowurl, paths
from ardia_cli.browse import shape as shaping
from ardia_cli.browse.commands import Result, command, normalize_url, parse
from ardia_cli.browse.errors import BrowseError, Usage
from ardia_cli.browse.flowurl import PARAM, Unsafe, carries, credential_key

VERSION = 1
DIR_NAME = "Flows"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PARAM_NAME = re.compile(r"[a-z][a-z0-9_]{0,23}")
FIELD_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,23}(\.[A-Za-z_][A-Za-z0-9_]{0,23})?")
MAX_DESCRIPTION = 120
HINT_DESCRIPTION = 80
MAX_FLOW = 4 * 1024 * 1024
REDACTED = "<redacted>"
MIN_SUBSTRING = 3
NOISE_KEY = re.compile(r"^(utm_.*|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_ga|_gl|ref|ref_src|spm|igshid)$", re.I)
SIGNATURE_DEPTH = 6
SIGNATURE_KEYS = 80
HINT_LIMIT = 5
KEY_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,31}")
SCRIPT_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}")
ANY_KEY = "*"
MAX_EXAMPLE = 40
MAX_WORD = 200
FIELDS = {"version", "name", "description", "site", "origin", "startUrl", "hosts", "createdAt", "createdBy", "params", "output", "verified",
          "steps"}
REQUIRED = ("version", "name", "site", "origin", "startUrl", "hosts", "params", "output", "steps")
STEP_FIELDS = {"seq", "command", "url", "ok", "requests"}
REQUEST_FIELDS = {"id", "method", "url", "headers", "kind", "expect", "strippedAuth"}
KEPT_HEADERS = {"accept"}
HEADER_VALUE = re.compile(r"[A-Za-z0-9/*+.,;= -]{0,100}")
SAVE_FLAGS = {"--from": "value", "--to": "value", "--param": "multi", "--output": "value", "--description": "value"}
RUN_FLAGS = {"--param": "multi", "--fields": "value", "--where": "multi", "--limit": "value", "--site": "value", "--timeout": "value"}
SITE_FLAGS = {"--site": "value"}
READ_ONLY = ("Flows are read-only for now: they keep and send GET requests only, and the answer in that range came from {methods}. "
             "Do this task in the page")
USAGE = ("Usage: ardia browse flow steps [--all] | save <name> [--from n] [--to n] [--param k=v] [--output id] [--description text]\n"
         "  | run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n]\n"
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


def is_local(host: str) -> bool:
    host = (host or "").lower()
    return host == "localhost" or host.endswith(".localhost")


def origin_allowed(url: flowurl.Url, start: flowurl.Url) -> bool:
    if url.port not in (start.port, flowurl.DEFAULT_PORTS[url.scheme]):
        return False
    if url.literal or start.literal or is_local(url.host) or is_local(start.host):
        return url.host == start.host and url.port == start.port
    return flowlog.base_domain(url.host) == flowlog.base_domain(start.host)


def key_ok(key, secrets=()) -> bool:
    return isinstance(key, str) and bool(KEY_NAME.fullmatch(key)) and not any(carries(key, secret) for secret in secrets)


def signature(value, depth: int = 0, secrets=()):
    if isinstance(value, dict):
        if depth >= SIGNATURE_DEPTH:
            return "object"
        shape = {}
        for key, inner in list(value.items())[:SIGNATURE_KEYS]:
            name = str(key) if key_ok(key, secrets) else ANY_KEY
            if name not in shape:
                shape[name] = signature(inner, depth + 1, secrets) if name != ANY_KEY else "any"
        return shape
    if isinstance(value, list):
        if depth >= SIGNATURE_DEPTH:
            return "array"
        return [signature(value[0], depth + 1, secrets)] if value else []
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
            if key == ANY_KEY:
                continue
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
    if recorded in ("null", "any") or value is None:
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
    return urlunsplit((parts.scheme, parts.netloc, path, query, ""))


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


def scrub(value, secrets: list[str]):
    if isinstance(value, str):
        return REDACTED if any(carries(value, secret) for secret in secrets) else value
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    return value


def example_ok(value: str, secrets: list[str]) -> bool:
    return flowurl.literal_ok(value) and not any(carries(value, secret) for secret in secrets)


def default_output(requests: list[dict]) -> str:
    pool = [request for request in requests if "{{" in request["url"]] or requests
    return max(pool, key=lambda request: request["expect"]["bytes"])["id"] if pool else ""


def body_value(request: dict):
    return flowlog.materialize(request)


def start_url(steps: list[dict]) -> str:
    first = steps[0]
    if first["command"][0] == "open" and str(first.get("url") or "").startswith(("http://", "https://")):
        return first["url"]
    return first.get("before") or ""


def request_values(url: str) -> set:
    parts = urlsplit(url)
    return {value for _, value in flowurl.query_pairs(parts.query)} | {unquote(segment) for segment in parts.path.split("/")}


def header_ok(name, value) -> bool:
    return name in KEPT_HEADERS and isinstance(value, str) and bool(HEADER_VALUE.fullmatch(value))


def safe_url(url: str, values: list[tuple[str, str]], secrets: list[str], start: flowurl.Url) -> str | None:
    try:
        parsed = flowurl.checked(template_url(url, values), secrets)
    except (Unsafe, ValueError):
        return None
    return parsed.text if origin_allowed(parsed, start) else None


def unsafe_reason(url: str, values: list[tuple[str, str]], secrets: list[str]) -> str:
    try:
        return flowurl.problem(flowurl.parse(template_url(url, values)), secrets) or "its URL isn't safe to keep"
    except (Unsafe, ValueError) as error:
        return f"its URL isn't safe to keep ({error})"


def build_flow(name: str, steps: list[dict], given: dict | None = None, output: str | None = None, description: str | None = None,
               tool_version: str = "", known_secrets=()) -> tuple[dict, dict]:
    given = dict(given or {})
    check_name(name)
    if not steps:
        raise BrowseError("No recorded steps in that range; `ardia browse flow steps --all` lists what this session recorded", code="no_steps")
    try:
        start = flowurl.parse(start_url(steps))
    except Unsafe as error:
        raise BrowseError(f"flow save needs a range that starts on a plain web page ({error}): begin it with `open <url>` or pick it with --from",
                          code="not_a_web_page") from None
    site = site_of(start.text)
    secrets = list(dict.fromkeys([*known_secrets, *log_secrets(steps)]))
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
        params.append({"name": candidate, "example": value if example and example_ok(value, secrets) else None, "source": source})
        named[value] = candidate
        return candidate

    for key in given:
        if not PARAM_NAME.fullmatch(key):
            raise Usage(f"A param name is 1 to 24 lowercase letters, digits and '_', starting with a letter, not {key!r}")
    by_given = {value: key for key, value in given.items()}
    for step in steps:
        typed = step.get("typed") or {}
        value = typed.get("value")
        if not value or typed.get("secret"):
            continue
        add(by_given.get(value) or typed.get("field") or "text", value, "typed", value in by_given)
    for key, value in given.items():
        if value not in named:
            add(key, value, "given", True)

    captured = []
    dropped = []
    unkept = [method for step in steps for method in step.get("unkept") or []]
    for step in steps:
        for request in step.get("requests") or []:
            if request.get("method") != "GET":
                unkept.append(str(request.get("method") or "?"))
                continue
            if body_value(request) is None:
                if request.get("evicted"):
                    dropped.append({"id": request["id"], "why": "its answer was dropped to keep the recording small; record it again"})
                continue
            try:
                parsed = flowurl.parse(request["url"])
            except Unsafe as error:
                dropped.append({"id": request["id"], "why": f"its URL isn't safe to keep ({error})"})
                continue
            if origin_allowed(parsed, start):
                captured.append((step, request))

    for url in [start.text] + [step.get("url") or "" for step in steps if step["command"][0] == "open"]:
        for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=False):
            if NOISE_KEY.match(key) or credential_key(key) or value in named:
                continue
            if any(value in request_values(request["url"]) for _, request in captured):
                add(key, value, "query", True)

    values = sorted(((param["name"], value) for value, param_name in named.items() for param in params if param["name"] == param_name),
                    key=lambda pair: len(pair[1]), reverse=True)
    kept_by_step: dict[int, list] = {}
    requests = []
    hosts = {start.origin}
    for step in steps:
        for origin in step.get("origins") or []:
            try:
                parsed = flowurl.parse(f"{origin}/")
            except Unsafe:
                continue
            if origin_allowed(parsed, start):
                hosts.add(parsed.origin)
    for step, request in captured:
        url = safe_url(request["url"], values, secrets, start)
        if url is not None and any(carries(f"{key} {value}", secret) for key, value in (request.get("headers") or {}).items() for secret in secrets):
            dropped.append({"id": request["id"], "why": "a header it sent carries a value typed into a secret field"})
            continue
        if url is None:
            dropped.append({"id": request["id"], "why": unsafe_reason(request["url"], values, secrets)})
            continue
        value = body_value(request)
        found = shaping.main_list(value)
        list_path = found[0] if found and found[0] and all(key_ok(part, secrets) for part in found[0].split(".")) else None
        expect = {"status": request.get("status"), "mime": request.get("mime") or "", "signature": signature(value, secrets=secrets),
                  "bytes": request.get("bytes") or 0, "list": list_path,
                  "itemFields": [field for field in shaping.item_fields(found[1]) if FIELD_NAME.fullmatch(field)
                                 and not any(carries(field, secret) for secret in secrets)] if found else []}
        if request.get("kind") == "document":
            spec = request.get("spec") or {}
            if "scriptId" in spec and not SCRIPT_ID.fullmatch(str(spec["scriptId"])):
                dropped.append({"id": request["id"], "why": "the page's JSON block has an id a flow doesn't keep"})
                continue
            expect["extract"] = spec
        kept = {"id": request["id"], "method": "GET", "url": url,
                "headers": {key: value for key, value in (request.get("headers") or {}).items() if header_ok(key, value)},
                "kind": request.get("kind") or "json", "expect": expect}
        if request.get("strippedAuth"):
            kept["strippedAuth"] = True
        kept_by_step.setdefault(step["seq"], []).append(kept)
        requests.append(kept)
        hosts.add(flowurl.parse(url).origin)
    if not requests:
        if unkept:
            raise BrowseError(READ_ONLY.format(methods=", ".join(sorted(set(unkept)))), data={"dropped": dropped}, code="flow_not_get")
        why = "; ".join(f"{item['id']}: {item['why']}" for item in dropped)
        raise BrowseError("Nothing to save: the steps in that range caused no first-party JSON answers or pages with embedded JSON a flow can keep "
                          f"(`flow steps` lists what each step caused){'; left out ' + why if why else ''}", data={"dropped": dropped}, code="nothing_to_save")
    if output is not None and output not in {request["id"] for request in requests}:
        raise Usage(f"--output {output} isn't one of the GET requests kept: {', '.join(request['id'] for request in requests)}")

    saved_steps = []
    for step in steps:
        command = [str(part) for part in step.get("replay") or step["command"]]
        typed = step.get("typed") or {}
        if typed.get("value"):
            shown = REDACTED if typed.get("secret") else placeholder(named[typed["value"]]) if typed["value"] in named else None
            command = [shown if shown and part == typed["value"] else part for part in command]
        command = [masked_part(part, {}, secrets, values) for part in scrub(command, secrets)]
        command = [part if len(part) <= MAX_WORD else part[:MAX_WORD] + "…" for part in command]
        page_url = step.get("url") or ""
        after = flowurl.mask(template_url(page_url, values), secrets) if page_url else ""
        saved_steps.append({"seq": step["seq"], "command": command, "url": after, "ok": bool(step.get("ok", True)),
                            "requests": kept_by_step.get(step["seq"], [])})
    start_saved = safe_url(start.text, values, secrets, start)
    flow = {
        "version": VERSION, "name": name, "description": " ".join(str(description or "").split())[:MAX_DESCRIPTION] or None, "site": site,
        "origin": start.origin, "startUrl": start_saved or start.origin + "/", "hosts": sorted(hosts),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "createdBy": {"tool": "ardia browse", "version": tool_version},
        "params": params, "output": output or default_output(requests), "verified": True, "steps": saved_steps,
    }
    report = {"requests": [{"id": request["id"], "method": request["method"], "url": request["url"], "kind": request["kind"],
                            "list": request["expect"]["list"]} for request in requests],
              "params": params, "dropped": dropped,
              "unkept": sorted(set(unkept)), "output": flow["output"]}
    return flow, report


def output_request(flow: dict) -> dict | None:
    return next((request for step in flow["steps"] if isinstance(step, dict) for request in step.get("requests") or []
                 if isinstance(request, dict) and request.get("id") == flow["output"]), None)


def invalid(why: str) -> BrowseError:
    return BrowseError(f"That flow file {why}; save the flow again", code="flow_invalid")


def strict(url, hosts: list, what: str) -> flowurl.Url:
    try:
        parsed = flowurl.checked(url)
    except Unsafe as error:
        raise invalid(f"has {what} that isn't safe ({error})") from None
    if parsed.origin not in hosts:
        raise invalid(f"has {what} on a host it doesn't list")
    return parsed


def check_command(command):
    if command is None:
        return
    if not isinstance(command, list) or not command or not all(isinstance(part, str) and len(part) <= MAX_WORD + 1 for part in command):
        raise invalid("has a step that isn't a short list of words")


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
    try:
        start = flowurl.parse(flow["startUrl"])
    except Unsafe as error:
        raise invalid(f"has a start URL that isn't safe ({error})") from None
    if (site is not None and flow["site"] != site) or (name is not None and flow["name"] != name) or site_of(start.text) != flow["site"]:
        raise invalid("has a site or name that doesn't match where it's stored")
    if flow["origin"] != start.origin:
        raise invalid("has an origin that isn't its start URL's")
    hosts = flow["hosts"]
    if not isinstance(hosts, list) or start.origin not in hosts:
        raise invalid("doesn't list its start URL's host")
    for host in hosts:
        try:
            parsed = flowurl.parse(f"{host}/") if isinstance(host, str) else None
        except Unsafe:
            parsed = None
        if parsed is None or parsed.origin != host or not origin_allowed(parsed, start):
            raise invalid(f"allows {str(host)[:60]}, which isn't on {flow['site']} or is another local or IP address")
    strict(flow["startUrl"], hosts, "a start URL")
    description = flow.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > MAX_DESCRIPTION or "\n" in description):
        raise invalid("has a description longer than one short line")
    if not isinstance(flow["params"], list) or not all(isinstance(param, dict) and isinstance(param.get("name"), str)
                                                        and PARAM_NAME.fullmatch(param["name"]) for param in flow["params"]):
        raise invalid("has a param whose name isn't a short identifier")
    for param in flow["params"]:
        example = param.get("example")
        if example is not None and (not isinstance(example, str) or not flowurl.literal_ok(example)):
            raise invalid("has a param example that isn't a short word")
    if not isinstance(flow["steps"], list):
        raise invalid("has no list of steps")
    for step in flow["steps"]:
        if not isinstance(step, dict) or not set(step) <= STEP_FIELDS:
            raise invalid("has a step with fields a flow doesn't have")
        check_command(step.get("command"))
        for request in step.get("requests") or []:
            if not isinstance(request, dict) or not set(request) <= REQUEST_FIELDS:
                raise invalid("has a request with fields a flow doesn't keep (a body?)")
            if request.get("method") != "GET":
                raise invalid("has a request that isn't a GET; flows are read-only")
            strict(request.get("url"), hosts, "a request URL")
            headers = request.get("headers") or {}
            if not isinstance(headers, dict) or not all(header_ok(key, value) for key, value in headers.items()):
                raise invalid("has a request header a flow doesn't keep")
            fields = (request.get("expect") or {}).get("itemFields") or []
            if not all(isinstance(field, str) and FIELD_NAME.fullmatch(field) for field in fields):
                raise invalid("has an item field that isn't a short identifier")
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
            "itemFields": (request.get("expect") or {}).get("itemFields") or [], "verified": bool(flow.get("verified", True))}


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
                                             "unverified" if not row["verified"] else "") if part)
        lines.append(f"{row['site']}  {signature_line(row)}" + (f"  [{extra}]" if extra else ""))
    return "\n".join(lines) or "No saved flows yet (`ardia browse flow save <name>` after doing the task once)"


def show_text(flow: dict) -> str:
    lines = [f"{flow['name']} on {flow['site']}" + (f" [saved description: {json.dumps(flow['description'], ensure_ascii=False)}]" if flow.get("description") else ""),
             f"start: {flow['startUrl']}"]
    for param in flow["params"]:
        example = f" (recorded: {param['example']})" if param.get("example") else " (required)"
        lines.append(f"param {param['name']} [{param.get('source')}]{example}")
    for step in flow["steps"]:
        command = " ".join(step["command"]) if step.get("command") else "(a step with no command)"
        lines.append(f"[{step['seq']}] {command}")
        for request in step.get("requests") or []:
            mark = " ← output" if request["id"] == flow["output"] else ""
            lines.append(f"    {request['id']} {request['method']} {request['url']} ({request['kind']}){mark}")
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


def masked_part(part: str, typed: dict, secrets=(), values=()) -> str:
    if (typed.get("secret") and part == typed.get("value")) or any(part == secret for secret in secrets):
        return REDACTED
    if re.match(r"(?i)^[a-z][a-z0-9+.-]*://", part) or re.match(r"(?i)^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?/", part):
        return flowurl.mask(template_url(normalize_url(part), list(values)) if values else normalize_url(part), secrets)
    return REDACTED if any(carries(part, secret) for secret in secrets) else part


def log_secrets(steps) -> list[str]:
    return [step["typed"]["value"] for step in steps if (step.get("typed") or {}).get("secret") and step["typed"].get("value")]


def shown_command(step: dict, secrets=()) -> list[str]:
    typed = step.get("typed") or {}
    return [masked_part(str(part), typed, secrets) for part in step.get("replay") or step["command"]]


def step_line(step: dict, secrets=()) -> list[str]:
    status = "" if step.get("ok", True) else f"  ✗ {step.get('error') or 'failed'}"
    page = flowurl.mask(step["url"], secrets) if step.get("url") else "(no page)"
    lines = [f"[{step['seq']}] {' '.join(shown_command(step, secrets))}  → {page}{status}"]
    for request in step.get("requests") or []:
        kind = request.get("kind") or "json"
        body = "" if body_value(request) is not None else " (answer dropped)"
        lines.append(f"    {request['id']} GET {flowurl.mask(request['url'], secrets)} {request.get('status')} {kind}{body}")
    unkept = step.get("unkept") or []
    if unkept:
        lines.append(f"    not kept (flows are read-only): {', '.join(sorted(set(unkept)))} ×{len(unkept)}")
    return lines


def steps_result(log: flowlog.Log, everything: bool) -> Result:
    secrets = log.known_secrets()
    steps = [step for step in log.steps if everything or step["seq"] > log.saved_through]
    rows = [{"seq": step["seq"], "command": shown_command(step, secrets), "url": flowurl.mask(step["url"], secrets) if step.get("url") else None,
             "ok": step.get("ok", True),
             "requests": [{"id": request["id"], "method": "GET", "url": flowurl.mask(request["url"], secrets), "status": request.get("status"),
                           "kind": request.get("kind")} for request in step.get("requests") or []],
             "notKept": len(step.get("unkept") or [])} for step in steps]
    lines = [line for step in steps for line in step_line(step, secrets)]
    if log.dropped:
        lines.insert(0, f"({log.dropped} older steps dropped)")
    empty = ("Nothing recorded since the last save" if log.steps else "Nothing recorded yet: open a page and do the task once "
             "(open, click, fill, select, press …), then `flow save <name>`")
    return Result({"steps": rows, "savedThrough": log.saved_through, "dropped": log.dropped}, "\n".join(lines) or empty, page_content=True)


def save_text(name: str, path: Path, flow: dict, report: dict, secrets=()) -> str:
    lines = [f"✓ Saved flow {name} for {flow['site']} ({path})"]
    for request in report["requests"]:
        mark = " ← output" if request["id"] == report["output"] else ""
        detail = f", list {request['list']}" if request.get("list") else ""
        lines.append(f"  {request['id']} GET {flowurl.mask(request['url'], secrets)} ({request['kind']}{detail}){mark}")
    for param in report["params"]:
        shown = param.get("example") and not any(carries(param["example"], secret) for secret in secrets)
        how = f"recorded {param['example']}" if shown else "no recorded value: runs pass it"
        lines.append(f"  param {param['name']} ({param['source']}; {how})")
    if not report["params"]:
        lines.append("  no params: name a typed or URL value with --param k=v to make one")
    for item in report["dropped"]:
        lines.append(f"  left out {item['id']}: {item['why']}")
    if report["unkept"]:
        lines.append(f"  not kept: {', '.join(report['unkept'])} requests (flows are read-only)")
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
        flow, report = build_flow(positional[0], steps, parse_params(options.get("param")), options.get("output"), options.get("description"), __version__,
                                  log.known_secrets())
        validate(flow)
        path = save(root, flow)
        log.saved_through = max(log.saved_through, steps[-1]["seq"])
        state.extras.setdefault("flow_hinted", set()).add(flow["site"])
        command_metrics.flag("flow_saved", True)
        command_metrics.count("flow_requests_kept", len(report["requests"]))
        command_metrics.count("flow_params", len(report["params"]))
        return Result({"flow": summary(flow), "path": str(path), **report}, save_text(positional[0], path, flow, report, log.known_secrets()))
    if action == "run":
        from ardia_cli.browse import flowrun

        options, positional = parse(rest, RUN_FLAGS)
        if len(positional) != 1:
            raise Usage("Usage: ardia browse flow run <name> [--param k=v] [--fields a,b.c] [--where f=v] [--limit n]")
        page = state.pages.get(state.current) if state.current else None
        site = locate(root, positional[0], options.get("site"), page.url if page else None)
        flow = load(root, site, positional[0])
        return await flowrun.run(ctx, root, flow, options)
    if runs_locally([action]):
        page = state.pages.get(state.current) if state.current else None
        return run_local(root, [action, *rest], page.url if page else None)
    raise Usage(USAGE)
