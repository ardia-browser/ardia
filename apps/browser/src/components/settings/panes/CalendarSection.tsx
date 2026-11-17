import { View } from "react-native";
import { type SystemCalendar, calendarBlocked, connectCalendar, openCalendarPrivacy, setCalendarHidden, useCalendar } from "../../../state/live/calendar";
import { ALERT_LEADS, COUNTDOWN_LEADS, countdownLeadTitle } from "../../../state/live/meetings";
import { updateCalendarSettings, useLive } from "../../../state/live/store";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { Box, Button, Checkbox, EmptyState, PopUp, radius, space, Text, Toggle, type Option } from "../../ui";
import { perLook } from "../../ui/tokens";
import { Group, Row, SectionHeader } from "../Form";

const COUNTDOWN_OFF = "off";
const COUNTDOWN_OPTIONS: Option<string>[] = [
  { value: COUNTDOWN_OFF, title: "Off" },
  ...COUNTDOWN_LEADS.map((m, i) => ({ value: String(m), title: countdownLeadTitle(m), separatorBefore: i === 0 })),
];

export function CalendarSection() {
  if (!PLATFORM_FEATURES.calendar) return null;
  return <OfferedCalendarSection />;
}

function OfferedCalendarSection() {
  const settings = useLive((s) => s.calendar);
  const { access, calendars, requesting, requestError } = useCalendar();
  const autoGroup = useSettings((s) => s.autoGroupMeetingTabs);
  const connected = access === "fullAccess" || access === "fixture";
  const blocked = calendarBlocked(access);
  const owned = calendars.filter((c) => c.owned);
  const others = calendars.filter((c) => !c.owned);
  const countdown = settings.showTimeToNext ? String(settings.countdownLead) : COUNTDOWN_OFF;
  const pickCountdown = (value: string) =>
    updateCalendarSettings(value === COUNTDOWN_OFF ? { showTimeToNext: false } : { showTimeToNext: true, countdownLead: Number(value) });

  return (
    <View>
      <SectionHeader
        title="Calendar"
        description="Pin a calendar to see your day, a countdown and meeting alerts. Uses the Calendar app's accounts."
      />
      <Group>
        <Row
          anchor="automations.calendarAccess"
          description={
            access === "fixture"
              ? "Development build: using calendar-fixture.json"
              : connected
                ? `Connected · ${calendars.length === 1 ? "1 calendar" : `${calendars.length} calendars`}`
                : blocked
                  ? (requestError ?? "Ardia isn't allowed to read your calendars. Allow it in System Settings › Privacy & Security › Calendars.")
                  : (requestError ?? "Not connected")
          }
        >
          {blocked ? (
            <Button title="Open System Settings" onPress={openCalendarPrivacy} />
          ) : !connected ? (
            <Box row gap="s">
              {requestError ? <Button title="Open System Settings" onPress={openCalendarPrivacy} /> : null}
              <Button title={requesting ? "Connecting…" : "Connect Calendar…"} kind="primary" disabled={requesting} onPress={() => void connectCalendar()} />
            </Box>
          ) : null}
        </Row>
        <Row anchor="automations.meetingAlert">
          <PopUp value={settings.alertLead} options={ALERT_LEADS.map((l) => ({ value: l.value, title: l.title, separatorBefore: l.value === "start" }))} onChange={(v) => updateCalendarSettings({ alertLead: v })} minWidth={170} />
        </Row>
        <Row anchor="automations.meetingAlertCondition">
          <PopUp
            value={settings.alertCondition}
            options={[
              { value: "always", title: "Always" },
              { value: "activeOnly", title: "Only When Active" },
            ]}
            disabled={settings.alertLead === "never"}
            onChange={(v) => updateCalendarSettings({ alertCondition: v })}
            minWidth={170}
          />
        </Row>
        <Row anchor="automations.calendarPreview">
          <Toggle value={settings.showPreview} accessibilityLabel="Show calendar preview" onChange={(v) => updateCalendarSettings({ showPreview: v })} />
        </Row>
        <Row anchor="automations.countdown">
          <PopUp value={countdown} options={COUNTDOWN_OPTIONS} onChange={pickCountdown} minWidth={170} accessibilityLabel="Countdown to next meeting" />
        </Row>
        <Row anchor="automations.groupMeetingTabs">
          <Toggle value={autoGroup} accessibilityLabel="Group tabs for meetings" onChange={(v) => updateSettings({ autoGroupMeetingTabs: v })} />
        </Row>
      </Group>

      {connected && calendars.length ? (
        <>
          <SectionHeader title="Active calendars" description="Meetings from unchecked calendars don't show or alert." />
          <Group>
            {owned.length ? <CalendarList title="My Calendars" calendars={owned} hidden={settings.hiddenCalendarIds} /> : null}
            {others.length ? <CalendarList title="Other Calendars" calendars={others} hidden={settings.hiddenCalendarIds} /> : null}
          </Group>
        </>
      ) : connected ? (
        <View style={NO_CALENDARS}>
          <EmptyState symbol="calendar" title="No calendars found" subtitle="Add accounts in the Calendar app." />
        </View>
      ) : null}
    </View>
  );
}

function CalendarList({ title, calendars, hidden }: { title: string; calendars: SystemCalendar[]; hidden: string[] }) {
  return (
    <Box padY="s">
      <Text size="caption" weight="semibold" tone="textSecondary" style={LIST_TITLE}>
        {title}
      </Text>
      {calendars.map((c) => (
        <Row
          key={c.id}
          icon={<View style={[CALENDAR_COLOR(), { backgroundColor: c.color }]} />}
          title={<Checkbox value={!hidden.includes(c.id)} onChange={(v) => setCalendarHidden(c.id, !v)} label={c.title} />}
          description={c.account}
        />
      ))}
    </Box>
  );
}

const NO_CALENDARS = { marginTop: space.l } as const;
const LIST_TITLE = { marginLeft: space.l, marginBottom: space.xxs } as const;
const CALENDAR_COLOR = perLook(() => ({ width: 10, height: 10, borderRadius: radius.hair }) as const);
