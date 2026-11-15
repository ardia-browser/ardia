// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/prompts/domains.h"

#include <optional>
#include <utility>

#include "ardia/linux/modules/args.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"

namespace ardia_linux {

DomainVerbs::DomainVerbs() = default;
DomainVerbs::~DomainVerbs() = default;

void DomainVerbs::Add(std::string_view domain,
                      std::string_view verb,
                      DomainVerb run) {
  verbs_[std::string(domain)][std::string(verb)] = std::move(run);
}

void DomainVerbs::Register(ModuleRegistry& registry) {
  base::DictValue listed;
  for (const auto& [domain, verbs] : verbs_) {
    base::ListValue names;
    for (const auto& [verb, run] : verbs) {
      names.Append(verb);
    }
    listed.Set(domain, std::move(names));
  }
  auto table = std::make_unique<
      std::map<std::string, std::map<std::string, DomainVerb, std::less<>>,
               std::less<>>>(std::move(verbs_));
  verbs_.clear();
  registry.Define(kLinuxDomainsModule)
      .Constant("verbs", base::Value(std::move(listed)))
      .Async("call",
             base::BindRepeating(
                 [](const std::map<std::string,
                                   std::map<std::string, DomainVerb, std::less<>>,
                                   std::less<>>* table,
                    base::ListValue args, ModuleReply reply) {
                   const std::string domain = StringArg(args, 0);
                   const std::string verb = StringArg(args, 1);
                   auto in_domain = table->find(domain);
                   const DomainVerb* run = nullptr;
                   if (in_domain != table->end()) {
                     auto found = in_domain->second.find(verb);
                     if (found != in_domain->second.end()) {
                       run = &found->second;
                     }
                   }
                   if (!run) {
                     ReplyError(std::move(reply),
                                base::StrCat({domain, ".", verb,
                                              " isn't a call"}),
                                "ERR_UNKNOWN_CALL");
                     return;
                   }
                   std::optional<base::Value> parsed = base::JSONReader::Read(
                       StringArg(args, 3), base::JSON_PARSE_RFC);
                   base::DictValue fields;
                   if (parsed && parsed->is_dict()) {
                     fields = std::move(parsed->GetDict());
                   }
                   run->Run(StringArg(args, 2), std::move(fields),
                            std::move(reply));
                 },
                 base::Owned(std::move(table))));
}

void ReplyJson(ModuleReply reply, const base::Value& value) {
  std::move(reply).Run(
      ModuleResult(base::Value(base::WriteJson(value).value_or("null"))));
}

void ReplyNull(ModuleReply reply) {
  std::move(reply).Run(ModuleResult(base::Value("null")));
}

void ReplyError(ModuleReply reply,
                std::string_view message,
                std::string_view code) {
  std::move(reply).Run(ModuleFailure(message, code));
}

std::string DomainModuleName(std::string_view domain) {
  if (domain.empty()) {
    return "Ardia";
  }
  std::string name = base::StrCat({"Ardia", domain});
  name[5] = base::ToUpperASCII(name[5]);
  return name;
}

void EmitDomainEvent(std::string_view domain,
                     std::string_view name,
                     base::Value data) {
  if (!ModuleRegistry::Exists()) {
    return;
  }
  base::DictValue event;
  event.Set("name", base::StrCat({domain, ".", name}));
  event.Set("data", std::move(data));
  ModuleRegistry::Get().Emit(DomainModuleName(domain), domain,
                             base::Value(std::move(event)));
}

}
