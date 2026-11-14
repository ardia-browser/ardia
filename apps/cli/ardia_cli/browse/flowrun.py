import asyncio
import json
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from ardia_cli import command_metrics
from ardia_cli.browse import flowlog, flows
from ardia_cli.browse import shape as shaping
from ardia_cli.browse.commands import Result, normalize_url
from ardia_cli.browse.errors import BrowseError, ConnectionLost, OutcomeUnknown, Usage
from ardia_cli.browse.limits import seconds_of

RUN_TIMEOUT = 60.0
BODY_LIMIT = 8 * 1024 * 1024
TIERS = ("page", "replay")
CHALLENGE_SCAN = 20000
FETCH = """async (url, method, headers, body, timeoutMs, limit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body: body === null ? undefined : body, credentials: "include", cache: "no-store",
      redirect: "manual", signal: controller.signal });
    const text = response.type === "opaqueredirect" ? "" : await response.text();
    return { sent: true, status: response.status, type: response.type, url: response.url, mime: response.headers.get("content-type") || "",
      retryAfter: response.headers.get("retry-after"), text: text.length > limit ? null : text, size: text.length };
  } catch (error) {
    return { sent: false, error: String(error && error.message || error), aborted: controller.signal.aborted };
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


def allowed_writes(value: str | None, flow: dict) -> set:
    if not value:
        return set()
    ids = {write["id"] for write in flow.get("writes") or []}
    if value.strip() == "all":
        return ids
    wanted = {item.strip() for item in value.split(",") if item.strip()}
    unknown = wanted - ids
    if unknown:
        raise Usage(f"--allow-write takes all or write ids of this flow ({', '.join(sorted(ids)) or 'it has none'}), not {', '.join(sorted(unknown))}")
    return wanted


def on_site(flow: dict, url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    return flowlog.base_domain(parts.hostname or "") == flowlog.base_domain(urlsplit(flow["origin"]).hostname or "")


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc.rpartition('@')[2].lower()}"


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


def unknown(message: str, data: dict | None = None) -> BrowseError:
    return BrowseError(message, data=data, code="outcome_unknown")


def classify(flow: dict, request: dict, answer: dict, write: bool) -> Outcome:
    status = answer.get("status")
    if answer.get("error"):
        if write:
            return Outcome("stop", error=unknown(f"The write {request['method']} got no answer ({answer['error']}); it may have been applied, "
                                                 "so it wasn't sent again. Check the site before running it again"))
        return Outcome("next", f"the request failed: {answer['error']}")
    if answer.get("type") == "opaqueredirect" or (status and 300 <= status < 400):
        if write:
            return Outcome("stop", error=unknown("The write was answered with a redirect, so whether it was applied is unknown; it wasn't sent "
                                                 "again. Check the site"))
        return Outcome("next", "the request was redirected, which the page tier doesn't follow")
    if answer.get("url") and not on_site(flow, answer["url"]):
        return Outcome("stop", error=BrowseError(f"The request was redirected off {flow['site']}, so its answer was dropped", code="off_site"))
    if status in (401, 403):
        if request.get("strippedAuth"):
            return Outcome("next", f"HTTP {status}: the recording sent a credential header a flow never keeps", drift=None)
        return Outcome("stop", error=BrowseError(f"HTTP {status}: the session is signed out of {flow['site']} or lacks access. Sign in again in "
                                                 "Ardia, then run the flow again", data={"httpStatus": status}, code="auth_expired"))
    if status == 429:
        return Outcome("stop", error=BrowseError(f"HTTP 429: {flow['site']} is rate limiting this session; wait before running it again",
                                                 data={"httpStatus": 429, "retryAfter": answer.get("retryAfter")}, code="rate_limited"))
    html = "html" in (answer.get("mime") or "").lower()
    if write and (status in (408,) or (status or 0) >= 500):
        return Outcome("stop", error=BrowseError(f"The write got HTTP {status}; it may have been applied, so it wasn't sent again. Check the site",
                                                 data={"httpStatus": status}, code="outcome_unknown"))
    if not status or not 200 <= status < 300:
        if write and status and 400 <= status < 500:
            return Outcome("next", f"the write was refused with HTTP {status}")
        if not write and html and challenge(answer.get("text")):
            return Outcome("stop", error=BrowseError(f"{flow['site']} answered with a bot check instead of data; continue in the page or let "
                                                     "the user clear it", data={"httpStatus": status}, code="blocked"))
        if (status or 0) >= 500:
            return Outcome("next", f"HTTP {status}")
        return Outcome("stop", error=BrowseError(f"HTTP {status} for {request['method']} {urlsplit(request['url']).path}", data={"httpStatus": status},
                                                 code="http_error"))
    if answer.get("text") is None:
        if write:
            return Outcome("stop", error=unknown("The write was answered, but the answer was too large to read; it wasn't sent again. Check the site"))
        return Outcome("next", "the answer was too large to read")
    if request["kind"] == "json" and html and challenge(answer.get("text")):
        if write:
            return Outcome("stop", error=BrowseError("The write was answered with a bot check page; whether it was applied is unknown", code="outcome_unknown"))
        return Outcome("stop", error=BrowseError(f"{flow['site']} answered with a bot check instead of data; continue in the page or let the user "
                                                 "clear it", code="blocked"))
    value = parsed(request, answer.get("text"))
    if value is None:
        if write:
            return Outcome("stop", error=BrowseError("The write was answered with something that isn't JSON (a sign-in page?), so whether it was "
                                                     "applied is unknown", code="outcome_unknown"))
        return Outcome("next", "the answer isn't the recorded JSON any more", drift="the answer isn't JSON")
    changed = flows.drift(request["expect"].get("signature"), value)
    if changed is None and flows.list_gone(request["expect"].get("list"), value):
        changed = f"the list {request['expect']['list']} is gone"
    if changed and not write:
        return Outcome("next", f"the answer's shape changed: {changed}", drift=changed)
    return Outcome("ok", value=value, drift=changed)


async def page_tier(ctx, flow: dict, values: dict, url: str, method: str, headers: dict, body: str | None, write: bool, deadline: float) -> dict:
    from ardia_cli.browse import readpages, temptabs

    state = ctx.state
    loop = asyncio.get_running_loop()
    await state.connect()
    target = origin_of(url)
    current = state.pages.get(state.current) if state.current else None
    opened: list[str] = []
    try:
        if current is not None and current.session_id and current.url.startswith(("http://", "https://")) and origin_of(current.url) == target:
            page = current
        else:
            await temptabs.sweep(state)
            page = await readpages.open_reader(state, opened)
            start = flows.fill_url(flow["startUrl"], values)
            landing = start if origin_of(start) == target and "<redacted>" not in start else target + "/"
            await readpages.goto(ctx, page, landing, max(deadline - loop.time(), 1.0))
            if not page.url.startswith(("http://", "https://")) or origin_of(page.url) != target:
                return {"skip": f"the background tab landed on {origin_of(page.url) if page.url.startswith('http') else page.url}, not {target}"}
        remaining = max(deadline - loop.time(), 1.0)
        answer = await page.call(FETCH, url, method, headers, body, int(remaining * 1000), BODY_LIMIT, frame=page.main_frame, read=not write,
                                 timeout=remaining + 5)
        return answer or {"error": "no answer from the page"}
    finally:
        if opened:
            await temptabs.release(state, opened)


def same_request(request: dict, url: str, method: str, candidate: dict) -> bool:
    if candidate.get("method") != method:
        return False
    try:
        want, got = urlsplit(url), urlsplit(candidate.get("url") or "")
    except ValueError:
        return False
    if (want.netloc.lower(), want.path) != (got.netloc.lower(), got.path):
        return False
    have = set(parse_qsl(got.query, keep_blank_values=True))
    return set(parse_qsl(want.query, keep_blank_values=True)) <= have


def replay_commands(flow: dict, values: dict) -> list[list[str]]:
    commands = []
    for step in flow["steps"]:
        command = [flows.fill_text(part, values) for part in step["command"]]
        if command[0] == "open" and len(command) > 1:
            command[1] = flows.fill_url(normalize_url(step["command"][1]), values)
            if not on_site(flow, command[1]):
                raise BrowseError(f"The recorded `open` goes to {origin_of(command[1])}, off {flow['site']}; save the flow again", code="off_site")
        commands.append(command)
    return commands


async def own_tab(state, target_id: str | None):
    from ardia_cli.browse.commands import borrowed_tab

    if not target_id or target_id not in state.opened or borrowed_tab(state) == target_id:
        return None
    page = await state.page(target_id)
    return page if await page.takes_input() else None


async def replay_tier(ctx, flow: dict, values: dict, request: dict, url: str, allowed: set, deadline: float, replay_note: list) -> dict:
    from ardia_cli.browse import readpages, temptabs
    from ardia_cli.browse.daemon import run_one

    if not flow.get("replayable"):
        why = [f"step {step['seq']}: {step.get('why')}" for step in flow["steps"] if not step.get("command")]
        if flow.get("redactedSteps"):
            why.append("a step held a secret, which a flow never stores")
        return {"skip": "the recorded commands can't be replayed (" + "; ".join(why or ["a URL held a credential"]) + ")"}
    unallowed = [write["id"] for write in flow.get("writes") or [] if write["id"] not in allowed]
    if unallowed:
        return {"skip": f"replaying the commands sends write {', '.join(unallowed)}; pass --allow-write {','.join(unallowed)} to let it"}
    commands = replay_commands(flow, values)
    start = flows.fill_url(flow["startUrl"], values)
    if commands and commands[0][0] != "open" and "<redacted>" in start:
        return {"skip": "the start URL held a credential, which a flow never stores"}
    state = ctx.state
    await state.connect()
    await temptabs.sweep(state)
    previous = state.current
    opened: list[str] = []
    replayed: list[dict] = []
    state.extras["flow_replay"] = replayed
    try:
        page = await readpages.open_reader(state, opened)
        state.current = page.target_id
        answer = await replay_in(ctx, flow, values, page, commands, start, replayed, deadline)
        if answer.get("needs_input"):
            own = await own_tab(state, previous)
            if own is None:
                return {"skip": "this Ardia doesn't deliver input to background tabs, so the replay needs a tab of this session's that "
                                "takes input: `ardia browse open <url> --show`, then run the flow again"}
            await temptabs.release(state, opened)
            state.current = own.target_id
            replay_note.append(f"the replay ran in this session's tab [{state.tab_id(own.target_id)}], since background tabs don't take input here")
            answer = await replay_in(ctx, flow, values, own, commands, start, replayed, deadline)
        if answer:
            return answer
    finally:
        state.extras.pop("flow_replay", None)
        state.current = previous if previous is None or previous in state.target_infos or previous in state.pages else None
        await temptabs.release(state, opened)
    found = [candidate for step in replayed for candidate in step.get("requests") or [] if same_request(request, url, request["method"], candidate)]
    if not found:
        return {"replay_failed": "the replayed commands never sent the recorded request", "maybe_sent": bool(state_writes(replayed))}
    answer = found[-1]
    return {"sent": True, "status": answer.get("status"), "mime": answer.get("mime"), "text": answer.get("text"), "url": answer.get("url"),
            "extraWrites": len(state_writes(replayed))}


NO_INPUT_NEEDED = {"open", "wait", "back", "forward", "reload", "pushstate"}


async def replay_in(ctx, flow: dict, values: dict, page, commands: list, start: str, replayed: list, deadline: float) -> dict:
    from ardia_cli.browse import readpages
    from ardia_cli.browse.daemon import run_one

    loop = asyncio.get_running_loop()
    if commands and commands[0][0] != "open":
        await readpages.goto(ctx, page, start, max(deadline - loop.time(), 1.0))
    checked = False
    for command in commands:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return {"error": "the run's time is up", "maybe_sent": bool(state_writes(replayed))}
        if not checked and command[0] not in NO_INPUT_NEEDED:
            checked = True
            if not await page.takes_input():
                if state_writes(replayed):
                    return {"replay_failed": "this tab doesn't take input, and the replay had already sent a write", "maybe_sent": True}
                replayed.clear()
                return {"needs_input": True}
        try:
            _, error = await asyncio.wait_for(run_one(ctx, command, {"no_text": True}), remaining)
        except asyncio.TimeoutError:
            return {"error": f"`{command[0]}` didn't finish in the run's time", "maybe_sent": bool(state_writes(replayed))}
        if isinstance(error, (OutcomeUnknown, ConnectionLost)):
            raise error
        extra = unlisted_writes(flow, values, state_writes(replayed))
        if extra:
            return {"unlisted": extra, "maybe_sent": True}
        if error is not None:
            return {"replay_failed": f"`{' '.join(command[:2])}` failed: {error.message}", "maybe_sent": bool(state_writes(replayed))}
        current = ctx.state.pages.get(ctx.state.current)
        if current is not None and current.url.startswith("http") and not on_site(flow, current.url):
            return {"replay_failed": f"the replay left {flow['site']} for {origin_of(current.url)}"}
    return {}


def state_writes(replayed: list[dict]) -> list:
    return [write for step in replayed for write in step.get("writes") or []]


def write_key(method: str, url: str) -> tuple:
    try:
        parts = urlsplit(url)
    except ValueError:
        return (method, "", "")
    return (str(method).upper(), parts.netloc.lower(), parts.path)


def unlisted_writes(flow: dict, values: dict, seen: list[dict]) -> list[str]:
    listed = {write_key(write["method"], flows.fill_url(write["url"], values)) for write in flow.get("writes") or []}
    return [f"{write['method']} {urlsplit(write['url']).netloc}{urlsplit(write['url']).path}" for write in seen
            if write_key(write["method"], write["url"]) not in listed]


def write_id(flow: dict, request: dict) -> str | None:
    return next((write["id"] for write in flow.get("writes") or [] if write.get("request") == request["id"]), None)


async def run(ctx, root: Path, flow: dict, options: dict) -> Result:
    values = resolve_params(flow, flows.parse_params(options.get("param")))
    shape = shaping.parse_shape(options.get("fields"), options.get("where"), options.get("limit"))
    allowed = allowed_writes(options.get("allow_write"), flow)
    tier_choice = options.get("tier")
    if tier_choice and tier_choice not in TIERS:
        raise Usage(f"--tier takes {' or '.join(TIERS)}")
    timeout = seconds_of(options.get("timeout")) if options.get("timeout") else RUN_TIMEOUT
    if timeout is None:
        raise Usage("--timeout takes 30s, 2m or milliseconds")
    request = flows.output_request(flow)
    url = flows.fill_url(request["url"], values)
    body = flows.fill_body(request.get("body"), request.get("bodyType"), values)
    if flows.PARAM.search(url + (body or "")):
        raise BrowseError("A placeholder in the flow has no param to fill it; save the flow again", code="flow_invalid")
    if not on_site(flow, url) or urlsplit(url).netloc.lower() not in flow["hosts"]:
        raise BrowseError(f"The flow's request goes to {origin_of(url)}, off {flow['site']}; it wasn't sent", code="off_site")
    write = flowlog.write_kind(request["method"], url, body) is not None
    if write:
        wid = write_id(flow, request)
        if wid is None:
            raise BrowseError("With these params the flow's request is a write the recording didn't list, so it wasn't sent; save the flow again",
                              code="write_not_allowed")
        if wid not in allowed:
            raise BrowseError(f"The flow's answer comes from write {wid} ({request['method']} {urlsplit(url).path}); nothing was sent. "
                              f"Pass --allow-write {wid} to send it", data={"write": wid}, code="write_not_allowed")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    fell_back: list[dict] = []
    notes: list[str] = []
    drifts: list[dict] = []
    winner = None
    credential = False
    for tier in [tier_choice] if tier_choice else TIERS:
        if loop.time() >= deadline:
            fell_back.append({"tier": tier, "why": "the run's time is up"})
            break
        if tier == "page":
            answer = await page_tier(ctx, flow, values, url, request["method"], request.get("headers") or {}, body, write, deadline)
        else:
            answer = await replay_tier(ctx, flow, values, request, url, allowed, deadline, notes)
        if answer.get("unlisted"):
            raise unknown(f"The replay sent writes the flow doesn't list ({', '.join(answer['unlisted'][:5])}), so it stopped. Check the site; "
                          "save the flow again if the page changed", {"writes": answer["unlisted"], "fellBack": fell_back})
        if answer.get("skip") or answer.get("replay_failed"):
            fell_back.append({"tier": tier, "why": answer.get("skip") or answer["replay_failed"]})
            if answer.get("maybe_sent"):
                raise unknown("The replay sent a write before it failed, so nothing was tried again. Check the site", {"fellBack": fell_back})
            continue
        if answer.get("maybe_sent") and not answer.get("sent"):
            raise unknown(f"The replay sent a write and then stopped ({answer.get('error') or 'no answer'}), so nothing was tried again. Check the site",
                          {"fellBack": fell_back})
        outcome = classify(flow, request, answer, write)
        if outcome.drift:
            drifts.append({"tier": tier, "why": outcome.drift})
        if outcome.kind == "ok":
            winner = (tier, outcome)
            break
        if outcome.kind == "stop":
            outcome.error.data = {**(outcome.error.data or {}), "tier": tier, "fellBack": fell_back}
            if drifts:
                mark(root, flow, False)
            raise outcome.error
        credential = credential or "credential header" in outcome.why
        fell_back.append({"tier": tier, "why": outcome.why})
    if fell_back:
        command_metrics.flag("flow_fell_back", True)
    if winner is None:
        if drifts:
            mark(root, flow, False)
            command_metrics.flag("flow_drifted", True)
            raise BrowseError(f"{flow['name']} drifted: {drifts[-1]['why']}. Do the task in the page and save the flow again",
                              data={"fellBack": fell_back, "drift": drifts}, code="drifted")
        if credential:
            raise BrowseError("The request needs a credential header the recording sent, which a flow never keeps, and the replay couldn't get "
                              "an answer; use the page for this task", data={"fellBack": fell_back}, code="credential_not_sendable")
        reasons = "; ".join(f"{item['tier']}: {item['why']}" for item in fell_back) or "no tier ran"
        raise BrowseError(f"{flow['name']} got no answer ({reasons})", data={"fellBack": fell_back}, code="flow_failed")
    tier, outcome = winner
    verified = not drifts
    mark(root, flow, verified)
    command_metrics.flag(f"flow_run_{tier}", True)
    command_metrics.flag("flow_shaped", not shape.empty)
    if drifts:
        command_metrics.flag("flow_drifted", True)
    shaped = shaping.apply(outcome.value, shape, always=True, path=request["expect"].get("list"))
    if shaped.get("items") is not None:
        command_metrics.count("flow_items", len(shaped["items"]))
    data = {"flow": flow["name"], "site": flow["site"], "tier": tier, "verified": verified, "fellBack": fell_back, "result": shaped}
    if drifts:
        data["drift"] = drifts
    if notes:
        data["notes"] = notes
    return Result(data, "\n".join([run_text(flow, tier, shaped, fell_back, drifts), *(f"→ {note}" for note in notes)]), page_content=True)


def mark(root: Path, flow: dict, verified: bool):
    if bool(flow.get("verified", True)) == verified:
        return
    flow["verified"] = verified
    try:
        flows.save(root, flow)
    except BrowseError:
        pass


def run_text(flow: dict, tier: str, shaped: dict, fell_back: list, drifts: list) -> str:
    from ardia_cli.browse.commands import render_json

    if shaped.get("items") is None:
        head = f"✓ {flow['name']} via {tier}"
        body = render_json(shaped.get("value"))
    else:
        where = f" in {shaped['list']}" if shaped.get("list") else ""
        counted = f"{len(shaped['items'])} of {shaped['matched']} matching" if shaped["matched"] != shaped["total"] else f"{len(shaped['items'])} of {shaped['total']}"
        head = f"✓ {flow['name']} via {tier}: {counted} items{where}"
        body = render_json(shaped["items"]) if shaped["items"] else "(no items)"
    notes = [f"→ {item['tier']} tier skipped: {item['why']}" for item in fell_back]
    notes += [f"→ the {item['tier']} tier saw the shape change ({item['why']}); the flow is marked unverified, save it again" for item in drifts]
    return "\n".join([head, body, *notes])
