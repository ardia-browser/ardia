#include "ardia/mac/ac_mac_dialog_policy.h"

#include <string>

#include "check.h"

namespace policy = ardia_mac::dialog_policy;

namespace {

policy::Text Str(std::string value) {
  return policy::Text{true, true, std::move(value)};
}

policy::Request Confirm() {
  policy::Request request;
  request.dialog_id = Str("dialog:0123456789abcdef:1");
  request.kind = Str("confirm");
  request.has_options = true;
  request.title = Str("Quit Ardia?");
  request.message = Str("Your tabs come back.");
  request.confirm_title = Str("Quit");
  request.cancel_title = Str("Cancel");
  request.suppression = Str("Don't ask again");
  return request;
}

}

TEST(dialog_ids_and_generations_keep_the_shell_contract) {
  CHECK(policy::ValidDialogId("dialog:0123456789abcdef:1"));
  CHECK(!policy::ValidDialogId("short:1"));
  CHECK(!policy::ValidDialogId(std::string(97, 'a')));
  CHECK(policy::ValidDialogId(std::string(96, 'a')));
  CHECK(!policy::ValidDialogId("dialog:0123456789abcdef/1"));
  CHECK(policy::ValidGeneration("1") && policy::ValidGeneration("18446744073709551615"));
  CHECK(!policy::ValidGeneration("0") && !policy::ValidGeneration("01") && !policy::ValidGeneration(""));
  CHECK(!policy::ValidGeneration("123456789012345678901") && !policy::ValidGeneration("1a"));
}

TEST(a_confirm_parses_with_its_buttons_and_suppression) {
  const auto spec = policy::Parse(Confirm(), "main");
  CHECK(spec.has_value());
  CHECK(!spec->prompt && spec->title == "Quit Ardia?" && spec->confirm_title == "Quit");
  CHECK(spec->has_suppression && spec->suppression == "Don't ask again");
  CHECK(!spec->destructive);
}

TEST(malformed_requests_are_refused) {
  auto request = Confirm();
  request.kind = Str("alert");
  CHECK(!policy::Parse(request, "main"));
  request = Confirm();
  request.has_options = false;
  CHECK(!policy::Parse(request, "main"));
  request = Confirm();
  request.title = policy::Text{true, false, ""};
  CHECK(!policy::Parse(request, "main"));
  request = Confirm();
  request.title = Str(std::string(policy::kTitleLimit + 1, 'x'));
  CHECK(!policy::Parse(request, "main"));
  request = Confirm();
  request.window_id = Str("other");
  CHECK(!policy::Parse(request, "main"));
  request.window_id = Str("main");
  CHECK(policy::Parse(request, "main").has_value());
  request = Confirm();
  request.destructive = policy::Flag{true, false, false};
  CHECK(!policy::Parse(request, "main"));
  request.destructive = policy::Flag{true, true, true};
  CHECK(policy::Parse(request, "main")->destructive);
  request = Confirm();
  request.message = policy::Text{true, false, ""};
  CHECK(!policy::Parse(request, "main"));
}

TEST(prompts_keep_value_and_placeholder_and_trim_answers) {
  policy::Request request;
  request.dialog_id = Str("dialog:prompt-0123456789:2");
  request.kind = Str("prompt");
  request.has_options = true;
  request.title = Str("Rename");
  request.value = Str("Tabs");
  request.placeholder = Str("Name");
  const auto spec = policy::Parse(request, "main");
  CHECK(spec && spec->prompt && spec->value == "Tabs" && spec->placeholder == "Name");
  CHECK(policy::Resolve(*spec, {.accepted = true, .text = "  Work \n"}).text == std::string("Work"));
  CHECK(!policy::Resolve(*spec, {.accepted = true, .text = "   "}).text);
  CHECK(!policy::Resolve(*spec, {.accepted = false, .text = "Work"}).text);
  CHECK(!policy::Resolve(*spec, {.accepted = true, .text = "Work", .forced = true}).text);
}

TEST(confirm_answers_never_suppress_without_a_checkbox_or_when_forced) {
  auto spec = *policy::Parse(Confirm(), "main");
  CHECK(policy::Resolve(spec, {.accepted = true, .suppressed = true}).suppressed);
  CHECK(policy::Resolve(spec, {.accepted = true}).confirmed);
  const auto forced = policy::Resolve(spec, {.accepted = true, .suppressed = true, .forced = true});
  CHECK(!forced.confirmed && !forced.suppressed);
  spec.has_suppression = false;
  CHECK(!policy::Resolve(spec, {.accepted = true, .suppressed = true}).suppressed);
}

TEST(shown_text_drops_control_characters) {
  CHECK(policy::Displayable(std::string("a\x01" "b\nc\x7f", 6)) == "a b\nc ");
  CHECK(policy::ButtonTitle("\n\t", "OK") == "OK");
  CHECK(policy::ButtonTitle("Quit\n", "OK") == "Quit ");
}

TEST(the_queue_shows_one_dialog_at_a_time_in_order) {
  policy::Queue queue;
  auto first = *policy::Parse(Confirm(), "main");
  auto second = first;
  second.dialog_id = "dialog:0123456789abcdef:2";
  CHECK(queue.Admit(first, "7", "7") == policy::Refusal::kNone);
  CHECK(queue.Admit(second, "7", "7") == policy::Refusal::kNone);
  CHECK(queue.Admit(first, "7", "7") == policy::Refusal::kDuplicate);
  CHECK(queue.Admit(second, "6", "7") == policy::Refusal::kNotCurrent);
  const auto* next = queue.Next();
  CHECK(next && next->spec.dialog_id == first.dialog_id);
  CHECK(queue.Show(next->sequence));
  CHECK(!queue.Next());
  const auto done = queue.Complete(first.dialog_id, 1);
  CHECK(done && done->generation == "7");
  CHECK(!queue.Complete(first.dialog_id, 1));
  CHECK(queue.Next() && queue.Next()->spec.dialog_id == second.dialog_id);
  CHECK(!queue.Complete(second.dialog_id, 1));
}

TEST(the_queue_is_bounded_and_suspensions_refuse_new_dialogs) {
  policy::Queue queue;
  auto spec = *policy::Parse(Confirm(), "main");
  for (std::size_t index = 0; index < policy::kMaxPending; ++index) {
    spec.dialog_id = "dialog:0123456789abcdef:" + std::to_string(index + 10);
    CHECK(queue.Admit(spec, "1", "1") == policy::Refusal::kNone);
  }
  spec.dialog_id = "dialog:0123456789abcdef:99";
  CHECK(queue.Admit(spec, "1", "1") == policy::Refusal::kFull);
  policy::Queue suspended;
  const auto token = suspended.Suspend();
  CHECK(token != 0 && suspended.suspended());
  CHECK(suspended.Admit(spec, "1", "1") == policy::Refusal::kSuspended);
  CHECK(!suspended.Resume(token + 1));
  CHECK(suspended.Resume(token) && !suspended.suspended());
  CHECK(!suspended.Resume(token));
  for (std::size_t index = 0; index < policy::kMaxSuspensions; ++index) CHECK(suspended.Suspend() != 0);
  CHECK(suspended.Suspend() == 0 && suspended.suspended());
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
