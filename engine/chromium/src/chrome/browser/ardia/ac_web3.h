// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_WEB3_H_
#define CHROME_BROWSER_ARDIA_AC_WEB3_H_

#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"

class GURL;

namespace content {
class BrowserContext;
}

namespace ardia {

inline constexpr char kWeb3Scheme[] = "web3";

enum class Web3Loads { kNavigation, kSubresource };

mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateWeb3URLLoaderFactory(
    content::BrowserContext* context,
    Web3Loads loads);

bool IsWeb3SettingsURL(const GURL& url);

}

#endif
