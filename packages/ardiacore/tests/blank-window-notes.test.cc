#include "../ios/ArdiaBlankWindowNotes.h"

#include <cstdio>

using namespace ardia_blank_window_notes;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static void LaterPopupRedirectingFirstKeepsItsOwnNote() {
  Pairing pairing;
  pairing.OpenedBlank(1, 0.000);
  pairing.Noted("https://a.example/", 0.004);
  pairing.OpenedBlank(2, 0.100);
  pairing.Noted("https://b.example/", 0.104);
  CHECK(pairing.Take(2, 0.150) == std::optional<std::string>("https://b.example/"));
  CHECK(pairing.Take(1, 0.500) == std::optional<std::string>("https://a.example/"));
  CHECK(pairing.pending_tabs() == 0 && pairing.pending_notes() == 0);
}

static void NoteBeforeItsTabStillPairs() {
  Pairing pairing;
  pairing.Noted("https://a.example/", 0.000);
  pairing.Noted("https://b.example/", 0.080);
  pairing.OpenedBlank(1, 0.003);
  pairing.OpenedBlank(2, 0.083);
  CHECK(pairing.Take(1, 0.600) == std::optional<std::string>("https://a.example/"));
  CHECK(pairing.Take(2, 0.600) == std::optional<std::string>("https://b.example/"));
}

static void UnrelatedBlankPopupNeverTakesAClicksNote() {
  Pairing pairing;
  pairing.OpenedBlank(7, 0.000);
  pairing.OpenedBlank(1, 0.400);
  pairing.Noted("https://a.example/", 0.402);
  CHECK(pairing.Take(7, 0.500) == std::nullopt);
  CHECK(pairing.Take(1, 0.500) == std::optional<std::string>("https://a.example/"));
}

static void NoteWithNoTabExpires() {
  Pairing pairing;
  pairing.Noted("https://a.example/", 0.000);
  pairing.OpenedBlank(1, 1.500);
  CHECK(pairing.Take(1, 1.600) == std::nullopt);
  CHECK(pairing.pending_notes() == 0);
}

static void UnboundTabExpiresButABoundOneWaits() {
  Pairing pairing;
  pairing.OpenedBlank(1, 0.000);
  pairing.OpenedBlank(2, 5.000);
  pairing.Noted("https://b.example/", 5.001);
  CHECK(pairing.pending_tabs() == 1);
  CHECK(pairing.Take(2, 9.000) == std::optional<std::string>("https://b.example/"));
}

static void NoteArrivingAfterAFirstTryStillMatches() {
  Pairing pairing;
  pairing.OpenedBlank(1, 0.000);
  CHECK(pairing.Take(1, 0.025) == std::nullopt);
  CHECK(pairing.pending_tabs() == 1);
  pairing.Noted("https://a.example/", 0.030);
  CHECK(pairing.Take(1, 0.050) == std::optional<std::string>("https://a.example/"));
  pairing.OpenedBlank(2, 1.000);
  pairing.Forget(2);
  pairing.Noted("https://b.example/", 1.010);
  CHECK(pairing.pending_tabs() == 0 && pairing.pending_notes() == 1);
}

static void ANoteGoesToThePopupOpenedWithItNotAnOlderOne() {
  Pairing pairing;
  pairing.OpenedBlank(7, 0.000);
  pairing.OpenedBlank(1, 0.100);
  pairing.Noted("https://a.example/", 0.102);
  CHECK(pairing.Take(7, 0.500) == std::nullopt);
  CHECK(pairing.Take(1, 0.500) == std::optional<std::string>("https://a.example/"));
  Pairing early;
  early.OpenedBlank(7, 0.000);
  early.Noted("https://a.example/", 0.098);
  early.OpenedBlank(1, 0.100);
  CHECK(early.Take(7, 0.300) == std::nullopt);
  CHECK(early.Take(1, 0.300) == std::optional<std::string>("https://a.example/"));
}

static void AFreshNoteWaitsForItsPopupBeforeAnOlderOneClaims() {
  Pairing pairing;
  pairing.OpenedBlank(7, 0.400);
  pairing.Noted("https://a.example/", 0.498);
  CHECK(pairing.Take(7, 0.500) == std::nullopt);
  pairing.OpenedBlank(1, 0.501);
  CHECK(pairing.Take(7, 0.525) == std::nullopt);
  CHECK(pairing.Take(1, 0.550) == std::optional<std::string>("https://a.example/"));
  Pairing alone;
  alone.OpenedBlank(1, 0.000);
  alone.Noted("https://a.example/", 0.010);
  CHECK(alone.Take(1, 0.015) == std::optional<std::string>("https://a.example/"));
}

static void CapacityIsBounded() {
  Pairing pairing;
  for (std::uint64_t i = 0; i < 40; i++) pairing.OpenedBlank(i, 0.001 * static_cast<double>(i));
  for (int i = 0; i < 40; i++) pairing.Noted("https://n.example/", 0.5);
  CHECK(pairing.pending_tabs() <= kTabsKept);
  CHECK(pairing.pending_notes() <= kNotesKept);
  CHECK(pairing.Take(999, 0.5) == std::nullopt);
}

int main() {
  LaterPopupRedirectingFirstKeepsItsOwnNote();
  NoteBeforeItsTabStillPairs();
  UnrelatedBlankPopupNeverTakesAClicksNote();
  NoteWithNoTabExpires();
  UnboundTabExpiresButABoundOneWaits();
  NoteArrivingAfterAFirstTryStillMatches();
  ANoteGoesToThePopupOpenedWithItNotAnOlderOne();
  AFreshNoteWaitsForItsPopupBeforeAnOlderOneClaims();
  CapacityIsBounded();
  if (failures) return 1;
  std::printf("blank-window-notes: ok\n");
  return 0;
}
