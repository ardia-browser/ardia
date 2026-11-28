import { View } from "react-native";
import { shortAgo } from "../../../lib/time";
import { spokenList } from "../../../lib/lists";
import { plural } from "../../../state/browser/model";
import type { BrowserSource } from "../../../state/import/apply";
import type { ImportFlow } from "../../../state/import/flow";
import {
  chooseAllConflicts,
  chooseConflictVersion,
  closeConflictList,
  handChanges,
  importChosenPasswords,
  openConflictList,
  pickConflictVersions,
  setConflictFilter,
} from "../../../state/import/importOutcome";
import { conflictBrowsers, conflictRows, matchingConflicts, newerCounts, profileLabels } from "../../../state/import/passwordConflicts";
import { useProfileOrder, useProfileRecords } from "../../../state/profiles/hooks";
import { Button, Group, Row, SearchField, Segmented, space, Symbol, Text, useTheme } from "../../ui";
import { Spacer, Title } from "../Parts";
import { BrowserIcon, ChoiceRow } from "../Rows";
import { importLayout } from "../tokens";

type ConflictsStep = Extract<ImportFlow["step"], { name: "conflicts" }>;

const conflictsOf = (flow: ImportFlow): ConflictsStep | null => (flow.step.name === "conflicts" ? flow.step : null);

function involved(flow: ImportFlow, step: ConflictsStep): BrowserSource[] {
  const ids = conflictBrowsers(step.conflicts, flow.run?.ids ?? flow.browsers.map((b) => b.id));
  return ids.flatMap((id) => flow.browsers.filter((b) => b.id === id));
}

export function ConflictsBody({ flow }: { flow: ImportFlow }) {
  const step = conflictsOf(flow);
  if (!step) return null;
  return step.view === "list" ? <ChooseEach flow={flow} step={step} /> : <Summary flow={flow} step={step} />;
}

function Summary({ flow, step }: { flow: ImportFlow; step: ConflictsStep }) {
  const theme = useTheme();
  const browsers = involved(flow, step);
  const count = step.conflicts.length;
  const newer = newerCounts(step.conflicts);
  const changed = handChanges(step.custom);
  return (
    <>
      <Title
        title={count === 1 ? "1 password doesn't match" : `${count} passwords don't match`}
        subtitle={`${spokenList(browsers.map((b) => b.name))} saved different passwords for the same ${count === 1 ? "account" : "accounts"}. Which do you want to keep?`}
      />
      <View style={{ gap: space.s }}>
        <ChoiceRow
          selected={step.pick === "newest"}
          onPress={() => pickConflictVersions("newest", step.token)}
          icon={<Symbol name="clock" size={18} color={theme.icon} style={{ width: importLayout.browserIcon, height: importLayout.browserIcon }} />}
          title="Newest of each"
        />
        {browsers.map((b) => (
          <ChoiceRow
            key={b.id}
            selected={step.pick === b.id}
            onPress={() => pickConflictVersions(b.id, step.token)}
            icon={<BrowserIcon iconPath={b.iconPath} size={importLayout.browserIcon} />}
            title={b.name}
            detail={newer[b.id] ? `newer for ${newer[b.id]}` : undefined}
          />
        ))}
        {step.custom && (
          <ChoiceRow
            selected={step.pick === "custom"}
            onPress={() => pickConflictVersions("custom", step.token)}
            icon={<Symbol name="slider.horizontal.3" size={18} color={theme.icon} style={{ width: importLayout.browserIcon, height: importLayout.browserIcon }} />}
            title="Your choices"
            detail={changed ? `${changed} changed` : "none changed"}
          />
        )}
      </View>
    </>
  );
}

function ChooseEach({ flow, step }: { flow: ImportFlow; step: ConflictsStep }) {
  const browsers = involved(flow, step);
  const nameOf = (id: string) => browsers.find((b) => b.id === id)?.name ?? id;
  const iconOf = (id: string) => browsers.find((b) => b.id === id)?.iconPath;
  const profiles = useProfileRecords();
  const order = useProfileOrder();
  const destinations = profileLabels(
    [...new Set(step.conflicts.flatMap((c) => c.profileIds))],
    order.flatMap((id) => (profiles[id] ? [{ id, name: profiles[id].name, icon: profiles[id].icon }] : [])),
  );
  const shown = conflictRows(matchingConflicts(step.conflicts, step.filter));
  const choices = step.draft.choices;
  const now = Date.now();
  return (
    <>
      <Title title="Choose for each" subtitle="Pick which browser's password to keep for each account. Passwords stay hidden." />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, marginBottom: space.l }}>
        <View style={{ flex: 1 }}>
          <SearchField value={step.filter} onChangeText={(text) => setConflictFilter(text, step.token)} placeholder={`Search ${plural(step.conflicts.length, "account")}`} />
        </View>
        <Text tone="textSecondary" ardiaCentersCapitals>
          All:
        </Text>
        {browsers.map((b) => (
          <Button key={b.id} title={b.name} onPress={() => chooseAllConflicts(b.id, step.token)} />
        ))}
      </View>
      {shown.length ? (
        <Group>
          {shown.map(({ conflict: c, title, showsProfile }) => (
            <Row
              key={c.id}
              title={title}
              description={[c.username || "No username", showsProfile ? `into ${spokenList(c.profileIds.map((id) => destinations[id]!))}` : ""].filter(Boolean).join(" · ")}
            >
              <Segmented
                value={choices[c.id] ?? c.versions[0]!.browserId}
                onChange={(id) => chooseConflictVersion(c.id, id, step.token)}
                options={c.versions.map((v) => {
                  const age = v.at ? shortAgo(v.at, now) : "no date";
                  const icon = iconOf(v.browserId);
                  return {
                    value: v.browserId,
                    title: icon ? age : `${nameOf(v.browserId)} ${age}`,
                    label: `${nameOf(v.browserId)}, ${age}`,
                    lead: icon ? <BrowserIcon iconPath={icon} size={importLayout.segmentIcon} /> : undefined,
                  };
                })}
              />
            </Row>
          ))}
        </Group>
      ) : (
        <Text tone="textSecondary" style={{ textAlign: "center", marginTop: space.xl }}>
          {`No accounts match “${step.filter.trim()}”.`}
        </Text>
      )}
    </>
  );
}

export function ConflictsFooter({ flow }: { flow: ImportFlow }) {
  const step = conflictsOf(flow);
  if (!step) return null;
  if (step.view === "list")
    return (
      <>
        <Spacer />
        <Button title="Done" kind="primary" onPress={() => closeConflictList(step.token)} />
      </>
    );
  return (
    <>
      <Button variant="text" look="link" pad="none" title="Let me choose…" disabled={step.saving} onPress={() => openConflictList(step.token)} />
      <Spacer />
      <Button title={step.saving ? "Importing…" : "Import"} kind="primary" disabled={step.saving} onPress={() => void importChosenPasswords(step.token)} />
    </>
  );
}
