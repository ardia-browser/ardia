import { isHexColor } from "../../lib/color";
import { NEUTRAL_BRAND_ACCENT } from "./tokens";
import { vaultProviderOf } from "./store";
import { credential, titleOf } from "./providerModel";
import { isArdiaProvider } from "./ardia";

type VaultBrand = { id: string; name: string; symbol: string; accent: string };

const FALLBACK_SYMBOL = "key.fill";
const ARDIA_NAME = "Ardia";
const UNKNOWN_NAME = "Password Manager";
const SYMBOL_NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

export function brandOf(id: string): VaultBrand {
  const state = vaultProviderOf(id);
  const p = state ? credential(state) : null;
  const name = p ? titleOf(p) : isArdiaProvider(id) ? ARDIA_NAME : UNKNOWN_NAME;
  const symbol = p?.symbol && SYMBOL_NAME.test(p.symbol) ? p.symbol : FALLBACK_SYMBOL;
  const accent = p?.accent && isHexColor(p.accent) ? p.accent : NEUTRAL_BRAND_ACCENT;
  return { id, name, symbol, accent };
}

export const brandAccent = (id: string) => brandOf(id).accent;
