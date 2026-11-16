import re

QUEUE_WAIT = 30.0
COMMAND_LIMIT = 120.0
LIMIT_MARGIN = 30.0
SCRIPT_DEFAULT = 90.0
DEFAULT_TIMEOUT_MS = 25000
LONG_COMMANDS = {"batch": 600.0, "read": 600.0, "record": 600.0}


def seconds_of(text: str | None) -> float | None:
    if not text:
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m)?", text.strip())
    if not match:
        return None
    number, unit = float(match.group(1)), match.group(2) or "ms"
    return number * {"ms": 0.001, "s": 1, "m": 60}[unit]


def given_timeout(argv: list[str]) -> float | None:
    given = None
    for index, token in enumerate(argv):
        if token == "--":
            break
        if token == "--timeout" and index + 1 < len(argv):
            given = seconds_of(argv[index + 1])
        elif token.startswith("--timeout="):
            given = seconds_of(token.split("=", 1)[1])
    return given


def command_limit(name: str, argv: list[str], timeout: float) -> float:
    given = given_timeout(argv)
    if name == "wait":
        plain = next((seconds_of(arg) for arg in argv if re.fullmatch(r"\d+(\.\d+)?", arg)), None)
        return max(COMMAND_LIMIT, (given or plain or timeout) + LIMIT_MARGIN)
    if name == "script":
        return (given or SCRIPT_DEFAULT) + LIMIT_MARGIN
    return max(LONG_COMMANDS.get(name, COMMAND_LIMIT), (given or 0) + LIMIT_MARGIN)


def queue_wait(name: str, argv: list[str], base: float = QUEUE_WAIT, patient: bool = False) -> float:
    if patient:
        return max(base, command_limit(name, argv, DEFAULT_TIMEOUT_MS / 1000) - LIMIT_MARGIN)
    if name != "script":
        return base
    return max(base, given_timeout(argv) or SCRIPT_DEFAULT)


def answer_deadline(payload: dict) -> float:
    argv = payload.get("argv") or [""]
    options = payload.get("options") or {}
    timeout = float(options.get("timeout_ms") or DEFAULT_TIMEOUT_MS) / 1000
    name, rest = str(argv[0]), [str(arg) for arg in argv[1:]]
    return queue_wait(name, rest, patient=bool(payload.get("patient_queue"))) + command_limit(name, rest, timeout) + LIMIT_MARGIN
