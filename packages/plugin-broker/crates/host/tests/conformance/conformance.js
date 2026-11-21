(function () {
  const urlCases = [
    ["https://example.com"],
    ["https://example.com/"],
    ["HTTPS://EXAMPLE.COM/A/B?C=D#E"],
    ["https://user:pass@example.com:8443/p/a/t/h?query=string#hash"],
    ["https://user@example.com/"],
    ["https://:pass@example.com/"],
    ["http://example.com:80/"],
    ["https://example.com:443/"],
    ["http://example.com:8080"],
    ["ws://example.com:80/socket"],
    ["wss://example.com:443/socket"],
    ["ftp://example.com:21/file"],
    ["http://example.com/a/../b/./c"],
    ["http://example.com/a/%2e%2E/b"],
    ["http://example.com/path with spaces"],
    ["http://example.com/?q=a b&r=ü"],
    ["http://example.com/#frag ment"],
    ["http://example.com/?"],
    ["http://example.com/#"],
    ["http://example.com/?#"],
    ["http://[::1]:3000/x"],
    ["http://[2001:DB8::1]/"],
    ["http://127.0.0.1:8080/"],
    ["http://0x7f.1/"],
    ["http://bücher.de/"],
    ["http://EXAMPLE.com./"],
    ["http:\\\\example.com\\a\\b"],
    ["  https://example.com/trim  "],
    ["https://exa\tmple.com/\n"],
    ["file:///etc/hosts"],
    ["file://localhost/etc/hosts"],
    ["file:///C:/Windows/"],
    ["mailto:someone@example.com"],
    ["mailto:someone@example.com?subject=hi"],
    ["data:text/plain,hello%20world"],
    ["javascript:alert(1)"],
    ["about:blank"],
    ["blob:https://example.com/uuid"],
    ["foo://Host.Example/Path?Q#F"],
    ["foo:/path"],
    ["urn:isbn:0451450523"],
    ["ardia://plugin/page.html"],
    ["chrome://settings"],
    ["https://example.com:65536/"],
    ["https://example.com:abc/"],
    ["https://exa mple.com/"],
    ["http://"],
    ["https:"],
    ["not a url"],
    [""],
    ["//example.com/x"],
    ["/absolute"],
    ["relative/path"],
    ["../up", "https://example.com/a/b/c"],
    ["./same", "https://example.com/a/b/c"],
    ["/root", "https://example.com/a/b?x#y"],
    ["?only=query", "https://example.com/a/b?x#y"],
    ["#only-hash", "https://example.com/a/b?x#y"],
    ["", "https://example.com/a/b?x#y"],
    ["//other.org/x", "https://example.com/a"],
    ["https://absolute.org/", "https://example.com/a"],
    ["sibling", "https://example.com/dir/"],
    ["x", "mailto:a@b.c"],
    ["x", "not a base"],
    ["path", "file:///home/user/doc.txt"],
    ["http://example.com/%zz"],
    ["http://example.com/\u00e9t\u00e9"],
    ["https://example.com/a?b=%41"],
    ["HTTP://user:p%40ss@Ex.com:8080/"],
  ];
  const urlFields = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
  const urlOf = (input, base) => {
    try {
      const u = base === undefined ? new URL(input) : new URL(input, base);
      const out = {};
      for (const field of urlFields) out[field] = u[field];
      out.searchParams = [...u.searchParams];
      out.json = JSON.stringify(u);
      return out;
    } catch (error) {
      return { throws: error && error.name };
    }
  };
  const url = urlCases.map(([input, base]) => ({ input, base: base === undefined ? null : base, result: urlOf(input, base), canParse: URL.canParse(input, base) }));

  const setterCases = [
    ["https://example.com/a?b#c", "pathname", "/x y"],
    ["https://example.com/a?b#c", "search", "q=1 2"],
    ["https://example.com/a?b#c", "search", ""],
    ["https://example.com/a?b#c", "hash", "frag"],
    ["https://example.com/a?b#c", "hash", ""],
    ["https://example.com/a", "host", "other.org:8080"],
    ["https://example.com/a", "hostname", "other.org"],
    ["https://example.com/a", "port", "8443"],
    ["https://example.com:8443/a", "port", ""],
    ["https://example.com/a", "port", "443"],
    ["https://example.com/a", "protocol", "http"],
    ["https://example.com/a", "username", "us er"],
    ["https://example.com/a", "password", "p@ss"],
    ["https://example.com/a", "href", "http://new.org/z"],
  ];
  const setters = setterCases.map(([start, field, value]) => {
    try {
      const u = new URL(start);
      u[field] = value;
      return { start, field, value, href: u.href };
    } catch (error) {
      return { start, field, value, throws: error && error.name };
    }
  });

  const paramsOut = (() => {
    const p = new URLSearchParams("a=1&b=2&a=3&c=%20x+y&d");
    const steps = [p.toString(), p.get("a"), p.getAll("a").join(","), p.get("c"), p.get("d"), p.has("b"), p.size];
    p.append("e", "é&=");
    p.set("a", "9");
    p.delete("b");
    steps.push(p.toString());
    p.sort();
    steps.push(p.toString());
    steps.push(new URLSearchParams({ x: "1", y: "two words" }).toString());
    steps.push(new URLSearchParams([["k", "v"], ["k", "w"]]).toString());
    const u = new URL("https://example.com/?z=1");
    u.searchParams.append("y", "2");
    steps.push(u.href);
    return steps;
  })();

  const runBase64 = (fn, input) => {
    try {
      return { ok: fn(input) };
    } catch (error) {
      return { throws: error && error.name };
    }
  };
  const btoaInputs = ["", "a", "ab", "abc", "hello world", "\u00ff\u00fe\u00fd", "\u0100", "\ud83d\ude00", "\ud800"];
  const atobInputs = ["", "YQ==", "YQ", "YWI=", "YWJj", " Y Q = = ", "YQ==\n", "YQ==\r\n", "YQ==\t", "YR==", "Y", "YQ=", "Y===", "YQ==YQ==", "Y-Q=", "Y_Q=", "//4=", "Y\u00a0Q", "YWJj\fZA=="];
  const base64 = {
    btoa: btoaInputs.map((input) => ({ input: JSON.stringify(input), result: runBase64(btoa, input) })),
    atob: atobInputs.map((input) => ({ input: JSON.stringify(input), result: runBase64(atob, input) })),
  };

  const text = (() => {
    const enc = new TextEncoder();
    const out = [];
    out.push([...enc.encode("aé€😀")]);
    out.push([...enc.encode("\ud800x")]);
    const dest = new Uint8Array(5);
    out.push(enc.encodeInto("a€😀", dest));
    out.push([...dest]);
    const dec = new TextDecoder();
    out.push(dec.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9])));
    out.push(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).length);
    out.push(dec.decode(new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x82])));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]));
      out.push("no throw");
    } catch (error) {
      out.push(error.name);
    }
    try {
      new TextDecoder("latin1");
      out.push("no throw");
    } catch (error) {
      out.push(error.name);
    }
    return out;
  })();

  const misc = (() => {
    const out = {};
    out.uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID());
    out.random = crypto.getRandomValues(new Uint8Array(65536)).length;
    try {
      crypto.getRandomValues(new Uint8Array(65537));
      out.randomOver = "no throw";
    } catch (error) {
      out.randomOver = error.name;
    }
    try {
      crypto.getRandomValues(new Float32Array(2));
      out.randomFloat = "no throw";
    } catch (error) {
      out.randomFloat = error.name;
    }
    out.u32 = crypto.getRandomValues(new Uint32Array(4)).length;
    const h = new Headers({ "Content-Type": "text/plain", "X-A": "1" });
    h.append("x-a", "2");
    out.headers = [...h];
    out.response = new Response("{\"a\":1}", { status: 201 }).ok;
    out.globals = ["URL", "URLSearchParams", "fetch", "Headers", "Request", "Response", "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "atob", "btoa", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "crypto", "console", "DOMException", "reportError", "__ardiaBridge"].filter((name) => typeof globalThis[name] === "undefined");
    out.noLoaders = ["require", "process", "std", "os", "Deno", "Bun"].filter((name) => typeof globalThis[name] !== "undefined");
    return out;
  })();

  const trace = [];
  const done = () => {
    const report = { url, setters, params: paramsOut, base64, text, misc, timers: trace };
    __ardiaBridge.send(JSON.stringify({ conformance: report }));
  };
  trace.push("sync-start");
  setTimeout(() => trace.push("timeout-0-a"), 0);
  setTimeout(() => trace.push("timeout-0-b"), 0);
  setTimeout(() => {
    trace.push("timeout-20");
    Promise.resolve().then(() => trace.push("micro-in-timeout-20"));
    setTimeout(() => trace.push("timeout-nested-0"), 0);
  }, 20);
  const cancelled = setTimeout(() => trace.push("cancelled"), 5);
  clearTimeout(cancelled);
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    trace.push("interval-" + ticks);
    if (ticks === 3) clearInterval(interval);
  }, 40);
  Promise.resolve().then(() => {
    trace.push("micro-1");
    queueMicrotask(() => trace.push("micro-nested"));
  });
  queueMicrotask(() => trace.push("micro-2"));
  (async () => {
    trace.push("async-sync");
    await null;
    trace.push("async-after-await");
  })();
  setTimeout((first, second) => {
    trace.push("timeout-args:" + first + "," + second);
  }, 60, 1, 2);
  setTimeout(() => {
    trace.push("end");
    done();
  }, 300);
  trace.push("sync-end");
})();
