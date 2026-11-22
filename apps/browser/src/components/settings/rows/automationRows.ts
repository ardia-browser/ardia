import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { t } from "../../../lib/uiLanguage";


const calendarOffered = () => PLATFORM_FEATURES.calendar;
const calendarOn = (_: unknown, env: SettingsEnv) => PLATFORM_FEATURES.calendar && !!env.calendarAccess;
const LINK_WORDS = ["arc", t(`air traffic control`), "atc", t(`links from other apps`), t(`route links`), t(`open links in profile`), t(`default browser`)];

export const automationRows = {
  automations: [
    {
      section: t(`Calendar`),
      rows: {
        calendarAccess: {
          title: t(`Calendar access`),
          keywords: [t(`connect calendar`), t(`google calendar`), "outlook", "icloud"],
          shown: calendarOffered,
        },
        meetingAlert: {
          title: t(`Meeting alert`),
          keywords: ["reminder", "join", "popup", t(`show next meeting alert`)],
          shown: calendarOn,
          needs: t(`Allow calendar access to use this`),
        },
        meetingAlertCondition: {
          title: t(`Show alerts`),
          explained: true,
          description: t(`With Always, alerts also show while you're in another app.`),
          keywords: [t(`system alerts`), "banner"],
          shown: calendarOn,
          needs: t(`Allow calendar access to use this`),
        },
        calendarPreview: {
          title: t(`Show calendar preview`),
          description: t(`Hover a pinned calendar tab to see your day.`),
          keywords: ["hover"],
          shown: calendarOn,
          needs: t(`Allow calendar access to use this`),
        },
        countdown: {
          title: t(`Countdown to next meeting`),
          description: t(`How long before a meeting the badge appears.`),
          keywords: ["countdown", "minutes", t(`lead time`), t(`next meeting`), t(`start countdown`), "now", "dismiss", t(`show time to next meeting`)],
          shown: calendarOn,
          needs: t(`Allow calendar access to use this`),
        },
        groupMeetingTabs: {
          title: t(`Group tabs for meetings`),
          description: t(`Joining a call puts its tabs in a group.`),
          keywords: ["zoom", "meet", "call", t(`tab groups`), t(`automatically group tabs for meetings`), "calendar"],
          shown: calendarOn,
          needs: t(`Allow calendar access to use this`),
        },
      },
    },
    {
      section: t(`Live folders`),
      rows: {
        liveFolders: {
          title: t(`Live folders`),
          explained: true,
          description: t(`Right-click the sidebar and choose New Live Folder.`),
          keywords: [t(`new live folder`), "hidden", "refresh", "stack", t(`stacked pull requests`), t(`group stacked pull requests`), "completed", "merged", "closed", t(`show completed pull requests`)],
        },
        github: {
          title: t(`GitHub`),
          description: t(`Your pull requests and review requests.`),
          keywords: [t(`pull requests`), "connect"],
        },
        bitbucket: {
          title: t(`Bitbucket`),
          description: t(`Your open pull requests.`),
          keywords: [t(`pull requests`), "connect"],
        },
        notion: {
          title: t(`Notion`),
          description: t(`Recently edited pages.`),
          keywords: ["documents", "connect"],
        },
        confluence: {
          title: t(`Confluence`),
          description: t(`Pages you created, edited or watch.`),
          keywords: ["documents", "atlassian", "connect"],
        },
        gdrive: {
          title: t(`Google Drive`),
          description: t(`Recently changed documents.`),
          keywords: ["documents", "docs", "connect"],
        },
      },
    },
    {
      section: t(`Link routing`),
      rows: {
        linkRules: {
          title: t(`Rules`),
          explained: true,
          description: t(`The first rule that matches a link decides where it opens.`),
          keywords: [...LINK_WORDS, t(`work profile`), "rule", t(`add rule`), t(`tab group`), "group", t(`link rules`), "hooks", "hooks.json", "link.opening", "automation", t(`link hooks from hooks.json`)],
        },
        testLink: {
          title: t(`Test a link`),
          explained: true,
          description: t(`See where a link would open, without opening it.`),
          keywords: [t(`air traffic control`), "atc", "test", "preview", "check", t(`try a link`)],
        },
        linkFallback: {
          title: t(`Links no rule catches`),
          explained: true,
          description: t(`Where links open when no rule decides.`),
          keywords: [t(`everything else`), "fallback", "otherwise", t(`air traffic control`), t(`links from other apps`)],
        },
        linkFallbackGroup: {
          title: t(`Tab group`),
          description: t(`The group these links join.`),
          keywords: [t(`everything else`), "fallback", t(`tab group`), "group"],
        },
        appLinks: {
          title: t(`Apps that open links`),
          explained: true,
          description: t(`Sites that open another app without asking first.`),
          keywords: [t(`external apps`), t(`protocol handlers`), t(`zoom links`), t(`apps allowed to open links`)],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "automations">;
