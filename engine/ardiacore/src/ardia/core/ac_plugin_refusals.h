// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_PLUGIN_REFUSALS_H_
#define ARDIA_CORE_AC_PLUGIN_REFUSALS_H_

namespace ardia::refusal {

inline constexpr char kPrefix[] = "ardia: ";
inline constexpr char kBusy[] = "ardia: busy";
inline constexpr char kPageHidden[] = "ardia: page hidden";
inline constexpr char kNotDelivered[] = "ardia: not delivered";
inline constexpr char kOutcomeUnknown[] = "ardia: outcome unknown";
inline constexpr char kPageChanged[] =
    "ardia: the page changed after the input was sent";
inline constexpr char kNotPageSession[] =
    "ardia: pointer input and clicks go only to the page target's own session";
inline constexpr char kNotTakingInput[] =
    "ardia: the page isn't taking input right now";
inline constexpr char kNoPage[] = "ardia: there's no page to send input to";
inline constexpr char kOutsidePage[] = "ardia: that point is outside the page";
inline constexpr char kNothingThere[] =
    "ardia: there's nothing there to send input to";
inline constexpr char kInputCantBeMade[] = "ardia: that input can't be made";
inline constexpr char kSessionCantSendInput[] =
    "ardia: that session can't send input";
inline constexpr char kInputNotAllowed[] =
    "ardia: input isn't allowed for this session";
inline constexpr char kOutOfScope[] =
    "ardia: tab_out_of_scope: the tab left the plugin's window";
inline constexpr char kNoAttachedSession[] =
    "ardia: no attached session has that sessionId";
inline constexpr char kNodeNotInPage[] = "ardia: that nodeId isn't in this page";
inline constexpr char kBackendNodeNotInPage[] =
    "ardia: that backendNodeId isn't in this page";
inline constexpr char kNodeLeftPage[] =
    "ardia: that node left this page while the query was pending";
inline constexpr char kNotJsonObject[] = "ardia: a command must be a JSON object";
inline constexpr char kNeedsIdAndMethod[] =
    "ardia: a command needs an id and a method";
inline constexpr char kParamsNotObject[] = "ardia: params must be an object";
inline constexpr char kClosing[] = "ardia: this connection is closing";
inline constexpr char kDuplicateId[] =
    "ardia: a command with that id is still waiting for its reply";
inline constexpr char kTooManyPending[] =
    "ardia: too many commands are waiting for replies; closing the connection";
inline constexpr char kCantBeAnsweredSuffix[] = " can't be answered";
inline constexpr char kNotAllowedForPluginSuffix[] =
    " isn't allowed for a plugin";
inline constexpr char kCantBeSentSuffix[] = " can't be sent";
inline constexpr char kActLeaseMissing[] =
    "ardia: no act lease for this page's current document";
inline constexpr char kActLeaseEnded[] =
    "ardia: act lease ended before this input was delivered";
inline constexpr char kActDocumentReplaced[] =
    "ardia: document_changed: the tab loaded a new document since the act was "
    "approved";
inline constexpr char kActTabNotShown[] = "the tab can't be shown for this act";
inline constexpr char kNoActLeaseNow[] = "no lease for this page now";

inline constexpr char kHoldNoCredential[] = "no such credential";
inline constexpr char kNoSuchTab[] = "no such tab";
inline constexpr char kHoldOutOfScope[] = "tab out of scope";
inline constexpr char kHoldNoAttachedSession[] = "no attached session";
inline constexpr char kHoldInProgress[] =
    "another hold on that tab is still being taken";
inline constexpr char kTooManyCredentials[] =
    "too many plugin credentials for this profile";

}

#endif
