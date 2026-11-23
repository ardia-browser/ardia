import {
  Action,
  ActionPanel,
  Badge,
  Box,
  Button,
  Detail,
  Divider,
  EmptyState,
  Form,
  List,
  Popover,
  Progress,
  SidebarView,
  Text,
  ardia,
  useEffect,
  useMemo,
  useState,
  useSurface,
  type Tone,
  type ViewProps,
} from "@ardia/plugin-sdk";
import { pickTab } from "./commands";
import { formatCount, hostOf, isRepoName, useRepo, useStarred, useTabs } from "./github";

const toneSetting = (): Tone => ardia.settings.get<Tone>("badgeTone", "accent");

export function ShowcaseSidebar(_props: ViewProps) {
  const tabs = useTabs();
  const [starred, toggle] = useStarred();
  const pinned = useMemo(() => (tabs ?? []).filter((t) => t.pinned).length, [tabs]);

  return (
    <SidebarView
      title="Showcase"
      isLoading={tabs === null}
      actions={
        <ActionPanel>
          <Action title="Open Sidecar" icon="rectangle.righthalf.inset.filled" onAction={() => ardia.panels.open("sidecar")} />
          <Action title="Jump to a Tab…" icon="rectangle.stack" shortcut="cmd+shift+j" onAction={pickTab} />
        </ActionPanel>
      }
    >
      <SidebarView.Section title={`Open tabs · ${tabs?.length ?? 0}`}>
        {(tabs ?? []).slice(0, 12).map((tab) => (
          <SidebarView.Item
            key={tab.id}
            id={tab.id}
            title={tab.title || hostOf(tab.url)}
            subtitle={hostOf(tab.url)}
            icon={tab.pinned ? "pin.fill" : "globe"}
            selected={tab.active}
            onPress={() => ardia.tabs.activate(tab.id)}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Address" content={tab.url} />
                <Action title="Close Tab" icon="xmark" destructive onAction={() => ardia.tabs.close(tab.id)} />
              </ActionPanel>
            }
          />
        ))}
      </SidebarView.Section>
      <SidebarView.Section title="Starred repositories" collapsible>
        {starred.length === 0 ? (
          <EmptyState icon="star" title="Nothing starred yet" description="Star a repository from the toolbar popover or the gh omnibox keyword." />
        ) : (
          starred.map((repo) => (
            <SidebarView.Item
              key={repo}
              title={repo}
              icon="star.fill"
              tone={toneSetting()}
              onPress={() => ardia.tabs.open(`https://github.com/${repo}`, { activate: true })}
              actions={
                <ActionPanel>
                  <Action.OpenInBrowser url={`https://github.com/${repo}`} />
                  <Action title="Unstar" icon="star.slash" destructive onAction={() => toggle(repo)} />
                </ActionPanel>
              }
            />
          ))
        )}
      </SidebarView.Section>
      <Box padding="s" gap="xs">
        <Text size="caption" tone="tertiary">
          {pinned} pinned · {starred.length} starred
        </Text>
      </Box>
    </SidebarView>
  );
}

export function ToolbarPopover(_props: ViewProps) {
  const surface = useSurface();
  const [draft, setDraft] = useState(ardia.settings.get("defaultRepo", "nodejs/node"));
  const [checked, setChecked] = useState<string | null>(null);
  const [showBadge, setShowBadge] = useState(true);
  const { stats, error, loading } = useRepo(checked);
  const [starred, toggle] = useStarred();

  const submit = async () => {
    if (!isRepoName(draft)) return;
    setChecked(draft.trim());
  };

  useEffect(() => {
    if (!stats) return;
    const badge = showBadge ? formatCount(stats.stars) : null;
    void ardia.toolbar.update("showcase", { badge, tooltip: `${stats.fullName} · ${stats.stars} stars`, tone: toneSetting() });
  }, [stats, showBadge]);

  return (
    <Popover title="V2 Showcase" width={340}>
      <Form submitTitle="Check Stars" isLoading={loading} onSubmit={submit}>
        <Form.TextField
          id="repo"
          title="Repository"
          placeholder="owner/name"
          value={draft}
          onChange={setDraft}
          error={draft && !isRepoName(draft) ? "Use owner/name" : (error ?? undefined)}
          autoFocus
        />
        <Form.Toggle id="badge" label="Show stars on the toolbar" value={showBadge} onChange={setShowBadge} />
      </Form>
      {loading ? <Progress label="Asking GitHub…" /> : null}
      {stats ? (
        <Box gap="xs" padding="s" background="subtle" radius="s">
          <Box direction="row" gap="s" align="center">
            <Text weight="semibold">{stats.fullName}</Text>
            <Badge tone={toneSetting()} icon="star.fill">
              {formatCount(stats.stars)}
            </Badge>
          </Box>
          <Text size="small" tone="secondary" lines={2}>
            {stats.description || "No description."}
          </Text>
          <Button
            title={starred.includes(stats.fullName) ? "Unstar" : "Star"}
            icon={starred.includes(stats.fullName) ? "star.slash" : "star"}
            variant="secondary"
            onPress={() => toggle(stats.fullName)}
          />
        </Box>
      ) : null}
      <Divider />
      <Box direction="row" gap="s" justify="between">
        <Button title="Open Sidecar" icon="rectangle.righthalf.inset.filled" onPress={() => ardia.panels.open("sidecar")} />
        <Button title="Done" variant="plain" onPress={() => surface.close()} />
      </Box>
    </Popover>
  );
}

export function RepoBrowser({ context }: ViewProps<{ query?: string }>) {
  const [search, setSearch] = useState(context.query ?? "");
  const [starred, toggle] = useStarred();
  const [selected, setSelected] = useState<string | null>(null);
  const { stats, loading } = useRepo(selected);
  const candidates = useMemo(() => {
    const typed = search.trim();
    const list = [...starred];
    if (isRepoName(typed) && !list.includes(typed)) list.unshift(typed);
    return list.filter((repo) => repo.toLowerCase().includes(typed.toLowerCase()) || repo === typed);
  }, [search, starred]);

  return (
    <List
      searchBarPlaceholder="owner/name"
      searchText={search}
      onSearchTextChange={setSearch}
      selectedItemId={selected ?? undefined}
      onSelectionChange={setSelected}
      isShowingDetail
      emptyView={<EmptyState icon="magnifyingglass" title="Type a repository" description="Like nodejs/node. Starred ones show here." />}
    >
      <List.Section title="Repositories" subtitle={`${candidates.length}`}>
        {candidates.map((repo) => (
          <List.Item
            key={repo}
            id={repo}
            title={repo}
            icon={starred.includes(repo) ? "star.fill" : "book.closed"}
            keywords={repo.split("/")}
            accessories={selected === repo && stats ? [{ icon: "star", text: formatCount(stats.stars), tone: toneSetting() }] : []}
            detail={
              <Detail
                isLoading={selected === repo && loading}
                markdown={selected === repo && stats ? `# ${stats.fullName}\n\n${stats.description}` : `# ${repo}`}
                metadata={
                  selected === repo && stats
                    ? [
                        { label: "Stars", text: formatCount(stats.stars), icon: "star" },
                        { label: "Forks", text: formatCount(stats.forks), icon: "tuningfork" },
                        { label: "Open issues", text: String(stats.openIssues) },
                        { label: "Language", text: stats.language ?? "Unknown" },
                      ]
                    : []
                }
              />
            }
            actions={
              <ActionPanel title={repo}>
                <Action.OpenInBrowser url={`https://github.com/${repo}`} />
                <Action title={starred.includes(repo) ? "Unstar" : "Star"} icon="star" shortcut="cmd+s" onAction={() => toggle(repo)} />
                <Action.CopyToClipboard content={`https://github.com/${repo}`} title="Copy Link" onCopy={() => ardia.ui.toast("Link copied", undefined, { icon: "link" })} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
