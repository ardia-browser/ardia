import asyncio
import json
from pathlib import Path

from ardia_cli import command_metrics
from ardia_cli.browse import flowlog, flows, flowurl
from ardia_cli.browse import shape as shaping
from ardia_cli.browse.commands import Result
from ardia_cli.browse.errors import BrowseError, OutcomeUnknown, Usage
from ardia_cli.browse.limits import seconds_of

RUN_TIMEOUT = 60.0
BODY_LIMIT = 8 * 1024 * 1024
CHALLENGE_SCAN = 20000
FETCH = """async (url, headers, timeoutMs, limit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", headers, credentials: "include", cache: "no-store", redirect: "manual",
      signal: controller.signal });
    const text = response.type === "opaqueredirect" ? "" : await response.text();
    return { status: response.status, type: response.type, url: response.url, mime: response.headers.get("content-type") || "",
      retryAfter: response.headers.get("retry-after"), text: text.length > limit ? null : text };
  } catch (error) {
    return { error: String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}"""


class Outcome:
    def __init__(self, kind: str, why: str = "", value=None, error: BrowseError | None = None, drift: str | None = None):
        self.kind = kind
        self.why = why
        self.value = value
        self.error = error
        self.drift = drift


def resolve_params(flow: dict, given: dict) -> dict:
    known = {param["name"]: param for param in flow["params"]}
    unknown = [name for name in given if name not in known]
    if unknown:
        listed = ", ".join(known) or "none"
        raise Usage(f"{flow['name']} has no param {', '.join(unknown)}; its params are: {listed}")
    values = {name: param["example"] for name, param in known.items() if param.get("example") is not None}
    values.update(given)
    missing = [name for name in known if name not in values]
    if missing:
        raise Usage(f"{flow['name']} needs " + " ".join(f"--param {name}=…" for name in missing) + " (no recorded value is kept for typed text)")
    return values


def challenge(text: str | None) -> bool:
    from ardia_cli.browse.readpages import CHALLENGE

    return bool(text) and bool(CHALLENGE.search(text[:CHALLENGE_SCAN]))


def parsed(request: dict, text: str | None):
    if text is None:
        return None
    if request["kind"] == "document":
        spec = request["expect"].get("extract")
        return flowlog.extract_embedded(text, spec) if spec else None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, (dict, list)) else None


DRIVE = "Drive the page yourself (open, click, read) for this task"


def failed(message: str, code: str, data: dict | None = None) -> Outcome:
    return Outcome("stop", error=BrowseError(f"{message}. {DRIVE}", data=data, code=code))


def classify(flow: dict, request: dict, answer: dict) -> Outcome:
    status = answer.get("status")
    if answer.get("error"):
        return failed(f"The flow's request failed in the page ({answer['error']})", "fetch_failed")
    if answer.get("type") == "opaqueredirect" or (status and 300 <= status < 400):
        return failed("The flow's request was redirected (the site may want a sign-in, or the endpoint moved), and a flow never follows "
                      "a redirect", "redirected")
    if status in (401, 403):
        if request.get("strippedAuth"):
            return failed(f"HTTP {status}: the recording sent a credential header a flow never keeps", "credential_not_sendable",
                          {"httpStatus": status})
        return failed(f"HTTP {status}: the session is signed out of {flow['site']} or lacks access. Sign in again in Ardia and rerun",
                      "auth_expired", {"httpStatus": status})
    if status == 429:
        return failed(f"HTTP 429: {flow['site']} is rate limiting this session; wait before running it again", "rate_limited",
                      {"httpStatus": 429, "retryAfter": answer.get("retryAfter")})
    html = "html" in (answer.get("mime") or "").lower()
    if html and challenge(answer.get("text")):
        return failed(f"{flow['site']} answered with a bot check instead of data; let the user clear it", "blocked", {"httpStatus": status})
    if not status or not 200 <= status < 300:
        return failed(f"HTTP {status} for GET {flowurl.mask(request['url'])}", "http_error", {"httpStatus": status})
    if answer.get("text") is None:
        return failed("The flow's answer was too large to read", "answer_too_large")
    value = parsed(request, answer.get("text"))
    changed = "the answer isn't the recorded JSON any more" if value is None else flows.drift(request["expect"].get("signature"), value)
    if changed is None and flows.list_gone(request["expect"].get("list"), value):
        changed = f"the list {request['expect']['list']} is gone"
    if changed:
        outcome = failed(f"{flow['name']} drifted: {changed}. Save the flow again after doing the task in the page", "drifted",
                         {"drift": changed})
        outcome.drift = changed
        return outcome
    return Outcome("ok", value=value)


async def page_tier(ctx, flow: dict, values: dict, url: str, headers: dict, deadline: float) -> dict:
    from ardia_cli.browse import readpages, temptabs
    from ardia_cli.browse.commands import borrowed_tab

    state = ctx.state
    loop = asyncio.get_running_loop()
    await state.connect()
    target = flowurl.parse(url).origin
    start = flows.fill_url(flow["startUrl"], values)
    home = flowurl.parse(start).origin
    current = state.pages.get(state.current) if state.current else None
    opened: list[str] = []

    def origin(page_url: str) -> str | None:
        try:
            return flowurl.parse(page_url).origin
        except flowurl.Unsafe:
            return None

    try:
        own = current is not None and current.target_id in state.opened and borrowed_tab(state) != current.target_id
        if own and current.session_id and origin(current.url) in (target, home):
            page = current
        else:
            await temptabs.sweep(state)
            page = await readpages.open_reader(state, opened)
            await readpages.goto(ctx, page, start, max(deadline - loop.time(), 1.0))
            if origin(page.url) not in flow["hosts"]:
                return {"landed": flowurl.host_label(page.url)}
        remaining = max(deadline - loop.time(), 1.0)
        sent = {key: value for key, value in headers.items() if key == "accept" and flows.header_ok(key, value)}
        try:
            answer = await page.call(FETCH, url, sent, int(remaining * 1000), BODY_LIMIT, frame=page.main_frame, read=False, timeout=remaining + 5)
        except OutcomeUnknown:
            return {"interrupted": True}
        except BrowseError as error:
            if error.code in ("document_changed", "page_navigated", "tab_detached"):
                return {"interrupted": True}
            raise
        return answer or {"error": "no answer from the page"}
    finally:
        if opened:
            await temptabs.release(state, opened)


async def run(ctx, root: Path, flow: dict, options: dict) -> Result:
    values = resolve_params(flow, flows.parse_params(options.get("param")))
    shape = shaping.parse_shape(options.get("fields"), options.get("where"), options.get("limit"))
    timeout = seconds_of(options.get("timeout")) if options.get("timeout") else RUN_TIMEOUT
    if timeout is None:
        raise Usage("--timeout takes 30s, 2m or milliseconds")
    request = flows.output_request(flow)
    if request.get("method") != "GET":
        raise BrowseError("Flows are read-only for now; this flow's request isn't a GET, so it wasn't sent. Save it again", code="flow_not_get")
    url = flows.fill_url(request["url"], values)
    try:
        if flowurl.parse(url).origin not in flow["hosts"]:
            raise flowurl.Unsafe("its host isn't one the flow lists")
    except flowurl.Unsafe as error:
        raise BrowseError(f"With these params the flow's request isn't safe to send ({error}); nothing was sent", code="off_site") from None
    deadline = asyncio.get_running_loop().time() + timeout
    answer = await page_tier(ctx, flow, values, url, request.get("headers") or {}, deadline)
    if answer.get("landed"):
        raise BrowseError(f"The flow's start page went to {answer['landed']}, off {flow['site']} (a sign-in page?). Sign in, or drive the page "
                          "yourself (open, click, read)", data={"landed": answer["landed"]}, code="redirected")
    if answer.get("interrupted"):
        raise BrowseError("The page navigated or closed while the flow's GET was in flight, so whether it reached the site is unknown and it "
                          "wasn't sent again. Drive the page yourself (open, click, read) for this task", code="fetch_interrupted")
    outcome = classify(flow, request, answer)
    if outcome.kind != "ok":
        if outcome.drift:
            mark(root, flow, False)
            command_metrics.flag("flow_drifted", True)
        raise outcome.error
    mark(root, flow, True)
    command_metrics.flag("flow_run_page", True)
    command_metrics.flag("flow_shaped", not shape.empty)
    shaped = shaping.apply(outcome.value, shape, always=True, path=request["expect"].get("list"))
    if shaped.get("items") is not None:
        command_metrics.count("flow_items", len(shaped["items"]))
    data = {"flow": flow["name"], "site": flow["site"], "verified": True, "result": shaped}
    return Result(data, run_text(flow, shaped), page_content=True)


def mark(root: Path, flow: dict, verified: bool):
    if bool(flow.get("verified", True)) == verified:
        return
    flow["verified"] = verified
    try:
        flows.save(root, flow)
    except BrowseError:
        pass


def run_text(flow: dict, shaped: dict) -> str:
    from ardia_cli.browse.commands import render_json

    if shaped.get("items") is None:
        return f"✓ {flow['name']}\n{render_json(shaped.get('value'))}"
    where = f" in {shaped['list']}" if shaped.get("list") else ""
    counted = f"{len(shaped['items'])} of {shaped['matched']} matching" if shaped["matched"] != shaped["total"] else f"{len(shaped['items'])} of {shaped['total']}"
    return f"✓ {flow['name']}: {counted} items{where}\n" + (render_json(shaped["items"]) if shaped["items"] else "(no items)")
