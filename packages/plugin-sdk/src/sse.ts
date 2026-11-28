export type ServerSentEvent = { event: string; data: string; id?: string; retry?: number };

export async function* readServerSentEvents(chunks: AsyncIterable<string>): AsyncGenerator<ServerSentEvent> {
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  let retry: number | undefined;
  const flush = (): ServerSentEvent | null => {
    if (!data.length) {
      event = "";
      return null;
    }
    const out: ServerSentEvent = { event: event || "message", data: data.join("\n") };
    if (id !== undefined) out.id = id;
    if (retry !== undefined) out.retry = retry;
    data = [];
    event = "";
    retry = undefined;
    return out;
  };
  const line = (text: string): ServerSentEvent | null => {
    if (text === "") return flush();
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    return null;
  };
  let first = true;
  for await (const chunk of chunks) {
    buffer += first && chunk.startsWith("\uFEFF") ? chunk.slice(1) : chunk;
    first = false;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char !== "\n" && char !== "\r") continue;
      if (char === "\r" && i + 1 === buffer.length) break;
      const found = line(buffer.slice(start, i));
      if (char === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
      if (found) yield found;
    }
    buffer = buffer.slice(start);
  }
  if (buffer) {
    const found = line(buffer);
    if (found) yield found;
  }
  const last = flush();
  if (last) yield last;
}
