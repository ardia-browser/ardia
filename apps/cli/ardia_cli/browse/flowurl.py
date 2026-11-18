import base64
import ipaddress
import json
import re
from dataclasses import dataclass
from urllib.parse import quote, quote_plus, unquote, unquote_plus, urlsplit

DEFAULT_PORTS = {"http": 80, "https": 443}
FORBIDDEN = re.compile(r"[\\\s\x00-\x1f\x7f]")
SHAPE = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?", re.S)
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
NUMERIC_LABEL = re.compile(r"0x[0-9a-f]*|[0-9]+")
PARAM = re.compile(r"\{\{([a-z][a-z0-9_]{0,23})\}\}")
SHORT = re.compile(r"[A-Za-z0-9_-]{0,24}")
SEGMENT = re.compile(r"[A-Za-z0-9_.-]{0,24}")
DECIMAL = re.compile(r"-?\d{1,15}(\.\d{1,9})?")
QUERY_KEY = re.compile(r"[A-Za-z0-9_.\[\]-]{1,40}")
HIDDEN = "<hidden>"
CREDENTIAL_WORDS = {"token", "auth", "apikey", "key", "sig", "signature", "secret", "password", "passwd", "pwd", "pass", "csrf", "xsrf",
                    "session", "sessionid", "sid", "jwt", "otp", "nonce", "credential", "credentials", "bearer", "hmac", "accesstoken"}


class Unsafe(ValueError):
    pass


@dataclass(frozen=True)
class Url:
    scheme: str
    host: str
    port: int
    path: str
    query: str
    literal: bool

    @property
    def origin(self) -> str:
        return f"{self.scheme}://{self.host}" + ("" if self.port == DEFAULT_PORTS[self.scheme] else f":{self.port}")

    @property
    def text(self) -> str:
        return self.origin + (self.path or "/") + (f"?{self.query}" if self.query else "")


def parse(url) -> Url:
    if not isinstance(url, str) or not url.isascii():
        raise Unsafe("it isn't a plain ASCII URL")
    if FORBIDDEN.search(url):
        raise Unsafe("it has a backslash, a space or a control character")
    match = SHAPE.fullmatch(url)
    if not match:
        raise Unsafe("it isn't an absolute URL")
    scheme = match.group(1).lower()
    if scheme not in DEFAULT_PORTS:
        raise Unsafe("it isn't http or https")
    authority = match.group(2)
    if not authority or "@" in authority:
        raise Unsafe("its address has no host or carries user info")
    port_text = ""
    if authority.startswith("["):
        close = authority.find("]")
        if close < 0:
            raise Unsafe("its IPv6 host isn't closed")
        inner, rest = authority[1:close], authority[close + 1:]
        try:
            ipaddress.IPv6Address(inner)
        except ValueError:
            raise Unsafe("its IPv6 host doesn't parse") from None
        host, literal = f"[{inner.lower()}]", True
        if rest:
            if not rest.startswith(":"):
                raise Unsafe("its host is followed by something other than a port")
            port_text = rest[1:]
    else:
        host, sep, port_text = authority.partition(":")
        if sep and not port_text:
            raise Unsafe("it has an empty port")
        host = host.lower()
        labels = host.split(".")
        if not all(LABEL.fullmatch(label) for label in labels):
            raise Unsafe("its host isn't a plain DNS name")
        literal = bool(NUMERIC_LABEL.fullmatch(labels[-1]))
    if port_text:
        if not re.fullmatch(r"\d{1,5}", port_text) or not 0 < int(port_text) < 65536:
            raise Unsafe("its port isn't a number from 1 to 65535")
        port = int(port_text)
    else:
        port = DEFAULT_PORTS[scheme]
    return Url(scheme, host, port, match.group(3) or "/", match.group(4) or "", literal)


def credential_key(key: str) -> bool:
    text = unquote_plus(str(key))
    words = [word.lower() for word in re.split(r"[_\-.\[\]\s]+|(?<=[a-z])(?=[A-Z])", text) if word]
    words += [word[:-1] for word in words if word.endswith("s")]
    return any(word in CREDENTIAL_WORDS for word in words) or text.lower().replace("-", "").replace("_", "") in CREDENTIAL_WORDS


def literal_ok(value: str, segment: bool = False) -> bool:
    if PARAM.fullmatch(value) or DECIMAL.fullmatch(value):
        return True
    if "@" in value:
        return False
    if segment:
        return ".." not in value and bool(SEGMENT.fullmatch(PARAM.sub("", value)))
    return bool(SHORT.fullmatch(value))


def encodings(secret: str) -> set:
    raw = secret.encode()
    encoded = base64.b64encode(raw).decode()
    return {secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret, ensure_ascii=False)[1:-1], encoded, encoded.rstrip("="),
            base64.urlsafe_b64encode(raw).decode().rstrip("="), raw.hex(), raw.hex().upper(), ",".join(str(byte) for byte in raw)}


def carries(text, secret: str) -> bool:
    if not text or not secret:
        return False
    text = str(text)
    lowered = text.lower()
    return any(form and (form in text or form.lower() in lowered) for form in encodings(secret))


def query_pairs(query: str) -> list[tuple[str, str]]:
    pairs = []
    for pair in query.split("&") if query else []:
        key, _, value = pair.partition("=")
        pairs.append((unquote_plus(key), unquote_plus(value)))
    return pairs


def problem(url: Url, secrets: list[str] = ()) -> str | None:
    if any(carries(url.path, secret) or carries(url.query, secret) for secret in secrets):
        return "its URL carries a value typed into a secret field"
    for segment in url.path.split("/")[1:]:
        decoded = unquote(segment)
        if not literal_ok(decoded, segment=True):
            return "its URL path holds a value that isn't a param, a number or a short word"
        if not PARAM.fullmatch(decoded) and credential_key(PARAM.sub("", decoded)):
            return "its URL path names a credential"
    for key, value in query_pairs(url.query):
        if not QUERY_KEY.fullmatch(key):
            return "its URL query has an unusual key"
        if not literal_ok(value):
            return "its URL query holds a value that isn't a param, a number or a short word"
        if value and not PARAM.fullmatch(value) and credential_key(key):
            return "its URL query sends a credential"
    return None


def checked(url: str, secrets: list[str] = ()) -> Url:
    parsed = parse(url)
    why = problem(parsed, secrets)
    if why:
        raise Unsafe(why)
    return parsed


def host_label(url) -> str:
    try:
        parts = urlsplit(str(url))
        if parts.scheme.lower() not in DEFAULT_PORTS:
            return f"{parts.scheme.lower() or 'no'}:"
        return parts.netloc.rpartition("@")[2].lower()[:80] or "(no host)"
    except ValueError:
        return "(unparseable)"


def mask(url, secrets=()) -> str:
    def hidden(value: str) -> bool:
        return any(carries(value, secret) for secret in secrets)

    try:
        parts = urlsplit(str(url))
    except ValueError:
        return HIDDEN
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        return f"{scheme}:…" if scheme else HIDDEN
    segments = []
    for segment in parts.path.split("/"):
        decoded = unquote(segment)
        segments.append(segment if not decoded or (literal_ok(decoded, segment=True) and not hidden(decoded)) else HIDDEN)
    pairs = []
    for key, value in query_pairs(parts.query):
        shown_key = key if QUERY_KEY.fullmatch(key) and not hidden(key) else HIDDEN
        shown = value if literal_ok(value) and not (value and credential_key(key)) and not hidden(value) else HIDDEN
        pairs.append(f"{quote(shown_key, safe='[]<>')}={quote(shown, safe='{}<>')}" if value else quote(shown_key, safe="[]<>"))
    netloc = parts.netloc.rpartition("@")[2].lower()
    if hidden(netloc):
        netloc = HIDDEN
    return f"{scheme}://{netloc}{'/'.join(segments) or '/'}" + (f"?{'&'.join(pairs)}" if pairs else "")
