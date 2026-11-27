import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BROWSERS, IDS, SHOTS, dragTo, launch, openPage, rowsOf, schemaOf, startHarness, waitFor } from "./dbHarness.mjs";

mkdirSync(SHOTS, { recursive: true });

let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness?.stop();
});

const urlFor = (db, view, extra = "") => `${harness.url}?db=${db}${view ? `&v=${view}` : ""}&reset${extra}`;

async function statusInfo(page) {
  const schema = await schemaOf(page, IDS.tasks);
  const status = schema.find((p) => p.type === "status");
  const byName = Object.fromEntries(status.options.map((o) => [o.name, o.id]));
  return { status, byName };
}

for (const name of BROWSERS) {
  describe(`board, list and gallery (${name})`, () => {
    let browser;
    before(async () => {
      browser = await launch(name);
    });
    after(async () => {
      await browser?.close();
    });

    async function open(view, opts = {}, db = IDS.tasks) {
      const s = await openPage(browser, urlFor(db, view), opts);
      await s.page.waitForSelector('[data-testid="db-view"]', { timeout: 15000 });
      return s;
    }

    test("board: drag a card to another column changes its status", async () => {
      const { context, page, errors } = await open("board");
      try {
        const { status, byName } = await statusInfo(page);
        const notStarted = byName["Not started"];
        const inProgress = byName["In progress"];
        const before = await rowsOf(page, IDS.tasks);
        const mover = before.find((r) => r.props[status.id] === notStarted);
        assert.ok(mover, "a Not started row exists");
        const card = page.locator(`[data-testid=db-board-column][data-group="${notStarted}"] [data-testid=db-card][data-row="${mover.id}"]`);
        const target = page.locator(`[data-testid=db-board-column][data-group="${inProgress}"] [data-testid=db-board-new]`);
        await card.waitFor({ timeout: 5000 });
        await dragTo(page, card, target, { toPos: { x: 60, y: -10 } });
        await waitFor(async () => (await rowsOf(page, IDS.tasks)).find((r) => r.id === mover.id)?.props[status.id] === inProgress, { message: "status moved to In progress" });
        await page.locator(`[data-testid=db-board-column][data-group="${inProgress}"] [data-testid=db-card][data-row="${mover.id}"]`).waitFor({ timeout: 5000 });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("board: drag within a column reorders", async () => {
      const { context, page, errors } = await open("board");
      try {
        const { byName } = await statusInfo(page);
        const col = page.locator(`[data-testid=db-board-column][data-group="${byName["Not started"]}"]`);
        const cards = col.locator("[data-testid=db-card]");
        await cards.first().waitFor({ timeout: 5000 });
        const ids = await cards.evaluateAll((els) => els.map((e) => e.dataset.row));
        assert.ok(ids.length >= 2, "column has two cards");
        const last = cards.nth(ids.length - 1);
        await dragTo(page, last, cards.first(), { toPos: { x: 40, y: 4 } });
        await waitFor(async () => (await cards.evaluateAll((els) => els.map((e) => e.dataset.row)))[0] === ids.at(-1), { message: "card moved to the top" });
        const rows = await rowsOf(page, IDS.tasks);
        const order = rows.map((r) => r.id).filter((id) => ids.includes(id));
        assert.equal(order[0], ids.at(-1));
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("board: + New creates a card in that column with a typed title", async () => {
      const { context, page, errors } = await open("board");
      try {
        const { status, byName } = await statusInfo(page);
        const doneId = byName["Done"];
        const col = page.locator(`[data-testid=db-board-column][data-group="${doneId}"]`);
        const before = (await rowsOf(page, IDS.tasks)).length;
        await col.locator("[data-testid=db-board-new]").click();
        const input = page.locator("[data-testid=db-card-title-input]");
        await input.waitFor({ timeout: 5000 });
        await input.fill("Board made this");
        await input.press("Enter");
        const made = await waitFor(async () => (await rowsOf(page, IDS.tasks)).find((r) => r.title === "Board made this"), { message: "new row titled" });
        assert.equal(made.props[status.id], doneId);
        assert.equal((await rowsOf(page, IDS.tasks)).length, before + 1);
        await col.locator(`[data-testid=db-card][data-row="${made.id}"]`).waitFor({ timeout: 5000 });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("board: hiding a group moves it to Hidden groups", async () => {
      const { context, page, errors } = await open("board");
      try {
        const { byName } = await statusInfo(page);
        const key = byName["In progress"];
        const col = page.locator(`[data-testid=db-board-column][data-group="${key}"]`);
        await col.hover();
        await col.locator("[data-testid=db-board-group-more]").click();
        await page.locator("[data-testid=db-board-hide-group]").click();
        await page.locator(`[data-testid=db-board-hidden-item][data-group="${key}"]`).waitFor({ timeout: 5000 });
        assert.equal(await col.count(), 0);
        await page.locator(`[data-testid=db-board-hidden-item][data-group="${key}"]`).click();
        await col.waitFor({ timeout: 5000 });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("list: rows render, click opens peek, New page adds a row", async () => {
      const { context, page, errors } = await open("list");
      try {
        const rows = page.locator("[data-testid=db-list-row]");
        await rows.first().waitFor({ timeout: 5000 });
        const all = await rowsOf(page, IDS.tasks);
        assert.equal(await rows.count(), all.length);
        const first = await rows.first().getAttribute("data-row");
        await rows.first().click();
        await page.locator(`[data-testid=db-peek][data-row="${first}"]`).waitFor({ timeout: 5000 });
        await page.keyboard.press("Escape");
        await waitFor(async () => (await page.locator("[data-testid=db-peek]").count()) === 0, { message: "peek closed" });
        await page.locator("[data-testid=db-list-new]").click();
        await waitFor(async () => (await rowsOf(page, IDS.tasks)).length === all.length + 1, { message: "row added" });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("gallery: cards render and + New adds a row", async () => {
      const { context, page, errors } = await open("gallery");
      try {
        const cards = page.locator("[data-testid=db-gallery-card]");
        await cards.first().waitFor({ timeout: 5000 });
        const all = await rowsOf(page, IDS.tasks);
        assert.equal(await cards.count(), all.length);
        await page.locator("[data-testid=db-gallery-new]").click();
        await waitFor(async () => (await rowsOf(page, IDS.tasks)).length === all.length + 1, { message: "row added" });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("big table renders 2000 rows virtualized", async () => {
      const { context, page, errors } = await open(null, {}, IDS.big);
      try {
        await waitFor(async () => (await rowsOf(page, IDS.big)).length === 2000, { timeout: 15000, message: "2000 rows" });
        const rendered = await page.locator("[data-row]").count();
        assert.ok(rendered > 0 && rendered < 400, `rendered ${rendered} row elements`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    test("screenshots light and dark", async () => {
      for (const scheme of ["light", "dark"]) {
        for (const view of ["board", "list", "gallery"]) {
          const { context, page, errors } = await open(view, { colorScheme: scheme });
          try {
            await page.waitForTimeout(150);
            await page.screenshot({ path: join(SHOTS, `${view}-${scheme}-${name}.png`) });
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        }
      }
    });
  });
}
