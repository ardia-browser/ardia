import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";

const calendarOffered = () => PLATFORM_FEATURES.calendar;
const calendarOn = (_: unknown, env: SettingsEnv) => PLATFORM_FEATURES.calendar && !!env.calendarAccess;
const LINK_WORDS = ["arc", "air traffic control", "atc", "links from other apps", "route links", "open links in profile", "default browser"];

export const automationRows = {
  automations: [
    {
      section: "Calendar",
      rows: {
        calendarAccess: {
          title: "Calendar access",
          keywords: ["connect calendar", "google calendar", "outlook", "icloud"],
          shown: calendarOffered,
        },
        meetingAlert: {
          title: "Meeting alert",
          keywords: ["reminder", "join", "popup", "show next meeting alert"],
          shown: calendarOn,
          needs: "Allow calendar access to use this",
        },
        meetingAlertCondition: {
          title: "Show alerts",
          explained: true,
          description: "With Always, alerts also show while you're in another app.",
          keywords: ["system alerts", "banner"],
          shown: calendarOn,
          needs: "Allow calendar access to use this",
        },
        calendarPreview: {
          title: "Show calendar preview",
          description: "Hover a pinned calendar tab to see your day.",
          keywords: ["hover"],
          shown: calendarOn,
          needs: "Allow calendar access to use this",
        },
        countdown: {
          title: "Countdown to next meeting",
          description: "How long before a meeting the badge appears.",
          keywords: ["countdown", "minutes", "lead time", "next meeting", "start countdown", "now", "dismiss", "show time to next meeting"],
          shown: calendarOn,
          needs: "Allow calendar access to use this",
        },
        groupMeetingTabs: {
          title: "Group tabs for meetings",
          description: "Joining a call puts its tabs in a group.",
          keywords: ["zoom", "meet", "call", "tab groups", "automatically group tabs for meetings", "calendar"],
          shown: calendarOn,
          needs: "Allow calendar access to use this",
        },
      },
    },
    {
      section: "Live folders",
      rows: {
        liveFolders: {
          title: "Live folders",
          explained: true,
          description: "Right-click the sidebar and choose New Live Folder. Each profile has its own folders and accounts.",
          keywords: ["new live folder", "hidden", "refresh", "stack", "stacked pull requests", "group stacked pull requests", "completed", "merged", "closed", "show completed pull requests"],
        },
        github: {
          title: "GitHub",
          description: "Your pull requests and review requests.",
          keywords: ["pull requests", "connect"],
        },
        bitbucket: {
          title: "Bitbucket",
          description: "Your open pull requests.",
          keywords: ["pull requests", "connect"],
        },
        notion: {
          title: "Notion",
          description: "Recently edited pages.",
          keywords: ["documents", "connect"],
        },
        confluence: {
          title: "Confluence",
          description: "Pages you created, edited or watch.",
          keywords: ["documents", "atlassian", "connect"],
        },
        gdrive: {
          title: "Google Drive",
          description: "Recently changed documents.",
          keywords: ["documents", "docs", "connect"],
        },
      },
    },
    {
      section: "Link routing",
      rows: {
        linkRules: {
          title: "Rules",
          explained: true,
          description: "The first rule that matches a link decides where it opens.",
          keywords: [...LINK_WORDS, "work profile", "rule", "add rule", "tab group", "group", "link rules", "hooks", "hooks.json", "link.opening", "automation", "link hooks from hooks.json"],
        },
        testLink: {
          title: "Test a link",
          explained: true,
          description: "See where a link would open, without opening it.",
          keywords: ["air traffic control", "atc", "test", "preview", "check", "try a link"],
        },
        linkFallback: {
          title: "Links no rule catches",
          explained: true,
          description: "Where links open when no rule decides.",
          keywords: ["everything else", "fallback", "otherwise", "air traffic control", "links from other apps"],
        },
        linkFallbackGroup: {
          title: "Tab group",
          description: "The group these links join.",
          keywords: ["everything else", "fallback", "tab group", "group"],
        },
        appLinks: {
          title: "Apps that open links",
          explained: true,
          description: "Sites that open another app without asking first.",
          keywords: ["external apps", "protocol handlers", "zoom links", "apps allowed to open links"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "automations">;
