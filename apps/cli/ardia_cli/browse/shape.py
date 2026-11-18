import json
from dataclasses import dataclass, field

from ardia_cli.browse.errors import BrowseError, Usage

FIELD_SAMPLE = 50
MAX_LISTED_FIELDS = 60


@dataclass
class Shape:
    fields: list[str] = field(default_factory=list)
    where: list[tuple[str, str]] = field(default_factory=list)
    limit: int | None = None

    @property
    def empty(self) -> bool:
        return not self.fields and not self.where and self.limit is None


def parse_shape(fields: str | None = None, where: list[str] | None = None, limit: str | int | None = None) -> Shape:
    shape = Shape()
    if fields:
        shape.fields = [name.strip() for name in str(fields).split(",") if name.strip()]
    for clause in where or []:
        name, sep, value = str(clause).partition("=")
        if not sep or not name.strip():
            raise Usage(f"--where takes field=value (case-insensitive contains), not {clause!r}")
        shape.where.append((name.strip(), value.strip().casefold()))
    if limit is not None:
        try:
            shape.limit = int(limit)
        except (TypeError, ValueError):
            raise Usage(f"--limit takes a number of items, not {limit!r}") from None
        if shape.limit < 0:
            raise Usage("--limit takes 0 or more")
    return shape


def lookup(value, path: str):
    current = value
    for key in path.split("."):
        if isinstance(current, dict) and key in current:
            current = current[key]
        elif isinstance(current, list) and key.isdigit() and int(key) < len(current):
            current = current[int(key)]
        else:
            return MISSING
    return current


class Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = Missing()


def as_text(value) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def weight(items: list) -> int:
    return len(json.dumps(items, ensure_ascii=False, default=str))


def main_list(body) -> tuple[str | None, list] | None:
    if isinstance(body, list):
        return None, body
    best: list = []

    def walk(value, path: str):
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            here = f"{path}.{key}" if path else str(key)
            if isinstance(child, list) and child and isinstance(child[0], dict):
                size = weight(child)
                if not best or size > best[0][0]:
                    best[:] = [(size, here, child)]
            elif isinstance(child, dict):
                walk(child, here)

    walk(body, "")
    if not best:
        return None
    return best[0][1], best[0][2]


def item_fields(items: list) -> list[str]:
    names: list[str] = []
    for item in items[:FIELD_SAMPLE]:
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if isinstance(value, dict) and value:
                found = [f"{key}.{inner}" for inner in value]
            else:
                found = [str(key)]
            for name in found:
                if name not in names:
                    names.append(name)
    return names


def unknown_fields(items: list, shape: Shape) -> list[str]:
    wanted = [name for name, _ in shape.where] + shape.fields
    return [name for name in dict.fromkeys(wanted) if not any(lookup(item, name) is not MISSING for item in items)]


def matches(item, where: list[tuple[str, str]]) -> bool:
    for name, needle in where:
        value = lookup(item, name)
        if value is MISSING or needle not in as_text(value).casefold():
            return False
    return True


def pick(item, names: list[str]) -> dict:
    out = {}
    for name in names:
        value = lookup(item, name)
        if value is not MISSING:
            out[name] = value
    return out


def apply(body, shape: Shape, always: bool = False, path: str | None = None):
    at = lookup(body, path) if path else MISSING
    found = (path, at) if isinstance(at, list) else main_list(body)
    if found is None:
        if shape.empty and not always:
            return body
        if shape.empty:
            return {"list": None, "total": None, "matched": None, "items": None, "value": body}
        raise BrowseError("The answer has no list of items to shape (--fields, --where and --limit work on a list of objects)",
                          code="no_list")
    path, items = found
    missing = unknown_fields(items, shape) if items else []
    if missing:
        valid = item_fields(items)
        listed = ", ".join(valid[:MAX_LISTED_FIELDS]) + (" …" if len(valid) > MAX_LISTED_FIELDS else "")
        raise BrowseError(f"No item has {', '.join(missing)}; the items' fields are: {listed}",
                          data={"unknown": missing, "fields": valid, "list": path}, code="unknown_field")
    if shape.empty and not always:
        return body
    kept = [item for item in items if matches(item, shape.where)]
    matched = len(kept)
    if shape.limit is not None:
        kept = kept[:shape.limit]
    if shape.fields:
        kept = [pick(item, shape.fields) for item in kept]
    return {"list": path, "total": len(items), "matched": matched, "items": kept}
