import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BROWSERS, IDS, SHOTS, dragBy, dragTo, gotoDb, launch, openPage, rowsOf, schemaOf, startHarness, waitFor } from "./dbHarness.mjs";

mkdirSync(SHOTS, { recursive: true });

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (s, days) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return iso(new Date(y, m - 1, d + days));
};

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness?.stop();
});

async function withPage(browserName, fn, scheme = "light") {
  const browser = await launch(browserName);
  try {
    const { context, page, errors } = await openPage(browser, `${harness.url}?reset`, { colorScheme: scheme });
    try {
      await fn(page);
      assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function dueProp(page) {
  const schema = await schemaOf(page, IDS.tasks);
  return schema.find((p) => p.name === "Due").id;
}

for (const name of BROWSERS) {
  describe(`database views (${name})`, { timeout: 120_000 }, () => {
    test("calendar: drag an item to another day, navigate months, add on a day", async () => {
      await withPage(name, async (page) => {
        await gotoDb(page, harness.url, IDS.tasks, "calendar");
        await page.waitForSelector('[data-testid="db-calendar"] [data-testid="db-cal-item"]', { timeout: 10_000 });
        const due = await dueProp(page);
        const rows = await rowsOf(page, IDS.tasks);
        const single = rows.filter((r) => r.props[due] && !r.props[due].end);
        let source = null;
        for (const r of single) {
          const item = page.locator(`[data-testid="db-cal-day"][data-day="${r.props[due].start}"] [data-testid="db-cal-item"][data-row="${r.id}"]`);
          if (await item.count()) {
            source = { row: r, item };
            break;
          }
        }
        assert.ok(source, "a single-day item is visible in this month");
        const from = source.row.props[due].start;
        const days = await page.locator('[data-testid="db-cal-day"]').evaluateAll((els) => els.map((e) => e.dataset.day));
        const target = days.find((d) => d !== from && Math.abs(new Date(d) - new Date(from)) >= 2 * 86400000 && Math.abs(new Date(d) - new Date(from)) < 10 * 86400000);
        await dragTo(page, source.item, page.locator(`[data-testid="db-cal-day"][data-day="${target}"]`));
        await waitFor(async () => (await rowsOf(page, IDS.tasks)).find((r) => r.id === source.row.id).props[due].start === target, { message: "date moved to the target day" });
        assert.equal(await page.locator(`[data-testid="db-cal-day"][data-day="${target}"] [data-testid="db-cal-item"][data-row="${source.row.id}"]`).count(), 1);

        const title = page.locator(".db-cal-title");
        const now = await title.textContent();
        await page.click('[data-testid="db-cal-next"]');
        await waitFor(async () => (await title.textContent()) !== now, { message: "next month" });
        const next = await title.textContent();
        await page.click('[data-testid="db-cal-prev"]');
        await page.click('[data-testid="db-cal-prev"]');
        await waitFor(async () => ![now, next].includes(await title.textContent()), { message: "previous month" });
        await page.click('[data-testid="db-cal-today"]');
        await waitFor(async () => (await title.textContent()) === now, { message: "back to today" });

        const before = (await rowsOf(page, IDS.tasks)).length;
        const allDays = await page.locator('[data-testid="db-cal-day"]').evaluateAll((els) => els.map((e) => e.dataset.day));
        const addDay = allDays[allDays.length - 2];
        const cell = page.locator(`[data-testid="db-cal-day"][data-day="${addDay}"]`);
        await cell.hover();
        await cell.locator('[data-testid="db-cal-add"]').click();
        const added = await waitFor(async () => {
          const list = await rowsOf(page, IDS.tasks);
          return list.length === before + 1 && list.find((r) => !rows.some((o) => o.id === r.id));
        }, { message: "a new row" });
        assert.equal(added.props[due].start, addDay);
      });
    });

    test("timeline: move a bar, resize its end, change zoom", async () => {
      await withPage(name, async (page) => {
        await gotoDb(page, harness.url, IDS.tasks, "timeline");
        await page.waitForSelector('[data-testid="db-tl-bar"]', { timeout: 10_000 });
        const due = await dueProp(page);
        const rows = await rowsOf(page, IDS.tasks);
        const row = rows.find((r) => r.props[due] && !r.props[due].end);
        const bar = page.locator(`[data-testid="db-tl-bar"][data-row="${row.id}"]`);
        await bar.scrollIntoViewIfNeeded();
        const start = row.props[due].start;
        await dragBy(page, bar, 36, 0);
        await waitFor(async () => (await rowsOf(page, IDS.tasks)).find((r) => r.id === row.id).props[due].start === shift(start, 3), { message: "bar moved 3 days" });

        const moved = shift(start, 3);
        const handle = bar.locator('[data-testid="db-tl-handle-end"]');
        await bar.hover();
        await dragBy(page, handle, 24, 0);
        const after = await waitFor(async () => {
          const v = (await rowsOf(page, IDS.tasks)).find((r) => r.id === row.id).props[due];
          return v.end ? v : null;
        }, { message: "bar got an end date" });
        assert.equal(after.start, moved);
        assert.equal(after.end, shift(moved, 2));

        const width = (await bar.boundingBox()).width;
        await page.click('[data-testid="db-tl-zoom"]');
        await page.click('[data-testid="db-tl-zoom-week"]');
        await waitFor(async () => (await page.locator('[data-testid="db-tl-zoom"]').textContent()).includes("Week"), { message: "zoom label" });
        await waitFor(async () => (await bar.boundingBox()).width > width + 20, { message: "wider bar at week zoom" });
        await page.click('[data-testid="db-tl-today"]');
      });
    });

    test("chart: renders bars with whole-number ticks", async () => {
      await withPage(name, async (page) => {
        await gotoDb(page, harness.url, IDS.tasks, "chart");
        await page.waitForSelector('[data-testid="db-chart"] [data-testid="db-chart-bar"]', { timeout: 10_000 });
        assert.ok((await page.locator('[data-testid="db-chart-bar"]').count()) >= 2);
        const ticks = await page.locator(".db-chart-axis").allTextContents();
        assert.ok(ticks.some((t) => t === "0"));
        assert.ok(!ticks.some((t) => /^\d+\.\d+$/.test(t)), `ticks: ${ticks.join(",")}`);
        await page.click('[data-testid="db-chart-type"] button:has-text("Donut")');
        await page.waitForSelector(".db-chart-donut", { timeout: 5000 });
        await page.click('[data-testid="db-chart-type"] button:has-text("Line")');
        await page.waitForSelector(".db-chart-line", { timeout: 5000 });
      });
    });

    for (const scheme of ["light", "dark"]) {
      test(`screenshots ${scheme}`, async () => {
        await withPage(
          name,
          async (page) => {
            for (const view of ["calendar", "timeline", "chart"]) {
              await gotoDb(page, harness.url, IDS.tasks, view);
              await page.waitForSelector(`[data-testid="db-${view === "timeline" ? "timeline" : view}"]`, { timeout: 10_000 });
              await page.waitForTimeout(150);
              await page.screenshot({ path: join(SHOTS, `views-${view}-${scheme}-${name}.png`), fullPage: true });
            }
          },
          scheme,
        );
      });
    }
  });
}
