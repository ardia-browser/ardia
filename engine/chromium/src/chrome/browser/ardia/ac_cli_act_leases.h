// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_ACT_LEASES_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_ACT_LEASES_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/function_ref.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_act_lease_book.h"

namespace content {
class DevToolsAgentHost;
class RenderFrameHost;
class WebContents;
}

namespace ardia {

std::optional<int64_t> ActDocumentOf(content::WebContents* contents);
std::optional<int64_t> GrantActLease(const std::string& credential_id,
                                     content::WebContents* contents,
                                     int64_t expected_document,
                                     std::string* error);
bool ReleaseActLease(int64_t lease);
void ReleaseActLeasesOf(const std::string& credential_id);
int64_t ActLeaseActionAdmitted(int64_t lease);
void ActLeaseActionsReturned(const std::vector<int64_t>& tickets);
void ActLeaseTabDeparted(const std::string& credential_id,
                         content::WebContents* contents);
void EndActLeasesWithoutSession(
    const std::string& credential_id,
    base::FunctionRef<bool(content::WebContents*)> attached);

int64_t AdmitActLease(const std::string& credential_id,
                      content::DevToolsAgentHost* host);
bool ActLeaseCoversFrame(const std::string& credential_id,
                         content::RenderFrameHost* frame);
bool ActTicketLive(int64_t ticket,
                   const std::string& credential_id,
                   content::DevToolsAgentHost* host);
void ActTicketDelivering(int64_t ticket);
bool ActTicketDelivered(int64_t ticket);

void CountActCommandRefused();
void CountActDeliveryRefused();
base::DictValue ActLeaseTotals();

}

#endif
