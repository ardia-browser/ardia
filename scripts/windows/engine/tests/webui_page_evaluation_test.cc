#include "ardia/win/webui/webui_page_evaluation.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace {

using ardia_win::webui_page::PageEvaluationAnswered;
using ardia_win::webui_page::PageEvaluationFinished;
using ardia_win::webui_page::PageEvaluationStillCurrent;
using ardia_win::webui_page::PageEvaluationTicket;
using ardia_win::webui_page::PageEvaluationStep;
using ardia_win::webui_page::PageEvaluationUnavailable;
using ardia_win::webui_page::PageReply;
using ardiacore::kLinuxPageEvaluationResultMax;
using ardiacore::LinuxPageOperation;
using ardiacore::LinuxPageOperationArgs;

constexpr std::string_view kProbe = "probe";
constexpr std::string_view kControlResult = "{\"title\":\"Reader\",\"words\":412}";

constexpr std::array<LinuxPageOperation, 1> kOperations = {{
    {"probe", 5, "digest:probe", LinuxPageOperationArgs::kNone, ""},
}};

void Expect(bool condition, const std::string& what) {
  if (!condition) {
    std::fprintf(stderr, "failed: %s\n", what.c_str());
    std::abort();
  }
}

std::string FakeDigest(std::string_view text) {
  return "digest:" + std::string(text);
}

std::optional<base::Value> NoList(std::string_view) {
  return std::nullopt;
}

PageEvaluationStep Prepare(const base::ListValue* values) {
  return ardia_win::webui_page::PreparePageEvaluation(values, FakeDigest, NoList, kOperations);
}

PageEvaluationStep PrepareOne(base::Value value) {
  base::ListValue values;
  values.Append(std::move(value));
  return Prepare(&values);
}

bool IsArgumentRefusal(const PageEvaluationStep& step) {
  return !step.script && !step.refusal.ok && step.refusal.value.is_string() &&
         step.refusal.value.GetString() == "evaluate requires one script";
}

bool IsPolicyRefusal(const PageEvaluationStep& step) {
  if (step.script || step.refusal.ok || !step.refusal.value.is_dict()) {
    return false;
  }
  const std::string* code = step.refusal.value.GetDict().FindString("code");
  return code && *code == "ERR_PAGE_EVALUATION_REFUSED";
}

bool RepliesNull(const PageReply& reply) {
  return reply.ok && reply.value.is_none();
}

bool RepliesText(const PageReply& reply, const std::string& text) {
  return reply.ok && reply.value.is_string() && reply.value.GetString() == text;
}

void ExpectControls() {
  PageEvaluationStep control = PrepareOne(base::Value(std::string(kProbe)));
  Expect(control.script.has_value(), "the allow-listed operation reaches the frame");
  Expect(control.script->find("\nprobe\n") != std::string::npos, "the frame runs the operation's own text");
  Expect(RepliesText(PageEvaluationAnswered(base::Value(std::string(kControlResult))), std::string(kControlResult)),
         "a page result reaches the shell unchanged");
}

void TestShapes() {
  ExpectControls();
  Expect(IsArgumentRefusal(Prepare(nullptr)), "missing values refused");
  base::ListValue empty;
  Expect(IsArgumentRefusal(Prepare(&empty)), "no script refused");
  base::ListValue two;
  two.Append(std::string(kProbe));
  two.Append(std::string(kProbe));
  Expect(IsArgumentRefusal(Prepare(&two)), "two scripts refused");
  for (const char* refused : {"", "prob", "probe ", " probe", "probe;alert(1)", "PROBE", "probeprobe"}) {
    Expect(IsPolicyRefusal(PrepareOne(base::Value(refused))), std::string("refused code: ") + refused);
  }
  Expect(IsPolicyRefusal(PrepareOne(base::Value(std::string(ardiacore::kLinuxPageEvaluationCodeMax + 1, 'p')))),
         "oversized code refused");
  Expect(IsArgumentRefusal(PrepareOne(base::Value(1))), "a number is not a script");
  Expect(IsArgumentRefusal(PrepareOne(base::Value(true))), "a bool is not a script");
  Expect(IsArgumentRefusal(PrepareOne(base::Value())), "null is not a script");
  Expect(IsArgumentRefusal(PrepareOne(base::Value(base::DictValue()))), "an object is not a script");
  Expect(IsArgumentRefusal(PrepareOne(base::Value(base::ListValue()))), "a list is not a script");

  Expect(RepliesNull(PageEvaluationUnavailable()), "no live frame answers null");
  Expect(RepliesText(PageEvaluationAnswered(base::Value(std::string(kLinuxPageEvaluationResultMax, 'r'))),
                     std::string(kLinuxPageEvaluationResultMax, 'r')),
         "a result at the cap passes");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(std::string(kLinuxPageEvaluationResultMax + 1, 'r')))),
         "a result over the cap answers null");
  Expect(RepliesText(PageEvaluationAnswered(base::Value("")), ""), "an empty string result passes");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value())), "a null result answers null");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(7))), "a number result answers null");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(2.5))), "a double result answers null");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(false))), "a bool result answers null");
  base::DictValue planted;
  planted.Set("code", "ERR_PAGE_EVALUATION_REFUSED");
  planted.Set("__proto__", "x");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(std::move(planted)))), "an object result answers null");
  base::ListValue listed;
  listed.Append("a");
  Expect(RepliesNull(PageEvaluationAnswered(base::Value(std::move(listed)))), "a list result answers null");
}

void TestStalePages() {
  const PageEvaluationTicket sent{"c1", 3, 7};
  Expect(PageEvaluationStillCurrent(sent, {"c1", 3, 7}, true), "the same claim, epoch, binding and document is current");
  Expect(!PageEvaluationStillCurrent(sent, {"c1", 3, 7}, false), "a reload or another document is stale");
  Expect(!PageEvaluationStillCurrent(sent, {"c2", 4, 7}, true), "a reclaim with a new claim is stale");
  Expect(!PageEvaluationStillCurrent(sent, {"c1", 5, 7}, true), "a release and reclaim with the same claim is stale");
  Expect(!PageEvaluationStillCurrent(sent, {"", 4, 7}, true), "a released tab is stale");
  Expect(!PageEvaluationStillCurrent(sent, {"c1", 3, 8}, true), "a rebound tab is stale");
  Expect(!PageEvaluationStillCurrent({"", 0, 7}, {"", 0, 7}, true), "an unclaimed request is never current");
  const base::Value result{std::string(kControlResult)};
  Expect(RepliesText(PageEvaluationFinished(true, result), std::string(kControlResult)), "a current page's result reaches the shell");
  Expect(RepliesNull(PageEvaluationFinished(false, result)), "a stale page's result answers null");
}

std::optional<std::string> Unhex(std::string_view hex) {
  if (hex.size() % 2) {
    return std::nullopt;
  }
  std::string out;
  for (size_t i = 0; i < hex.size(); i += 2) {
    out += static_cast<char>(std::stoi(std::string(hex.substr(i, 2)), nullptr, 16));
  }
  return out;
}

base::Value Decode(std::string_view item) {
  const std::string_view tag = item.substr(0, 2);
  const std::string_view body = item.substr(2);
  if (tag == "b:") {
    return base::Value(true);
  }
  if (tag == "i:") {
    return base::Value(std::stoi(std::string(body)));
  }
  if (tag == "d:") {
    return base::Value(std::strtod(std::string(body).c_str(), nullptr));
  }
  if (tag == "s:") {
    std::optional<std::string> text = Unhex(body);
    Expect(text.has_value(), "corpus string decodes");
    return base::Value(std::move(*text));
  }
  if (tag == "a:") {
    return base::Value(base::ListValue());
  }
  if (tag == "o:") {
    return base::Value(base::DictValue());
  }
  return base::Value();
}

int RunHostileCorpus(const char* path) {
  ExpectControls();
  std::ifstream corpus(path);
  Expect(corpus.good(), "corpus opens");
  int values = 0;
  int strings = 0;
  int refused = 0;
  int passed = 0;
  int nulled = 0;
  std::string line;
  while (std::getline(corpus, line)) {
    if (line.empty()) {
      continue;
    }
    ++values;
    const size_t bar = line.find('|');
    Expect(bar != std::string::npos, "corpus line has two parts");
    const std::string single = line.substr(0, bar);
    const std::string whole = line.substr(bar + 1);

    base::Value value = Decode(single);
    const bool is_string = value.is_string();
    std::string text = is_string ? value.GetString() : std::string();
    strings += is_string;

    PageEvaluationStep as_code = PrepareOne(Decode(single));
    Expect(!as_code.script, "a hostile value never reaches the frame as code: " + single);
    Expect(is_string ? IsPolicyRefusal(as_code) : IsArgumentRefusal(as_code), "a hostile value is refused with its code: " + single);
    ++refused;

    if (whole.starts_with("L")) {
      base::ListValue arguments;
      std::string_view rest = std::string_view(whole).substr(1);
      while (!rest.empty()) {
        const size_t comma = rest.find(',');
        arguments.Append(Decode(rest.substr(0, comma)));
        rest = comma == std::string_view::npos ? std::string_view() : rest.substr(comma + 1);
      }
      PageEvaluationStep as_arguments = Prepare(&arguments);
      Expect(!as_arguments.script, "hostile arguments never reach the frame: " + whole);
      Expect(IsPolicyRefusal(as_arguments) || IsArgumentRefusal(as_arguments), "hostile arguments are refused: " + whole);
      ++refused;
    } else {
      Expect(IsArgumentRefusal(Prepare(nullptr)), "arguments that are not a list are refused: " + whole);
      ++refused;
    }

    Expect(RepliesNull(PageEvaluationFinished(false, value)), "a stale page's result answers null: " + single);
    PageReply reply = PageEvaluationFinished(true, value);
    Expect(reply.ok, "a page result never fails the call: " + single);
    if (is_string && text.size() <= kLinuxPageEvaluationResultMax) {
      Expect(RepliesText(reply, text), "a bounded string result reaches the shell unchanged: " + single);
      ++passed;
    } else {
      Expect(RepliesNull(reply), "any other result reaches the shell as null: " + single);
      ++nulled;
    }
  }
  Expect(values > 0 && strings > 0 && passed > 0 && nulled > 0, "the corpus exercised both outcomes");
  std::cout << "webui_page_evaluation_test hostile: " << values << " values, " << strings << " strings, " << refused
            << " refused before the frame, " << passed << " string results unchanged, " << nulled
            << " other results null, controls reached the sink\n";
  return 0;
}

}

int main(int argc, char** argv) {
  if (argc == 3 && std::string_view(argv[1]) == "--hostile") {
    return RunHostileCorpus(argv[2]);
  }
  TestShapes();
  TestStalePages();
  std::cout << "webui_page_evaluation_test: all assertions passed\n";
  return 0;
}
