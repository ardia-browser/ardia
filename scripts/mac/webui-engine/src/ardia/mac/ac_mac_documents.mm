#include "ardia/mac/ac_mac_documents.h"

#include <map>
#include <optional>
#include <utility>

#include "ardia/linux/ac_linux_document_service.h"
#include "ardia/linux/ac_linux_documents.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_shell_policy.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/threading/sequence_bound.h"
#include "base/uuid.h"

namespace ardia_mac {

namespace {

using ardia::LinuxDocumentClient;
using ardia::LinuxDocumentDispatchResult;
using ardia::LinuxDocumentRead;
using ardia::LinuxDocumentResult;
using ardia::LinuxDocuments;
using ardia::LinuxDocumentService;

constexpr std::string_view kPrefix = "documents.";
constexpr std::size_t kClientLimit = 128;

LinuxDocumentRead ReadReserved(const base::FilePath& directory, std::string_view name) {
  LinuxDocumentRead result;
  if (!LinuxDocuments::Reserved(name)) {
    result.state = LinuxDocumentRead::State::kError;
    return result;
  }
  const base::FilePath path = directory.AppendASCII(name);
  if (base::IsLink(path)) {
    result.state = LinuxDocumentRead::State::kError;
    return result;
  }
  base::File file(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
  if (!file.IsValid()) {
    result.state = file.error_details() == base::File::FILE_ERROR_NOT_FOUND
                       ? LinuxDocumentRead::State::kMissing
                       : LinuxDocumentRead::State::kError;
    return result;
  }
  std::string contents;
  if (!base::ReadFileToStringWithMaxSize(path, &contents, ardia::kLinuxLiveMaxBytes)) {
    result.state = LinuxDocumentRead::State::kError;
    return result;
  }
  result.state = LinuxDocumentRead::State::kFound;
  std::optional<base::Value> value = base::JSONReader::Read(contents, base::JSON_PARSE_RFC, 48);
  if (value && value->is_dict()) {
    result.value = std::move(value->GetDict());
  } else {
    result.value.Set("format", "invalid");
  }
  return result;
}

bool WriteEnvelope(const base::FilePath& directory, const base::DictValue& envelope) {
  const std::optional<std::string> json =
      base::WriteJsonWithOptions(envelope, base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION, 48);
  if (!json || json->size() > ardia::kLinuxLiveMaxBytes || !base::CreateDirectory(directory)) {
    return false;
  }
  const base::FilePath path = directory.AppendASCII(ardia::kLinuxLiveEnvelope);
  return !base::IsLink(path) && base::ImportantFileWriter::WriteFileAtomically(path, *json);
}

base::Value FailureOf(const LinuxDocumentResult& result) {
  return Failure(result.code.empty() ? "ERR_DOCUMENT" : result.code,
                 result.message.empty() ? "Document request failed" : result.message);
}

}

struct DocumentAuthority {
  explicit DocumentAuthority(const base::FilePath& directory)
      : scope(base::Uuid::GenerateRandomV4().AsLowercaseString()),
        service(SessionFiles(), scope, base::Uuid::GenerateRandomV4().AsLowercaseString(),
                LinuxDocuments::Read([directory](std::string_view name) { return ReadReserved(directory, name); }),
                LinuxDocuments::Write([directory](const base::DictValue& envelope) {
                  return WriteEnvelope(directory, envelope);
                })) {}
  const std::string scope;
  base::SequenceBound<LinuxDocumentService> service;
};

namespace {

std::shared_ptr<DocumentAuthority> AuthorityFor(const base::FilePath& directory) {
  static base::NoDestructor<std::map<base::FilePath, std::weak_ptr<DocumentAuthority>>> authorities;
  auto& slot = (*authorities)[directory];
  std::shared_ptr<DocumentAuthority> authority = slot.lock();
  if (!authority) {
    authority = std::make_shared<DocumentAuthority>(directory);
    slot = authority;
  }
  return authority;
}

}

DocumentSession::DocumentSession(std::string window_id, Changed changed)
    : window_id_(std::move(window_id)), changed_(std::move(changed)) {}

DocumentSession::~DocumentSession() {
  RendererRetired();
}

bool DocumentSession::Handles(std::string_view name) {
  return name.starts_with(kPrefix);
}

bool DocumentSession::Reserved(std::string_view name) {
  return shell_policy::ReservedLiveDocument(name);
}

bool DocumentSession::EnsureClient(std::uint64_t renderer_generation) {
  if (!authority_) {
    const base::FilePath directory = DataDirectory();
    if (directory.empty()) {
      return false;
    }
    authority_ = AuthorityFor(directory);
  }
  if (client_.empty()) {
    client_ = authority_->scope + ":" + window_id_ + ":" + base::NumberToString(renderer_generation);
    if (client_.size() > kClientLimit) {
      client_.clear();
      return false;
    }
    client_generation_ = renderer_generation;
  }
  return client_generation_ == renderer_generation;
}

void DocumentSession::RendererRetired() {
  ++subscription_;
  watched_ = false;
  if (authority_ && !client_.empty()) {
    authority_->service.AsyncCall(&LinuxDocumentService::Retire)
        .WithArgs(LinuxDocumentClient{client_, authority_->scope, true, true});
  }
  client_.clear();
  client_generation_ = 0;
}

void DocumentSession::Deliver(std::uint64_t subscription, base::Value payload) {
  if (subscription != subscription_ || !watched_) {
    return;
  }
  changed_.Run(std::move(payload));
}

void DocumentSession::Call(std::string_view name,
                           const base::Value* args,
                           std::uint64_t renderer_generation,
                           Done done) {
  const std::string verb(name.substr(kPrefix.size()));
  if (verb != "watch" && verb != "commit" && verb != "flush" && verb != "unwatch") {
    return std::move(done).Run(false, Failure("ERR_UNKNOWN_CALL", "Unknown document operation"));
  }
  if (!args || !args->is_string() || args->GetString().size() > ardia::kLinuxLiveMaxBytes) {
    return std::move(done).Run(false, Failure("ERR_DOCUMENT_REQUEST", "Document arguments require JSON text"));
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 48);
  if (!parsed || !parsed->is_dict()) {
    return std::move(done).Run(false, Failure("ERR_DOCUMENT_REQUEST", "Document arguments must be a JSON object"));
  }
  if (!EnsureClient(renderer_generation)) {
    return std::move(done).Run(false, Failure("ERR_DOCUMENT_AUTH", "Document access denied"));
  }
  if (verb == "watch" || verb == "unwatch") {
    ++subscription_;
    watched_ = verb == "watch";
  }
  const scoped_refptr<base::SequencedTaskRunner> ui = base::SequencedTaskRunner::GetCurrentDefault();
  LinuxDocuments::Changed changed =
      [ui, weak = weak_factory_.GetWeakPtr(), subscription = subscription_](base::DictValue payload) {
        ui->PostTask(FROM_HERE, base::BindOnce(&DocumentSession::Deliver, weak, subscription,
                                               base::Value(std::move(payload))));
      };
  authority_->service.AsyncCall(&LinuxDocumentService::DispatchTracked)
      .WithArgs(verb, LinuxDocumentClient{client_, authority_->scope, true, true},
                std::move(parsed->GetDict()), std::move(changed))
      .Then(base::BindOnce(
          [](Done done, LinuxDocumentDispatchResult dispatched) {
            if (!dispatched.result.ok()) {
              return std::move(done).Run(false, FailureOf(dispatched.result));
            }
            std::move(done).Run(true, base::Value(base::WriteJson(dispatched.result.value).value_or("{}")));
          },
          std::move(done)));
}

}
