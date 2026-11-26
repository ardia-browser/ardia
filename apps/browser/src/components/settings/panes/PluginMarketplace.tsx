import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { pickFiles, pickFolder } from "../../../state/app/system";
import { addRegistry, CATEGORIES_ALL, catalogCategories, filterCatalog, getPlugin, installFromFile, installPlugin, refreshCatalog, removeRegistry, reviewUpdate, type CatalogEntry } from "../../../state/plugins/actions";
import { installStateOf } from "../../../state/plugins/marketplace";
import { parseGithubSpec } from "../../../state/plugins/githubSource";
import { useCatalog, usePluginFetch } from "../../../state/plugins/hooks";
import { usePlugins } from "../../../state/plugins/store";
import { pluginsExtras } from "../../../state/plugins/savedState";
import { keyOfId } from "../../../lib/pluginIds";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { Group, Row, SectionHeader } from "../Form";
import { ActivitySpinner, Button, IconTile, PopUp, SearchField, Text, TextField } from "../../ui";
import { lineHeight, space } from "../../ui/tokens";

const MAX_SHOWN = 40;

function useMounted() {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return mounted;
}

export function MarketplaceSection({ getting }: { getting?: string | null }) {
  const catalog = useCatalog();
  const [query, setQuery] = useState(getting ?? "");
  const [category, setCategory] = useState(CATEGORIES_ALL);
  useEffect(() => void refreshCatalog(), []);
  const shown = useMemo(() => filterCatalog(catalog.entries, query, category).slice(0, MAX_SHOWN), [catalog.entries, query, category]);
  const categories = catalogCategories(catalog.entries);
  return (
    <View>
      <SectionHeader anchor="plugins.marketplace" action={<Button title="Install from Folder or .tar.gz…" onPress={() => void installLocal()} />} />
      <Group of="plugins.marketplace">
        <Row title={<SearchField value={query} onChangeText={setQuery} placeholder="Search plugins" width={260} />}>
          {categories.length ? <PopUp value={category} options={[{ value: CATEGORIES_ALL, title: "All Categories" }, ...categories.map((c) => ({ value: c, title: c }))]} onChange={setCategory} minWidth={150} /> : null}
        </Row>
        <CatalogList shown={shown} searching={!!query} />
        <GithubRow />
      </Group>
    </View>
  );
}

function CatalogList({ shown, searching }: { shown: CatalogEntry[]; searching: boolean }) {
  const catalog = useCatalog();
  if (catalog.state === "offline")
    return (
      <Row title="Couldn't reach the plugin registry" description={catalog.reason ?? undefined}>
        <Button title="Try Again" onPress={() => void refreshCatalog(true)} />
      </Row>
    );
  if (catalog.state === "loading" || (catalog.state === "idle" && !catalog.entries.length))
    return (
      <Row title="Checking the plugin registry…">
        <ActivitySpinner style={SPINNER} />
      </Row>
    );
  if (!shown.length) return <Row title={searching ? "Nothing matches" : "No plugins yet"} />;
  return (
    <>
      {shown.map((entry) => (
        <CatalogRow key={entry.id} entry={entry} />
      ))}
    </>
  );
}

async function installLocal() {
  const files = await pickFiles().catch(() => [] as string[]);
  const picked = files[0] ?? (await pickFolder(null, "Choose a plugin's folder").catch(() => null));
  if (picked) await installFromFile(picked);
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const key = keyOfId(entry.id) ?? "";
  const state = usePlugins(() => installStateOf(entry.id));
  const fetch = usePluginFetch(key);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const get = async () => {
    setBusy(true);
    setFailure(null);
    const result = await getPlugin(entry.id);
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok && !result.cancelled) setFailure(result.reason);
  };
  const progress = fetch?.state === "fetching" && fetch.total ? ` · ${Math.min(100, Math.round((fetch.received / fetch.total) * 100))}%` : "";
  const description = failure ?? `${entry.official ? "Official · " : ""}${entry.tier === "native" ? "Runs outside Ardia's sandbox · " : ""}${entry.description}${progress}`;
  return (
    <Row
      icon={<IconTile symbol={entry.icon ?? "puzzlepiece"} size="l" />}
      title={entry.name}
      onPress={state === "installed" || state === "update" ? () => goToSettingsPane("plugins", null, key) : undefined}
      description={
        <Text selectable={!!failure} lines={failure ? undefined : 2} size="caption" tone={failure ? "destructive" : "textSecondary"} style={LINE}>
          {description}
        </Text>
      }
    >
      {busy || state === "installing" ? <ActivitySpinner style={SPINNER} /> : null}
      {state === "get" ? <Button title="Get" disabled={busy} onPress={() => void get()} /> : null}
      {state === "update" ? <Button title="Update…" onPress={() => reviewUpdate(key)} /> : null}
      {state === "installed" ? (
        <Text size="small" tone="textTertiary">
          Installed
        </Text>
      ) : null}
    </Row>
  );
}

function GithubRow() {
  const [repo, setRepo] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useMounted();
  const parsed = parseGithubSpec(repo);
  const install = async () => {
    if (!parsed) return;
    setFailure(null);
    const result = await installPlugin({ id: "", source: { kind: "github", repo: parsed } }, { showSheet: false });
    if (mounted.current && !result.ok && !result.cancelled) setFailure(result.reason);
  };
  return (
    <Row title={<TextField value={repo} onChangeText={setRepo} placeholder="github:owner/repo" onSubmit={() => void install()} mono />} description={failure ?? "Installs a plugin straight from its GitHub releases."}>
      <Button title="Install" disabled={!parsed} onPress={() => void install()} />
    </Row>
  );
}

export function RegistriesSection() {
  const [url, setUrl] = useState("");
  const [scopes, setScopes] = useState("");
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [registries, setRegistries] = useState(() => pluginsExtras().registries);
  const add = () => {
    const added = addRegistry(url, scopes, key);
    if (!added.ok) return setProblem(added.reason);
    setProblem(null);
    setUrl("");
    setScopes("");
    setKey("");
    setRegistries(pluginsExtras().registries);
  };
  return (
    <View>
      <SectionHeader anchor="plugins.registries" />
      <Group of="plugins.registries">
        {registries.map((r) => (
          <Row key={r.url} title={r.url} description={r.scopes.length ? `Serves ${r.scopes.join(", ")}` : "Serves nothing until it names its scopes"}>
            <Button
              title="Remove"
              onPress={() => {
                if (removeRegistry(r.url)) setRegistries(pluginsExtras().registries);
              }}
            />
          </Row>
        ))}
        <Row title={<TextField value={url} onChangeText={setUrl} placeholder="https://plugins.acme.example/r" />} />
        <Row title={<TextField value={scopes} onChangeText={setScopes} placeholder="@acme/*" />} />
        <Row title={<TextField value={key} onChangeText={setKey} placeholder="kid=Ed25519 public key" mono onSubmit={add} />} description={problem ?? "Ardia trusts only what this key signs."}>
          <Button title="Add Registry" disabled={!url || !key} onPress={add} />
        </Row>
      </Group>
    </View>
  );
}

const LINE = { marginTop: space.xxs, lineHeight: lineHeight.caption } as const;
const SPINNER = { width: 14, height: 14 } as const;
