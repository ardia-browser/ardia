import assert from "node:assert/strict";
import { test } from "node:test";
import { consentToken, setConsentPeriod } from "./consentPeriod.ts";
import { noteWebKitMenuLinkCopied, noteSelectedTabUrlsCopied, noteUncleanedUrlCopied, noteUrlCopied, takeUrlCopyCounts } from "./urlCopies.ts";

const NONE = {
  url_copies: 0,
  url_copies_while_pending: 0,
  url_copies_of_selected_tabs: 0,
  url_copies_cleaned: 0,
  url_copies_from_webkit_menu: 0,
  url_copies_uncleaned: 0,
};

test("address copies are counted, those taken before the first page apart, and taking them starts over", () => {
  setConsentPeriod(true, "address-copies");
  noteUrlCopied(false);
  noteUrlCopied(true);
  noteUrlCopied(true, true);
  noteSelectedTabUrlsCopied();
  assert.deepEqual(takeUrlCopyCounts(), { ...NONE, url_copies: 4, url_copies_while_pending: 2, url_copies_of_selected_tabs: 1, url_copies_cleaned: 1 });
  assert.deepEqual(takeUrlCopyCounts(), NONE);
});

test("copies from WebKit's page menu are counted, with the ones that lost a tracker and the downloads' raw copies", () => {
  setConsentPeriod(true, "url-copies");
  const consent = consentToken();
  noteWebKitMenuLinkCopied(true, consent);
  noteWebKitMenuLinkCopied(false, consent);
  noteWebKitMenuLinkCopied(true);
  noteUncleanedUrlCopied(consent);
  assert.deepEqual(takeUrlCopyCounts(), { ...NONE, url_copies_cleaned: 2, url_copies_from_webkit_menu: 3, url_copies_uncleaned: 1 });
});

test("a route copy taken while sharing was off, or in an earlier sharing period, is never counted", () => {
  setConsentPeriod(true, "before");
  const earlier = consentToken();
  setConsentPeriod(false, null);
  noteUrlCopied(false, true);
  assert.deepEqual(takeUrlCopyCounts(), { ...NONE, url_copies: 1 });
  noteWebKitMenuLinkCopied(true);
  noteWebKitMenuLinkCopied(true, null);
  noteUncleanedUrlCopied(null);
  setConsentPeriod(true, "after");
  noteWebKitMenuLinkCopied(true, earlier);
  noteUncleanedUrlCopied(earlier);
  assert.deepEqual(takeUrlCopyCounts(), NONE);
});
