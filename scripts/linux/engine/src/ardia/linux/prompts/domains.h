// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_PROMPTS_DOMAINS_H_
#define ARDIA_LINUX_PROMPTS_DOMAINS_H_

#include <map>
#include <string>
#include <string_view>

#include "ardia/linux/ui_host/modules.h"
#include "base/functional/callback.h"
#include "base/values.h"

namespace ardia_linux {

inline constexpr char kLinuxDomainsModule[] = "ArdiaLinuxDomains";

using DomainVerb = base::RepeatingCallback<
    void(const std::string& profile, base::DictValue args, ModuleReply reply)>;

class DomainVerbs {
 public:
  DomainVerbs();
  DomainVerbs(const DomainVerbs&) = delete;
  DomainVerbs& operator=(const DomainVerbs&) = delete;
  ~DomainVerbs();

  void Add(std::string_view domain, std::string_view verb, DomainVerb run);
  void Register(ModuleRegistry& registry);

 private:
  std::map<std::string, std::map<std::string, DomainVerb, std::less<>>,
           std::less<>>
      verbs_;
};

void ReplyJson(ModuleReply reply, const base::Value& value);
void ReplyNull(ModuleReply reply);
void ReplyError(ModuleReply reply,
                std::string_view message,
                std::string_view code = "ERR_LINUX_NATIVE");

void EmitDomainEvent(std::string_view domain,
                     std::string_view name,
                     base::Value data);

std::string DomainModuleName(std::string_view domain);

}

#endif
