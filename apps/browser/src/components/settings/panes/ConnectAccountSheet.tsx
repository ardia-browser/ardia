import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { copyText } from "../../../state/app/system";
import { focusWindow } from "../../../state/windows/nativeWindow";
import { connectGoogleDrive } from "../../../state/live/googleAuth";
import { connectBitbucket, connectConfluence, connectGithub, connectNotion, SOURCES, startGithubDeviceFlow, type DeviceFlow } from "../../../state/live/sources";
import { accountOf, live, updateConfig } from "../../../state/live/store";
import type { LiveSourceId } from "../../../state/live/types";
import { openUrlFromSettings, settingsBrowserWindow } from "../../../state/settings/settingsWindows";
import { closeSettingsSheet } from "../../../state/settings/sheet";
import { Button, DialogActions, DialogTitle, Divider, proseLineHeight, Sheet, space, Text, TextField } from "../../ui";
import { perLook } from "../../ui/tokens";
import { Favicon } from "../../favicon/Favicon";
import { FormField } from "../Form";
import { settingsType } from "../tokens";

export function ConnectAccountSheet({ id, profileId }: { id: LiveSourceId; profileId: string }) {
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
    case "github":
      body = <GithubConnect profileId={profileId} busy={busy} run={run} />;
      break;
    case "bitbucket":
      body = <BitbucketConnect profileId={profileId} busy={busy} run={run} />;
      break;
    case "notion":
      body = <NotionConnect profileId={profileId} busy={busy} run={run} />;
      break;
    case "confluence":
      body = <ConfluenceConnect profileId={profileId} busy={busy} run={run} />;
      break;
    case "gdrive":
      body = <GoogleConnect profileId={profileId} busy={busy} run={run} />;
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

type ConnectProps = { profileId: string; busy: boolean; run(task: () => Promise<void>): Promise<void> };

const NOTE_TOP = { marginTop: space.ml } as const;
const BODY_TOP = { marginTop: space.l } as const;
const HELP = perLook(() => ({ lineHeight: proseLineHeight.small }) as const);
const CODE = perLook(() => ({ ...settingsType.code, textAlign: "center", marginTop: space.xl }) as const);
const SPLIT = { marginVertical: space.xl } as const;

function Help({ children }: { children: ReactNode }) {
  return (
    <Text size="small" tone="textSecondary" style={HELP()}>
      {children}
    </Text>
  );
}

function GithubConnect({ profileId, busy, run }: ConnectProps) {
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(live().config.githubClientId);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  useEffect(() => () => flow?.cancel(), [flow]);

  const signIn = () =>
    run(async () => {
      updateConfig({ githubClientId: clientId.trim() });
      const f = await startGithubDeviceFlow(profileId, clientId.trim());
      setFlow(f);
      copyText(f.userCode);
      openUrlFromSettings(f.verificationUri, profileId);
      await f.done;
    });

  if (flow) {
    return (
      <View>
        <Help>Enter this code on GitHub (it's on your clipboard), then approve Ardia. This sheet closes when you're signed in.</Help>
        <Text selectable weight="semibold" style={CODE()}>
          {flow.userCode}
        </Text>
        <DialogActions>
          <Button title="Cancel" onPress={() => (flow.cancel(), setFlow(null))} />
          <Button title="Open GitHub" kind="primary" onPress={() => openUrlFromSettings(flow.verificationUri, profileId)} />
        </DialogActions>
      </View>
    );
  }
  return (
    <View>
      <Help>
        Paste a personal access token (classic: "repo" and "read:org" scopes; fine-grained: read access to pull requests, checks and metadata).
      </Help>
      <FormField label="Personal access token">
        <TextField value={token} onChangeText={setToken} placeholder="ghp_…" secure onSubmit={() => token && void run(() => connectGithub(profileId, token))} />
      </FormField>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={busy ? "Checking…" : "Connect"} kind="primary" disabled={!token.trim() || busy} onPress={() => void run(() => connectGithub(profileId, token))} />
      </DialogActions>
      <Divider thick style={SPLIT} />
      <Help>Or sign in with your own GitHub OAuth app (Settings › Developer settings › OAuth Apps, with Device Flow enabled).</Help>
      <FormField label="OAuth app client ID">
        <TextField value={clientId} onChangeText={setClientId} placeholder="Iv1.…" />
      </FormField>
      <DialogActions>
        <Button title="Sign In with GitHub…" disabled={!clientId.trim() || busy} onPress={() => void signIn()} />
      </DialogActions>
    </View>
  );
}

function BitbucketConnect({ profileId, busy, run }: ConnectProps) {
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const go = () => void run(() => connectBitbucket(profileId, user, token));
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

function NotionConnect({ profileId, busy, run }: ConnectProps) {
  const [token, setToken] = useState("");
  const go = () => void run(() => connectNotion(profileId, token));
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

function ConfluenceConnect({ profileId, busy, run }: ConnectProps) {
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const go = () => void run(() => connectConfluence(profileId, site, email, token));
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

function GoogleConnect({ profileId, busy, run }: ConnectProps) {
  const [clientId, setClientId] = useState(accountOf(profileId, "gdrive")?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const go = () =>
    void run(async () => {
      const windowId = settingsBrowserWindow(profileId);
      if (!windowId) throw new Error("Open a browser window first");
      void focusWindow(windowId);
      await connectGoogleDrive(windowId, profileId, clientId, secret);
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
