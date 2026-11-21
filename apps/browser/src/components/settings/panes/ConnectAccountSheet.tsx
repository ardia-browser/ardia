import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { focusWindow } from "../../../state/windows/nativeWindow";
import { connectGoogleDrive } from "../../../state/live/googleAuth";
import { connectBitbucket, connectConfluence, connectNotion, SOURCES } from "../../../state/live/sources";
import { live } from "../../../state/live/store";
import type { LiveSourceId } from "../../../state/live/types";
import { settingsBrowserWindow } from "../../../state/settings/settingsWindows";
import { closeSettingsSheet } from "../../../state/settings/sheet";
import { Button, DialogActions, DialogTitle, proseLineHeight, Sheet, space, Text, TextField } from "../../ui";
import { perLook } from "../../ui/tokens";
import { Favicon } from "../../favicon/Favicon";
import { FormField } from "../Form";

export function ConnectAccountSheet({ id }: { id: Exclude<LiveSourceId, "github"> }) {
  const source = SOURCES[id];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      closeSettingsSheet();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  let body: ReactNode;
  switch (id) {
    case "bitbucket":
      body = <BitbucketConnect busy={busy} run={run} />;
      break;
    case "notion":
      body = <NotionConnect busy={busy} run={run} />;
      break;
    case "confluence":
      body = <ConfluenceConnect busy={busy} run={run} />;
      break;
    case "gdrive":
      body = <GoogleConnect busy={busy} run={run} />;
      break;
  }
  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle icon={<Favicon url={source.site} size={20} />}>Connect {source.name}</DialogTitle>
      <View style={BODY_TOP}>{body}</View>
      {error ? (
        <Text size="caption" tone="destructive" style={NOTE_TOP}>
          {error}
        </Text>
      ) : null}
    </Sheet>
  );
}

type ConnectProps = { busy: boolean; run(task: () => Promise<void>): Promise<void> };

const NOTE_TOP = { marginTop: space.ml } as const;
const BODY_TOP = { marginTop: space.l } as const;
const HELP = perLook(() => ({ lineHeight: proseLineHeight.small }) as const);

function Help({ children }: { children: ReactNode }) {
  return (
    <Text size="small" tone="textSecondary" style={HELP()}>
      {children}
    </Text>
  );
}

function BitbucketConnect({ busy, run }: ConnectProps) {
  const [user, setUser] = useState(live().config.bitbucketUser);
  const [token, setToken] = useState("");
  const go = () => void run(() => connectBitbucket(user, token));
  return (
    <View>
      <Help>Create an API token (bitbucket.org › Personal settings › API tokens, with read access to pull requests and repositories), then enter your Atlassian account email with it. Bitbucket can't search review requests across repositories, so the folder lists your own pull requests.</Help>
      <FormField label="Email or username">
        <TextField value={user} onChangeText={setUser} placeholder="you@example.com" />
      </FormField>
      <FormField label="API token">
        <TextField value={token} onChangeText={setToken} secure onSubmit={go} />
      </FormField>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={busy ? "Checking…" : "Connect"} kind="primary" disabled={!user.trim() || !token.trim() || busy} onPress={go} />
      </DialogActions>
    </View>
  );
}

function NotionConnect({ busy, run }: ConnectProps) {
  const [token, setToken] = useState("");
  const go = () => void run(() => connectNotion(token));
  return (
    <View>
      <Help>Create an internal integration at notion.so/my-integrations (read content; read user information for editor names), copy its secret, and share the pages or teamspaces you want with it (••• › Connections).</Help>
      <FormField label="Internal integration secret">
        <TextField value={token} onChangeText={setToken} placeholder="ntn_…" secure onSubmit={go} />
      </FormField>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={busy ? "Checking…" : "Connect"} kind="primary" disabled={!token.trim() || busy} onPress={go} />
      </DialogActions>
    </View>
  );
}

function ConfluenceConnect({ busy, run }: ConnectProps) {
  const config = live().config;
  const [site, setSite] = useState(config.confluenceSite);
  const [email, setEmail] = useState(config.confluenceEmail);
  const [token, setToken] = useState("");
  const go = () => void run(() => connectConfluence(site, email, token));
  return (
    <View>
      <Help>Create an API token at id.atlassian.com › Security › API tokens, then enter your Confluence Cloud site and account email.</Help>
      <FormField label="Site">
        <TextField value={site} onChangeText={setSite} placeholder="https://your-team.atlassian.net" />
      </FormField>
      <FormField label="Email">
        <TextField value={email} onChangeText={setEmail} placeholder="you@example.com" />
      </FormField>
      <FormField label="API token">
        <TextField value={token} onChangeText={setToken} secure onSubmit={go} />
      </FormField>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={busy ? "Checking…" : "Connect"} kind="primary" disabled={!site.trim() || !email.trim() || !token.trim() || busy} onPress={go} />
      </DialogActions>
    </View>
  );
}

function GoogleConnect({ busy, run }: ConnectProps) {
  const [clientId, setClientId] = useState(live().config.googleClientId);
  const [secret, setSecret] = useState("");
  const go = () =>
    void run(async () => {
      const windowId = settingsBrowserWindow();
      if (!windowId) throw new Error("Open a browser window first");
      void focusWindow(windowId);
      await connectGoogleDrive(windowId, clientId, secret);
    });
  return (
    <View>
      <Help>
        In Google Cloud Console, enable the Drive API and create an OAuth client of type "Desktop app" (add yourself as a test user). Ardia opens Google's consent page in a tab and reads the result from its redirect; it asks only to see your files' names and dates.
      </Help>
      <FormField label="Client ID">
        <TextField value={clientId} onChangeText={setClientId} placeholder="…apps.googleusercontent.com" />
      </FormField>
      <FormField label="Client secret">
        <TextField value={secret} onChangeText={setSecret} secure />
      </FormField>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={busy ? "Waiting for Google…" : "Sign In with Google…"} kind="primary" disabled={!clientId.trim() || !secret.trim() || busy} onPress={go} />
      </DialogActions>
    </View>
  );
}
