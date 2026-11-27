import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BROWSERS, IDS, SHOTS, evalModel, gotoDb, launch, openPage, relay, rowsOf, schemaOf, startHarness, waitFor, dragBy } from "./dbHarness.mjs";

mkdirSync(SHOTS, { recursive: true });
let harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness?.stop();
});

const cell = (page, rowTitle, propName) => page.locator(`[data-testid="db-row"]:has([data-prop="Name"]:text-is("${rowTitle}")) [data-testid="db-cell"][data-prop="${propName}"]`);
const rowByTitle = (page, title) => page.locator(`[data-testid="db-row"]`, { has: page.locator(`.db-title-value span:text-is("${title}")`) });
const cellOf = (page, title, prop) => rowByTitle(page, title).locator(`[data-testid="db-cell"][data-prop="${prop}"]`);

for (const name of BROWSERS) {
  describe(`database (${name})`, () => {
    let browser;
    before(async () => {
      browser = await launch(name);
    });
    after(async () => {
      await browser?.close();
    });

    test("a new database initializes with a table and adds every property type", async () => {
      const { page, context, errors } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.empty);
      await page.getByTestId("db-table").waitFor();
      await page.getByTestId("db-title").fill("Inventory");
      await page.getByTestId("db-title").press("Enter");
      const types = ["Text", "Number", "Select", "Multi-select", "Status", "Date", "Person", "Files & media", "Checkbox", "URL", "Email", "Phone", "Formula", "Relation", "Rollup", "Created time", "Created by", "Last edited time", "Last edited by", "ID"];
      for (const label of types) {
        await page.getByTestId("db-add-property").click();
        await page.getByTestId("db-add-property-menu").getByTestId("db-type-option").filter({ hasText: new RegExp(`^${label.replace(/[&]/g, "\\$&")}$`) }).click();
        await page.getByTestId("db-prop-menu").or(page.getByTestId("db-prop-edit")).first().waitFor();
        await page.keyboard.press("Escape");
        await waitFor(async () => (await page.locator(".db-pop").count()) === 0, { message: "menu closed" });
      }
      const schema = await schemaOf(page, IDS.empty);
      const got = new Set(schema.map((p) => p.type));
      for (const t of ["title", "text", "number", "select", "multi_select", "status", "date", "person", "files", "checkbox", "url", "email", "phone", "formula", "relation", "rollup", "created_time", "created_by", "edited_time", "edited_by", "id"]) assert.ok(got.has(t), `missing ${t}`);
      assert.equal(await page.getByTestId("db-th").count(), schema.length);
      assert.deepEqual(errors, []);
      await context.close();
    });

    test("cells edit inline for text, number, select, multi-select, status, date, checkbox and url", async () => {
      const { page, context, errors } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      await page.getByTestId("db-table-new").click();
      const input = page.getByTestId("db-cell-input");
      await input.waitFor();
      await input.fill("Brand new task");
      await input.press("Enter");
      await waitFor(async () => (await rowsOf(page, IDS.tasks)).some((r) => r.title === "Brand new task"), { message: "title saved" });

      await cellOf(page, "Brand new task", "Estimate").click();
      await input.fill("42");
      await input.press("Enter");

      await cellOf(page, "Brand new task", "Priority").click();
      await page.getByTestId("db-option-search").fill("Urgent");
      await page.getByTestId("db-option-search").press("Enter");

      await cellOf(page, "Brand new task", "Tags").click();
      await page.getByTestId("db-option").filter({ hasText: "Design" }).click();
      await page.getByTestId("db-option").filter({ hasText: "Bug" }).click();
      await page.keyboard.press("Escape");

      await cellOf(page, "Brand new task", "Status").click();
      await page.getByTestId("db-option").filter({ hasText: "In progress" }).click();

      await cellOf(page, "Brand new task", "Due").click();
      const today = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
      await page.locator(`[data-testid="db-day"][data-day="${today}"]`).click();
      await page.keyboard.press("Escape");

      await cellOf(page, "Brand new task", "Done").click();

      await cellOf(page, "Brand new task", "Link").click();
      await input.fill("example.com");
      await input.press("Enter");

      const schema = await schemaOf(page, IDS.tasks);
      const id = (n) => schema.find((p) => p.name === n).id;
      const row = await waitFor(async () => {
        const r = (await rowsOf(page, IDS.tasks)).find((x) => x.title === "Brand new task");
        return r && r.props[id("Link")] ? r : null;
      }, { message: "all cells saved" });
      assert.equal(row.props[id("Estimate")], 42);
      const priority = schema.find((p) => p.name === "Priority");
      assert.equal(priority.options.find((o) => o.id === row.props[priority.id])?.name, "Urgent");
      const tags = schema.find((p) => p.name === "Tags");
      assert.deepEqual(row.props[tags.id].map((t) => tags.options.find((o) => o.id === t).name).sort(), ["Bug", "Design"]);
      const status = schema.find((p) => p.name === "Status");
      assert.equal(status.options.find((o) => o.id === row.props[status.id]).name, "In progress");
      assert.deepEqual(row.props[id("Due")], { start: today });
      assert.equal(row.props[id("Done")], true);
      assert.equal(row.props[id("Link")], "example.com");
      assert.ok(typeof row.props[id("ID")] === "number" && row.props[id("ID")] > 8);
      assert.equal(await cellOf(page, "Brand new task", "Score").innerText(), "0");
      await page.screenshot({ path: join(SHOTS, `table-edited-${name}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    });

    test("keyboard moves the cell selection and typing edits", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      await cellOf(page, "Fix login redirect", "Name").click();
      await page.getByTestId("db-cell-input").press("Escape");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.type("Q");
      await page.getByTestId("db-cell-input").press("Enter");
      await waitFor(async () => (await rowsOf(page, IDS.tasks)).some((r) => r.title === "Q"), { message: "typed title" });
      await context.close();
    });

    test("filters, sorts, groups, search and calculations", async () => {
      const { page, context, errors } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      const rows = () => page.getByTestId("db-row");
      assert.equal(await rows().count(), 8);
      await page.getByTestId("db-filter-btn").click();
      await page.getByTestId("db-add-filter").click();
      await page.getByTestId("db-prop-pick").filter({ hasText: "Priority" }).click();
      await page.getByTestId("db-rule-option").filter({ hasText: "High" }).click();
      await waitFor(async () => (await rows().count()) === 3, { message: "filtered to High" });
      await page.keyboard.press("Escape");
      await page.getByTestId("db-filter-chip").click();
      await page.getByTestId("db-rule-more").click();
      await page.getByTestId("db-rule-delete").click();
      await waitFor(async () => (await rows().count()) === 8, { message: "filter removed" });

      await page.getByTestId("db-add-filter").click();
      await page.getByTestId("db-prop-pick").filter({ hasText: "Estimate" }).click();
      await page.getByTestId("db-rule-cond").click();
      await page.getByTestId("db-cond-option").filter({ hasText: ">" }).first().click();
      await page.getByTestId("db-rule-value").fill("12");
      await waitFor(async () => (await rows().count()) === 4, { message: "estimate > 12" });
      await page.keyboard.press("Escape");
      await page.getByTestId("db-advanced-filter").click();
      await page.getByTestId("db-adv-add-rule").click();
      await page.getByTestId("db-prop-pick").filter({ hasText: "Name" }).click();
      await page.getByTestId("db-adv-op").selectOption("or");
      await page.getByTestId("db-adv-cond").last().selectOption("contains");
      await page.getByTestId("db-adv-value").last().fill("login");
      await waitFor(async () => (await rows().count()) === 5, { message: "advanced OR" });
      await page.keyboard.press("Escape");
      await evalModel(page, (d) => {
        const doc = d.client.internals.docs.get(`${d.WS}|${d.pageDocId("da7aba5e0001")}`);
        doc.getArray("views").forEach((v) => v.get("id") === "default" && v.set("filter", { kind: "group", id: "root", op: "and", rules: [] }));
      });
      await waitFor(async () => (await rows().count()) === 8, { message: "filters cleared" });

      await page.getByTestId("db-sort-btn").click();
      await page.getByTestId("db-add-sort").click();
      await page.getByTestId("db-prop-pick").filter({ hasText: "Estimate" }).click();
      await page.getByTestId("db-sort-dir").selectOption("desc");
      await page.keyboard.press("Escape");
      await waitFor(async () => (await rows().first().locator(".db-title-value").innerText()).includes("Polish dark mode"), { message: "sorted desc" });

      await page.getByTestId("db-search-btn").click();
      await page.getByTestId("db-search").fill("launch");
      await waitFor(async () => (await rows().count()) === 1, { message: "search" });
      await page.getByTestId("db-search").fill("");

      await page.getByTestId("db-settings-btn").click();
      await page.getByTestId("db-settings-group").click();
      await page.getByTestId("db-group-prop").selectOption({ label: "Priority" });
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.getByTestId("db-table-group").count()) === 4, { message: "grouped" });

      await page.getByTestId("db-calc").filter({ has: page.locator(':scope[data-prop="Estimate"]') }).click({ force: true });
      await page.getByTestId("db-calc-menu").getByText("Sum", { exact: true }).click();
      await waitFor(async () => (await page.locator('[data-testid="db-calc"][data-prop="Estimate"] [data-testid="db-calc-value"]').innerText()) === "108", { message: "sum" });
      await page.screenshot({ path: join(SHOTS, `table-grouped-${name}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    });

    test("formula property edits and evaluates, hostile formula shows an error", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      await page.locator('[data-testid="db-th"][data-prop="Score"]').click();
      await page.getByTestId("db-prop-edit-open").click();
      await page.getByTestId("db-formula-input").fill('concat(upper(prop("Name")), " · ", format(prop("Estimate") + 1))');
      await waitFor(async () => (await page.getByTestId("db-formula-preview").innerText()).includes("DESIGN THE LANDING PAGE · 4"), { message: "preview" });
      await page.getByTestId("db-formula-save").click();
      await page.keyboard.press("Escape");
      await waitFor(async () => (await cellOf(page, "Fix login redirect", "Score").innerText()) === "FIX LOGIN REDIRECT · 7", { message: "evaluated" });
      await page.locator('[data-testid="db-th"][data-prop="Score"]').click();
      await page.getByTestId("db-prop-edit-open").click();
      await page.getByTestId("db-formula-input").fill('constructor.__proto__("x") + ' + "(".repeat(200));
      await page.getByTestId("db-formula-save").click();
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.locator('[data-testid="db-cell"][data-prop="Score"] .db-error').count()) === 8, { message: "errors shown" });
      await context.close();
    });

    test("property menu: rename, hide, change type and delete", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      await page.locator('[data-testid="db-th"][data-prop="Email"]').click();
      await page.getByTestId("db-prop-name").fill("Contact");
      await page.getByTestId("db-prop-name").press("Enter");
      await page.locator('[data-testid="db-th"][data-prop="Contact"]').waitFor();
      await page.locator('[data-testid="db-th"][data-prop="Contact"]').click();
      await page.getByTestId("db-prop-type").click();
      await page.getByTestId("db-type-menu").getByTestId("db-type-option").filter({ hasText: /^Text$/ }).click();
      await page.keyboard.press("Escape");
      assert.equal((await schemaOf(page, IDS.tasks)).find((p) => p.name === "Contact").type, "text");
      await page.locator('[data-testid="db-th"][data-prop="Phone"]').click();
      await page.getByTestId("db-prop-hide").click();
      await waitFor(async () => (await page.locator('[data-testid="db-th"][data-prop="Phone"]').count()) === 0, { message: "hidden" });
      await page.locator('[data-testid="db-th"][data-prop="Contact"]').click();
      await page.getByTestId("db-prop-delete").click();
      await waitFor(async () => !(await schemaOf(page, IDS.tasks)).some((p) => p.name === "Contact"), { message: "deleted" });
      await context.close();
    });

    test("columns resize and reorder by drag", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      const th = page.locator('[data-testid="db-th"][data-prop="Tags"]');
      const before = (await th.boundingBox()).width;
      const handle = th.getByTestId("db-resize");
      await dragBy(page, handle, 80, 0);
      await waitFor(async () => Math.abs((await th.boundingBox()).width - (before + 80)) < 3, { message: "resized" });
      const status = page.locator('[data-testid="db-th"][data-prop="Status"]');
      const priority = page.locator('[data-testid="db-th"][data-prop="Priority"]');
      const p = await priority.boundingBox();
      const s = await status.boundingBox();
      await page.mouse.move(p.x + 40, p.y + p.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + 40 + ((s.x + 10 - p.x - 40) * i) / 10, p.y + p.height / 2);
      await page.mouse.up();
      await waitFor(async () => (await page.getByTestId("db-th").allInnerTexts()).join("|").includes("Priority|Status"), { message: "reordered" });
      await context.close();
    });

    test("rows select, bulk edit, duplicate and delete", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      const checks = page.getByTestId("db-row-check");
      await page.getByTestId("db-row").nth(0).hover();
      await checks.nth(0).click();
      await page.getByTestId("db-row").nth(1).hover();
      await checks.nth(1).click({ modifiers: ["Shift"] });
      await page.getByTestId("db-bulk").waitFor();
      assert.match(await page.getByTestId("db-bulk").innerText(), /2 selected/);
      await page.getByTestId("db-bulk-edit").click();
      await page.locator(".db-pop .db-item").filter({ hasText: "Done" }).first().click();
      await page.getByTestId("db-bulk-duplicate").click();
      await waitFor(async () => (await rowsOf(page, IDS.tasks)).length === 10, { message: "duplicated" });
      await checks.nth(0).click();
      await page.getByTestId("db-bulk-delete").click();
      await waitFor(async () => (await rowsOf(page, IDS.tasks)).length === 9, { message: "deleted" });
      await context.close();
    });

    test("row drag reorders the table", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      const first = page.getByTestId("db-row").nth(0);
      await first.hover();
      const handle = first.getByTestId("db-row-handle");
      await dragBy(page, handle, 0, 33 * 2 + 20);
      await waitFor(async () => (await rowsOf(page, IDS.tasks))[2]?.title === "Design the landing page", { message: "row moved" });
      await context.close();
    });

    test("peek opens rows with prev/next and edits properties", async () => {
      const { page, context, errors } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.tasks);
      await page.getByTestId("db-row").nth(1).hover();
      await page.getByTestId("db-row").nth(1).getByTestId("db-open-row").click();
      const peek = page.getByTestId("db-peek");
      await peek.waitFor();
      assert.equal(await page.getByTestId("db-peek-title").inputValue(), "Fix login redirect");
      await page.getByTestId("db-peek-next").click();
      await waitFor(async () => (await page.getByTestId("db-peek-title").inputValue()) === "Write onboarding docs", { message: "next" });
      await page.getByTestId("db-peek-prev").click();
      await page.getByTestId("db-peek-prev").click();
      await waitFor(async () => (await page.getByTestId("db-peek-title").inputValue()) === "Design the landing page", { message: "prev" });
      await page.locator('[data-testid="db-rp"][data-prop="Estimate"] [data-testid="db-rp-value"]').click();
      await page.getByTestId("db-cell-input").fill("99");
      await page.getByTestId("db-cell-input").press("Enter");
      await page.getByTestId("db-peek-title").fill("Design the landing page v2");
      await page.getByTestId("db-peek-title").press("Enter");
      await waitFor(async () => (await rowsOf(page, IDS.tasks)).some((r) => r.title === "Design the landing page v2" && Object.values(r.props).includes(99)), { message: "peek edits" });
      await page.screenshot({ path: join(SHOTS, `peek-side-${name}.png`) });
      await page.getByTestId("db-peek-close").click();
      await waitFor(async () => (await page.getByTestId("db-peek").count()) === 0, { message: "closed" });
      await page.getByTestId("db-settings-btn").click();
      await page.getByTestId("db-settings-open-as").click();
      await page.getByTestId("db-open-as-center").click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByTestId("db-row").nth(2).hover();
      await page.getByTestId("db-row").nth(2).getByTestId("db-open-row").click();
      await peek.waitFor();
      assert.match(await peek.getAttribute("class"), /is-center/);
      await page.screenshot({ path: join(SHOTS, `peek-center-${name}.png`) });
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.getByTestId("db-peek").count()) === 0, { message: "escape closes" });
      assert.deepEqual(errors, []);
      await context.close();
    });

    test("view tabs: add, rename, duplicate, delete, switch layout", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.projects);
      await page.getByTestId("db-add-view").click();
      await page.getByTestId("db-add-view-board").click();
      await waitFor(async () => (await page.getByTestId("db-tab").count()) === 2, { message: "added" });
      await page.locator('[data-testid="db-tab"][aria-selected="true"]').click();
      await page.getByTestId("db-tab-menu-rename").click();
      await page.getByTestId("db-tab-rename").fill("Kanban");
      await page.getByTestId("db-tab-rename").press("Enter");
      await page.getByTestId("db-tab").filter({ hasText: "Kanban" }).waitFor();
      await page.locator('[data-testid="db-tab"][aria-selected="true"]').click();
      await page.getByTestId("db-tab-menu-duplicate").click();
      await waitFor(async () => (await page.getByTestId("db-tab").count()) === 3, { message: "duplicated" });
      await page.locator('[data-testid="db-tab"][aria-selected="true"]').click();
      await page.getByTestId("db-tab-menu-delete").click();
      await waitFor(async () => (await page.getByTestId("db-tab").count()) === 2, { message: "deleted" });
      await page.getByTestId("db-settings-btn").click();
      await page.getByTestId("db-settings-layout").click();
      await page.getByTestId("db-layout-gallery").click();
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.getByTestId("db-view").getAttribute("data-view-type")) === "gallery", { message: "layout switched" });
      await context.close();
    });

    test("relations link both ways and rollups update", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.projects);
      const count = () => page.locator('[data-testid="db-row"]:has(.db-title-value span:text-is("Website")) [data-testid="db-cell"][data-prop="Task count"]').innerText();
      assert.equal(await count(), "3");
      await gotoDb(page, harness.url, IDS.tasks);
      await cellOf(page, "Fix login redirect", "Project").click();
      await page.getByTestId("db-relation-option").filter({ hasText: "Website" }).click();
      await page.keyboard.press("Escape");
      await gotoDb(page, harness.url, IDS.projects);
      await waitFor(async () => (await count()) === "4", { message: "rollup grew" });
      await context.close();
    });

    test("templates: create, set default, new rows use it", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.projects);
      await page.getByTestId("db-new-more").click();
      await page.getByTestId("db-new-template").click();
      await page.getByTestId("db-peek").waitFor();
      await page.getByTestId("db-peek-title").fill("Project brief");
      await page.getByTestId("db-peek-title").press("Enter");
      await page.getByTestId("db-peek-close").click();
      await page.getByTestId("db-new-more").click();
      await page.getByTestId("db-template").filter({ hasText: "Project brief" }).getByTestId("db-template-more").click();
      await page.getByTestId("db-template-default").click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByTestId("db-new").click();
      await waitFor(async () => (await rowsOf(page, IDS.projects)).some((r) => r.title === "Project brief"), { message: "row from template" });
      await context.close();
    });

    test("lock prevents schema edits", async () => {
      const { page, context } = await openPage(browser, harness.url);
      await gotoDb(page, harness.url, IDS.projects);
      await page.getByTestId("db-settings-btn").click();
      await page.getByTestId("db-settings-lock").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByTestId("db-add-property").count(), 0);
      assert.equal(await page.getByTestId("db-add-view").count(), 0);
      await context.close();
    });

    test("inline and linked databases render on a page", async () => {
      const { page, context, errors } = await openPage(browser, harness.url);
      await page.getByTestId(`h-nav-${IDS.host}`).click();
      await waitFor(async () => (await page.getByTestId("db-page").count()) === 2, { message: "two databases" });
      const linked = page.getByTestId("db-page").nth(1);
      await waitFor(async () => (await linked.getByTestId("db-card").count()) === 8, { message: "linked board shows tasks" });
      await page.screenshot({ path: join(SHOTS, `inline-linked-${name}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    });

    test("2,000 rows scroll smoothly with a virtualized table", async () => {
      const { page, context } = await openPage(browser, harness.url);
      const t0 = Date.now();
      await gotoDb(page, harness.url, IDS.big);
      await page.getByTestId("db-row").first().waitFor();
      const firstPaint = Date.now() - t0;
      const rendered = await page.getByTestId("db-row").count();
      assert.ok(rendered < 200, `rendered ${rendered} rows`);
      const frames = await page.evaluate(async () => {
        const times = [];
        let last = performance.now();
        for (let i = 0; i < 40; i++) {
          window.scrollBy(0, 400);
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          times.push(now - last);
          last = now;
        }
        return times;
      });
      const sorted = [...frames].sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      assert.ok(firstPaint < 8000, `first paint ${firstPaint}ms`);
      assert.ok(p90 < 120, `p90 frame ${p90}ms`);
      await page.getByTestId("db-row").filter({ hasText: /Row \d+/ }).first().waitFor();
      await context.close();
    });

    for (const scheme of ["light", "dark"]) {
      test(`screenshots of every view (${scheme})`, async () => {
        const { page, context } = await openPage(browser, harness.url, { colorScheme: scheme });
        for (const v of ["default", "board", "list", "gallery", "calendar", "timeline", "chart"]) {
          await gotoDb(page, harness.url, IDS.tasks, v);
          await page.waitForTimeout(150);
          await page.screenshot({ path: join(SHOTS, `view-${v}-${scheme}-${name}.png`) });
        }
        await gotoDb(page, harness.url, IDS.projects);
        await page.screenshot({ path: join(SHOTS, `view-projects-${scheme}-${name}.png`) });
        await context.close();
      });
    }

    test("two people editing cells, options and views converge", async () => {
      const ctxA = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      const ctxB = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await relay(a, b);
      await a.goto(`${harness.url}?as=ada`);
      await a.getByTestId("db-table").waitFor();
      await b.goto(`${harness.url}?as=grace`);
      await b.getByTestId("db-table").waitFor();
      await waitFor(async () => (await rowsOf(b, IDS.tasks)).length === 8, { message: "b synced" });

      await cellOf(a, "Fix login redirect", "Estimate").click();
      await a.getByTestId("db-cell-input").fill("11");
      await cellOf(b, "Plan the launch", "Estimate").click();
      await b.getByTestId("db-cell-input").fill("22");
      await a.getByTestId("db-cell-input").press("Enter");
      await b.getByTestId("db-cell-input").press("Enter");

      await cellOf(a, "Fix login redirect", "Priority").click();
      await a.getByTestId("db-option-search").fill("Blocker");
      await cellOf(b, "Plan the launch", "Priority").click();
      await b.getByTestId("db-option-search").fill("Someday");
      await a.getByTestId("db-option-search").press("Enter");
      await b.getByTestId("db-option-search").press("Enter");

      await a.locator('[data-testid="db-th"][data-prop="Tags"]').getByTestId("db-resize").hover();
      await dragBy(a, a.locator('[data-testid="db-th"][data-prop="Tags"]').getByTestId("db-resize"), 60, 0);
      await dragBy(b, b.locator('[data-testid="db-th"][data-prop="Status"]').getByTestId("db-resize"), 90, 0);

      await b.getByTestId("db-add-view").click();
      await b.getByTestId("db-add-view-list").click();

      const snapshot = async (p) => {
        const schema = await schemaOf(p, IDS.tasks);
        const rows = await rowsOf(p, IDS.tasks);
        const views = await evalModel(p, (d) => d.client.internals.docs.get(`${d.WS}|${d.pageDocId("da7aba5e0001")}`).getArray("views").toJSON());
        return JSON.stringify({ schema, rows: rows.map((r) => [r.title, r.props]), views });
      };
      await waitFor(async () => (await snapshot(a)) === (await snapshot(b)), { timeout: 8000, message: "converged" });
      const schema = await schemaOf(a, IDS.tasks);
      const priority = schema.find((p) => p.name === "Priority");
      assert.ok(priority.options.some((o) => o.name === "Blocker") && priority.options.some((o) => o.name === "Someday"));
      const est = schema.find((p) => p.name === "Estimate").id;
      const rows = await rowsOf(a, IDS.tasks);
      assert.equal(rows.find((r) => r.title === "Fix login redirect").props[est], 11);
      assert.equal(rows.find((r) => r.title === "Plan the launch").props[est], 22);
      await waitFor(async () => (await a.getByTestId("db-tab").count()) === 8, { message: "view appears for a" });
      await ctxA.close();
      await ctxB.close();
    });
  });
}
