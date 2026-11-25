# Security policy

Ardia holds your cookies, passwords and sessions, so we take security reports seriously. Thanks for helping keep
it safe.

## Supported versions

| Version | Fixes |
| --- | --- |
| The latest stable release | ✅ |
| The latest nightly | ✅ |
| Anything older | ❌ Update first |

A fix usually ships as a nightly first and then in the next stable. Ardia updates itself: on a Mac through the
built-in updater (Settings › General picks stable or nightly), on Linux through Check for Updates, and on Windows from
the `windows-alpha` release. If you installed it with a package manager (Homebrew, a Linux package), update it there.
If you're on an older version, update and check the problem is still there before you report it.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: [Report a vulnerability](https://github.com/ardia-browser/ardia/security/advisories/new)
(the repository's **Security** tab › **Report a vulnerability**). The report stays private between you, the
maintainers and anyone we invite to help fix it.

Please include:

- what an attacker can do, and what they need first (a page you visit, an extension, local access, a shared
  network…);
- the steps to reproduce it, and a proof of concept if you have one;
- the Ardia version and your OS version (Help › Copy Diagnostics has both), and whether you're on stable or nightly;
- anything you've already found about the cause.

## What to expect

We're a small team, so these are aims rather than promises:

- We confirm we've received your report within a week.
- We tell you whether we can reproduce it and how serious we think it is, and keep you posted while we fix it.
- We aim to ship a fix for a confirmed serious problem within 30 days, usually much sooner, as a nightly first.
- When the fix is out, we publish a GitHub Security Advisory and credit you by name, unless you'd rather we didn't.
  Where it's warranted, we request a CVE for it.

Please give us a reasonable chance to ship a fix before you publish anything, and tell us when you plan to.

## Scope

In scope:

- The browser app on macOS, Linux and Windows (this repository), including ArdiaCore, the control socket and its
  token, the `ardia` command, sync, import and the updater.
- Ardia's engine patches on top of Chromium and Helium (`engine/`, `scripts/windows/engine/`).
- The phone app for iPhone and Android (`apps/phone`).
- ardia.dev and its services: the site, the problem-report and telemetry endpoints.
- The plugins and the command-line tool in [ardia-browser/plugins](https://github.com/ardia-browser/plugins).

Elsewhere:

- A bug in Chromium itself, one that Chrome has too, belongs to Chromium:
  [report it there](https://www.chromium.org/Home/chromium-security/reporting-security-bugs/). If Ardia hasn't
  picked up a Chromium security fix yet, that's ours, so tell us.
- A bug in Helium's own patches can go to [Helium](https://github.com/imputnet/helium-chromium) or to us; we'll pass it
  on.
- Not counted: attacks that need someone who already controls your computer or your unlocked account, volume denial
  of service, social engineering, and missing hardening with no real way to attack it.

## Safe harbor

We won't take legal action against you, or ask anyone else to, for security research done in good faith under this
policy. Good faith means you:

- test only against your own accounts, devices and data, and stop and tell us if you reach anyone else's;
- don't degrade ardia.dev or its services, and don't run automated scans against them at volume;
- don't keep, share or change data that isn't yours beyond what you need to show the problem;
- give us a reasonable chance to fix it before you publish anything.

If you're not sure whether something is allowed, ask us in your report first.
