// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_file_picker.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/weak_document_ptr.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "url/origin.h"

namespace ardia {
namespace {

constexpr base::TimeDelta kAnswerLifetime = base::Seconds(60);
constexpr base::TimeDelta kGrantLifetime = base::Seconds(10);

struct Totals {
  int armed = 0;
  int used = 0;
};

Totals& TotalsSoFar() {
  static Totals totals;
  return totals;
}

void DropAnswer(const content::WebContents* contents);

class ArmedAnswer : public content::WebContentsObserver {
 public:
  ArmedAnswer(content::WebContents* contents,
              FilePickerKind kind,
              std::vector<base::FilePath> paths,
              bool write,
              const void* owner)
      : content::WebContentsObserver(contents),
        kind_(kind),
        paths_(std::move(paths)),
        write_(write),
        owner_(owner),
        expires_(base::TimeTicks::Now() + kAnswerLifetime),
        document_(contents->GetPrimaryMainFrame()->GetWeakDocumentPtr()) {}

  FilePickerKind kind() const { return kind_; }
  std::vector<base::FilePath> TakePaths() { return std::move(paths_); }
  bool write() const { return write_; }
  const void* owner() const { return owner_; }
  bool Expired() const { return base::TimeTicks::Now() > expires_; }
  bool ForDocumentOf(content::RenderFrameHost* frame) const {
    content::RenderFrameHost* main = frame->GetOutermostMainFrame();
    return main && document_.AsRenderFrameHostIfValid() == main;
  }

  void PrimaryPageChanged(content::Page& page) override {
    DropAnswer(web_contents());
  }
  void WebContentsDestroyed() override { DropAnswer(web_contents()); }

 private:
  const FilePickerKind kind_;
  std::vector<base::FilePath> paths_;
  const bool write_;
  const void* const owner_;
  const base::TimeTicks expires_;
  const content::WeakDocumentPtr document_;
};

struct GrantCandidate {
  content::GlobalRenderFrameHostId frame;
  content::WeakDocumentPtr document;
  url::Origin origin;
  base::FilePath path;
  bool write = false;
  const void* owner = nullptr;
  base::TimeTicks expires;
};

struct GrantTicket {
  uint64_t serial = 0;
  content::GlobalRenderFrameHostId frame;
  content::WeakDocumentPtr document;
  url::Origin origin;
  base::FilePath path;
  bool read_left = false;
  bool write_left = false;
};

std::map<const content::WebContents*, std::unique_ptr<ArmedAnswer>>& Answers() {
  static base::NoDestructor<
      std::map<const content::WebContents*, std::unique_ptr<ArmedAnswer>>>
      answers;
  return *answers;
}

std::vector<GrantCandidate>& Candidates() {
  static base::NoDestructor<std::vector<GrantCandidate>> candidates;
  return *candidates;
}

std::optional<GrantTicket>& Ticket() {
  static base::NoDestructor<std::optional<GrantTicket>> ticket;
  return *ticket;
}

uint64_t NextTicketSerial() {
  static uint64_t serial = 0;
  return ++serial;
}



void DropAnswer(const content::WebContents* contents) {
  auto it = Answers().find(contents);
  if (it == Answers().end()) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(
      FROM_HERE, std::move(it->second));
  Answers().erase(it);
}

void SweepExpired() {
  std::vector<const content::WebContents*> expired;
  for (const auto& [contents, answer] : Answers()) {
    if (answer->Expired()) {
      expired.push_back(contents);
    }
  }
  for (const content::WebContents* contents : expired) {
    DropAnswer(contents);
  }
  const base::TimeTicks now = base::TimeTicks::Now();
  std::erase_if(Candidates(),
                [&](const GrantCandidate& c) { return now > c.expires; });
}

void SweepLater(base::TimeDelta delay) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&SweepExpired), delay);
}

std::optional<FilePickerKind> KindOfDialog(int dialog_type) {
  switch (static_cast<ui::SelectFileDialog::Type>(dialog_type)) {
    case ui::SelectFileDialog::SELECT_OPEN_FILE:
    case ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE:
      return FilePickerKind::kOpen;
    case ui::SelectFileDialog::SELECT_SAVEAS_FILE:
      return FilePickerKind::kSave;
    case ui::SelectFileDialog::SELECT_FOLDER:
    case ui::SelectFileDialog::SELECT_UPLOAD_FOLDER:
    case ui::SelectFileDialog::SELECT_EXISTING_FOLDER:
      return FilePickerKind::kDirectory;
    default:
      return std::nullopt;
  }
}

std::optional<FilePickerKind> KindNamed(const std::string* name) {
  if (!name) {
    return std::nullopt;
  }
  if (*name == "open") {
    return FilePickerKind::kOpen;
  }
  if (*name == "save") {
    return FilePickerKind::kSave;
  }
  if (*name == "directory") {
    return FilePickerKind::kDirectory;
  }
  return std::nullopt;
}

bool AnswerPicker(content::RenderFrameHost* frame,
                  int dialog_type,
                  std::vector<base::FilePath>* paths) {
  SweepExpired();
  content::WebContents* contents =
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  auto it = contents ? Answers().find(contents) : Answers().end();
  if (it == Answers().end()) {
    return false;
  }
  if (!it->second->ForDocumentOf(frame)) {
    DropAnswer(contents);
    return false;
  }
  if (KindOfDialog(dialog_type) != it->second->kind()) {
    return false;
  }
  const FilePickerKind kind = it->second->kind();
  const bool write = it->second->write();
  const void* owner = it->second->owner();
  std::vector<base::FilePath> answer = it->second->TakePaths();
  DropAnswer(contents);
  ++TotalsSoFar().used;
  const bool fits =
      kind == FilePickerKind::kOpen
          ? (answer.size() <= 1 ||
             dialog_type == ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE)
          : answer.size() <= 1;
  if (!fits) {
    paths->clear();
    return true;
  }
  if (kind == FilePickerKind::kDirectory && !answer.empty()) {
    Candidates().push_back({frame->GetGlobalId(), frame->GetWeakDocumentPtr(),
                            frame->GetLastCommittedOrigin(), answer.front(),
                            write, owner,
                            base::TimeTicks::Now() + kGrantLifetime});
    SweepLater(kGrantLifetime);
  }
  *paths = std::move(answer);
  return true;
}

void GrantExpected(content::RenderFrameHost* frame,
                   const base::FilePath& path,
                   bool write) {
  SweepExpired();
  Ticket().reset();
  if (!frame) {
    return;
  }
  auto it = std::find_if(
      Candidates().begin(), Candidates().end(), [&](const GrantCandidate& c) {
        return c.frame == frame->GetGlobalId() && c.path == path;
      });
  if (it == Candidates().end()) {
    return;
  }
  GrantCandidate candidate = std::move(*it);
  Candidates().erase(it);
  if ((write && !candidate.write) ||
      candidate.document.AsRenderFrameHostIfValid() != frame ||
      frame->GetLastCommittedOrigin() != candidate.origin) {
    return;
  }
  Ticket() = GrantTicket{NextTicketSerial(), candidate.frame,
                         candidate.document,  candidate.origin,
                         path,                true,
                         write};
}

void PickerReset(content::RenderFrameHost* frame) {
  Ticket().reset();
  if (!frame) {
    return;
  }
  const content::GlobalRenderFrameHostId id = frame->GetGlobalId();
  std::erase_if(Candidates(),
                [&](const GrantCandidate& c) { return c.frame == id; });
}

bool ClaimGrant(content::RenderFrameHost* frame,
                const base::FilePath& path,
                bool is_directory,
                bool write) {
  std::optional<GrantTicket>& ticket = Ticket();
  if (!ticket || !frame || !is_directory ||
      frame->GetGlobalId() != ticket->frame ||
      ticket->document.AsRenderFrameHostIfValid() != frame ||
      frame->GetLastCommittedOrigin() != ticket->origin ||
      path != ticket->path) {
    return false;
  }
  bool& left = write ? ticket->write_left : ticket->read_left;
  if (!left) {
    return false;
  }
  left = false;
  if (!ticket->read_left && !ticket->write_left) {
    ticket.reset();
  }
  return true;
}

}

std::string ArmFilePickerAnswer(content::WebContents* contents,
                                const base::DictValue& params,
                                const void* owner) {
  if (!contents) {
    return "on a target that isn't a tab";
  }
  const std::optional<FilePickerKind> kind =
      KindNamed(params.FindString("kind"));
  const base::ListValue* list = params.FindList("paths");
  if (!kind || !list) {
    return "without a kind (open, save or directory) and a paths list";
  }
  const std::string* mode = params.FindString("mode");
  if (mode && *mode != "read" && *mode != "readwrite") {
    return "with a mode other than read or readwrite";
  }
  std::vector<base::FilePath> paths;
  for (const base::Value& item : *list) {
    const base::FilePath path =
        item.is_string() ? base::FilePath::FromUTF8Unsafe(item.GetString())
                         : base::FilePath();
    if (!path.IsAbsolute() || path.ReferencesParent()) {
      return "with a path that isn't absolute";
    }
    paths.push_back(path);
  }
  if (*kind != FilePickerKind::kOpen && paths.size() > 1) {
    return "with more than one path for that kind";
  }
  DropAnswer(contents);
  Answers()[contents] = std::make_unique<ArmedAnswer>(
      contents, *kind, std::move(paths), mode && *mode == "readwrite", owner);
  SweepLater(kAnswerLifetime);
  ++TotalsSoFar().armed;
  return std::string();
}

void ForgetFilePickerAnswers(const void* owner) {
  std::vector<const content::WebContents*> owned;
  for (const auto& [contents, answer] : Answers()) {
    if (answer->owner() == owner) {
      owned.push_back(contents);
    }
  }
  for (const content::WebContents* contents : owned) {
    DropAnswer(contents);
  }
  std::erase_if(Candidates(),
                [&](const GrantCandidate& c) { return c.owner == owner; });
  Ticket().reset();
}

void InstallFilePickerAnswers() {
  g_ardia_file_picker_answer = &AnswerPicker;
  g_ardia_file_picker_grant_expected = &GrantExpected;
  g_ardia_file_picker_grant_claim = &ClaimGrant;
  g_ardia_file_picker_reset = &PickerReset;
}

base::DictValue FilePickerAnswerTotals() {
  return base::DictValue()
      .Set("armed", TotalsSoFar().armed)
      .Set("used", TotalsSoFar().used);
}

}
