# @ardia/plugin-sdk

Build plugins for [Ardia](https://github.com/ardia-browser/ardia): the runtime your plugin's `main` runs on, JSX
components Ardia draws natively, and the tools a host or registry needs to check manifests and releases.

```sh
npx -p @ardia/plugin-cli create-ardia-plugin my-plugin
```

| Import | What it holds |
| --- | --- |
| `@ardia/plugin-sdk` | `definePlugin`, the `ardia` API, hooks, and the components (`List`, `Grid`, `Table`, `Tabs`, `Detail`, `Form`, `CodeBlock`, `Image`, `TagList`, `FileDropZone`, …) |
| `@ardia/plugin-sdk/jsx-runtime` | The automatic JSX runtime (`jsxImportSource: "@ardia/plugin-sdk"`) |
| `@ardia/plugin-sdk/protocol` | The channel's wire types, `diffTree` and `applyTreePatch` |
| `@ardia/plugin-sdk/manifest` | `validateManifestV3`, `generateManifestV3JsonSchema` and the manifest types |
| `@ardia/plugin-sdk/registry` | Signed registry envelopes (Ed25519), index, plugin and revocation validators, `resolvePluginGraph`, `matchRevocations`, `diffSecuritySurface` |
| `@ardia/plugin-sdk/semver` | Strict semver and npm-style ranges |
| `@ardia/plugin-sdk/testing` | `createMockHost()`, for unit tests that run without Ardia |

## A plugin

```tsx
import { List, ardia, definePlugin, useEffect, useState } from "@ardia/plugin-sdk";

function Tabs() {
  const [tabs, setTabs] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => void ardia.tabs.query().then(setTabs), []);
  return <List>{tabs.map((t) => <List.Item key={t.id} title={t.title} />)}</List>;
}

void definePlugin({ views: { tabs: Tabs } });
```

## What v3 adds

- `ardia.net.fetchStream(req)`: a streamed response whose `body` is an `AsyncIterable<string>`, with `text()`,
  `cancel()` and `AbortSignal` support; `readServerSentEvents(body)` parses an event stream.
- `ardia.net.connect(url)`: a WebSocket that Ardia proxies, held to the manifest's `network` permission.
- `ardia.auth.signIn(options)`: OAuth 2.0 with PKCE; Ardia runs the browser step and the token exchange.
- `ardia.services`: `provide(iface, handlers)`, `call(iface, method, input)` and `list(iface)` between plugins.
- `ardia.sidecar`, `ardia.page` (`readActive`, `readTab`, `sendToContent`, `onContentMessage`), `ardia.bookmarks`,
  `ardia.history`, `ardia.profiles`, `ardia.media`, `ardia.splits`, `ardia.peek`, `ardia.clipboard`, `ardia.fs` and
  `ardia.ui.notify`.
- Views update with `surface.patch` (only what changed) on a protocol 3 host, and with whole renders on older hosts.

## Testing a plugin

```ts
import { createMockHost } from "@ardia/plugin-sdk/testing";

const host = createMockHost();
host.mockFetchStream("https://api.example.com/", { chunks: ["data: hi\n\n"] });
await host.load(myPlugin);
const view = await host.mountView("tabs");
await view.trigger(view.byType("ListItem")[0], "onSelect");
```

Apache-2.0.
