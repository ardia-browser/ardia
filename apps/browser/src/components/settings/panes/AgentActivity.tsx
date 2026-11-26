import { useEffect, useState } from "react";
import { ago } from "../../../lib/time";
import { orWarn } from "../../../lib/fallback";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { loadVaultActivity, useVaultActivity, type VaultEvent } from "../../../state/vault/activity";
import { setKeepsCodes, setLogShowsReasons, useVaultPrefs, vaultPrefs } from "../../../state/vault/prefs";
import { loadVaultAlways, removeAlwaysGrant, useVaultAlways } from "../../../state/vault/always";
import { removeVerificationSecret, vaultProblemText, vaultStoreState, verificationSecrets } from "../../../state/site/vaultCodes";
import { currentEngineProfile } from "../../../state/browser/current";
import { consentToken } from "../../../state/telemetry/client";
import { Button, Toggle } from "../../ui";
import { hostLabel } from "../../pages/PageLayout";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";

const SHOWN = 50;

const VERBS: Record<VaultEvent["kind"], string> = { grant: "Allowed", fill: "Signed in", refusal: "Refused", skip: "Didn't sign in on its own", end: "Task ended" };

const firstSite = (site: string | null) => (site ? (site.split(" ")[0] ?? site) : "");

function describe(e: VaultEvent) {
  const sites = e.site ? e.site.split(" ").map(hostLabel).join(", ") : "";
  const title = e.kind === "refusal" || e.kind === "skip" ? `${VERBS[e.kind]} (${e.outcome.replace(/_/g, " ")})${sites ? `: ${sites}` : ""}` : `${VERBS[e.kind]}${sites ? `: ${sites}` : ""}`;
  const parts = [e.program, e.account, e.via === "phone" ? "approved on iPhone" : e.via === "always" ? "always allowed" : e.via === "auto" ? "filled on its own" : null, ago(e.time)];
  const detail = parts.filter(Boolean).join(" · ");
  return { title, description: e.reason ? `${detail}\n“${e.reason}”` : detail };
}

export function AgentActivity({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const events = useVaultActivity((s) => s.events);
  useEffect(() => void vaultPrefs(), []);
  const showsReasons = useVaultPrefs((s) => s.logShowsReasons);
  const keepsCodes = useVaultPrefs((s) => s.keepsCodes);
  const grants = useVaultAlways((s) => s.grants);
  const [codes, setCodes] = useState<{ origin: string; username: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const loadCodes = () => void verificationSecrets(profile).then(setCodes, orWarn(undefined));
  useEffect(() => {
    void loadVaultActivity();
    void loadVaultAlways(consentToken());
    loadCodes();
    void vaultStoreState().then((state) => setProblem(vaultProblemText(state)), orWarn(undefined));
  }, [profile]);
  const mine = events.filter((e) => e.profile === profileId).slice(-SHOWN).reverse();
  const allowed = grants.filter((g) => g.profile === profileId);
  return (
    <>
      <SectionHeader title="Agent activity" description="Programs that sign in through the ardia command. Ardia fills the saved login itself, so they never see a password or a verification code." />
      <Group>
        <Row anchor="profiles.keepVerificationCodes">
          <Toggle value={keepsCodes} onChange={setKeepsCodes} />
        </Row>
        <Row anchor="profiles.agentReasonsInLog">
          <Toggle value={showsReasons} onChange={setLogShowsReasons} />
        </Row>
      </Group>
      {allowed.length > 0 && (
        <>
          <SectionHeader title="Always allowed" description="These programs sign in to these sites without asking." />
          <Group>
            {allowed.map((g) => (
              <Row key={`${g.origin}|${g.teamId}|${g.identifier}`} icon={<Favicon url={g.origin} />} title={hostLabel(g.origin)} description={`${g.program} (team ${g.teamId})`}>
                <Button title="Remove" onPress={() => void removeAlwaysGrant(g)} />
              </Row>
            ))}
          </Group>
        </>
      )}
      {(codes.length > 0 || problem) && (
        <>
          <SectionHeader title="Verification codes" description={problem ?? `Kept by Ardia on this ${PLATFORM_TERMS.computer}, next to the saved login.`} />
          <Group>
            {codes.map((c) => (
              <Row key={`${c.origin}|${c.username}`} icon={<Favicon url={c.origin} />} title={hostLabel(c.origin)} description={c.username}>
                <Button title="Remove" onPress={() => void removeVerificationSecret(profile, c.origin, c.username).then(loadCodes, orWarn(undefined))} />
              </Row>
            ))}
          </Group>
        </>
      )}
      <Group>
        {mine.length === 0 ? (
          <Row title="No agent sign-ins yet" />
        ) : (
          mine.map((e, index) => {
            const { title, description } = describe(e);
            return <Row key={`${e.time}:${index}`} icon={firstSite(e.site) ? <Favicon url={firstSite(e.site)} /> : undefined} title={title} description={description} />;
          })
        )}
      </Group>
    </>
  );
}
