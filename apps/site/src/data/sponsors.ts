export const COMPANY_SPONSORS = [
  {
    key: "greptile",
    name: "Greptile",
    href: "https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source",
    does: "reads every pull request before we do",
  },
  {
    key: "blacksmith",
    name: "Blacksmith",
    href: "https://www.blacksmith.sh",
    does: "runs our CI",
  },
] as const;
export type CompanySponsorKey = (typeof COMPANY_SPONSORS)[number]["key"];
