import json

FORBIDDEN_METHODS = frozenset({"Browser.close", "Browser.crash", "Browser.crashGpuProcess"})


class ForbiddenCommand(RuntimeError):
    pass


def check_method(method) -> None:
    name = getattr(method, "value", method)
    if name in FORBIDDEN_METHODS:
        raise ForbiddenCommand(f"ardia never sends {name}: it's the user's browser")


def check_command(command) -> None:
    if isinstance(command, dict):
        check_method(command.get("method"))


def check_message(message) -> None:
    if isinstance(message, (bytes, bytearray, memoryview)):
        message = bytes(message).decode("utf-8", "replace")
    if not isinstance(message, str):
        return
    try:
        payload = json.loads(message)
    except ValueError:
        raise ForbiddenCommand("ardia only sends JSON commands") from None
    for command in payload if isinstance(payload, list) else [payload]:
        check_command(command)


async def direct_connect(uri, max_size=None):
    from ardia_cli import wsclient

    return await wsclient.connect(uri, max_size=max_size)
