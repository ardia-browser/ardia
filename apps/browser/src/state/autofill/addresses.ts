import type { AddressInput, SavedAddress } from "../../platform/autofill";

export type AddressForm = {
  name: string;
  organization: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
};

export type AddressProblem = "empty" | "email" | "phone";

const BLANK: AddressForm = { name: "", organization: "", street1: "", street2: "", city: "", state: "", postalCode: "", country: "", phone: "", email: "" };

const streetLines = (street?: string) => (street ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const firstLine = (street?: string) => streetLines(street)[0] ?? "";

export function addressFormOf(saved?: SavedAddress): AddressForm {
  if (!saved) return { ...BLANK };
  const lines = streetLines(saved.street);
  return {
    name: saved.name ?? "",
    organization: saved.organization ?? "",
    street1: lines[0] ?? "",
    street2: lines.slice(1).join(", "),
    city: saved.city ?? "",
    state: saved.state ?? "",
    postalCode: saved.postalCode ?? "",
    country: saved.country ?? "",
    phone: saved.phone ?? "",
    email: saved.email ?? "",
  };
}

const tidy = (text: string) => text.trim().replace(/\s+/g, " ");
const countryOf = (text: string) => (/^[a-z]{2}$/i.test(text.trim()) ? text.trim().toUpperCase() : tidy(text));

export function addressInputOf(form: AddressForm, id?: string): AddressInput {
  const { street1, street2, country, ...rest } = form;
  const input: AddressInput = { street: [street1, street2].map(tidy).filter(Boolean).join("\n"), country: countryOf(country) };
  for (const [key, value] of Object.entries(rest)) (input as Record<string, string>)[key] = tidy(value);
  return id ? { ...input, id } : input;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;
const PERSONAL: readonly (keyof AddressForm)[] = ["name", "organization", "street1", "street2", "city", "state", "postalCode", "phone", "email"];

export function addressProblem(form: AddressForm): AddressProblem | null {
  if (PERSONAL.every((key) => !form[key].trim())) return "empty";
  const email = form.email.trim();
  if (email && !EMAIL.test(email)) return "email";
  const phone = form.phone.trim();
  if (phone && (!PHONE.test(phone) || phone.replace(/\D/g, "").length < 5)) return "phone";
  return null;
}

export function addressChanged(saved: SavedAddress | undefined, form: AddressForm): boolean {
  const now = addressInputOf(form);
  const was = addressInputOf(addressFormOf(saved));
  return (Object.keys(now) as (keyof AddressInput)[]).some((key) => (now[key] ?? "") !== (was[key] ?? ""));
}

export function addressTitle(a: SavedAddress): string {
  return a.name?.trim() || a.organization?.trim() || firstLine(a.street) || a.email?.trim() || a.phone?.trim() || "Address";
}

const POSTAL_FIRST = new Set(["DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "PT", "CZ", "IS", "LU"]);
const COMMA_REGION = new Set(["US", "CA", "AU"]);

export function addressLocality(a: Pick<SavedAddress, "city" | "state" | "postalCode" | "country">): string {
  const country = (a.country ?? "").toUpperCase();
  const city = a.city?.trim() ?? "";
  const region = a.state?.trim() ?? "";
  const postal = a.postalCode?.trim() ?? "";
  if (POSTAL_FIRST.has(country)) return [postal, city].filter(Boolean).join(" ");
  if (COMMA_REGION.has(country)) return [city, [region, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [city, region, postal].filter(Boolean).join(" ");
}

export function addressDetail(a: SavedAddress): string {
  const title = addressTitle(a);
  const street = firstLine(a.street);
  const place = [street === title ? "" : street, addressLocality(a)].filter(Boolean).join(", ");
  if (place) return place;
  return [a.email, a.phone].map((v) => v?.trim() ?? "").find((v) => v && v !== title) ?? "";
}

export function regionLabels(country: string): { region: string; postal: string } {
  const code = country.trim().toUpperCase();
  const region = ["US", "AU", "BR", "MX", "IN"].includes(code) ? "State" : code === "CA" ? "Province" : code === "GB" || code === "IE" ? "County" : code === "JP" ? "Prefecture" : "Region";
  const postal = code === "US" ? "ZIP Code" : code === "GB" || code === "AU" || code === "NZ" ? "Postcode" : code === "IN" ? "PIN Code" : "Postal Code";
  return { region, postal };
}

export function addressMatches(a: SavedAddress, query: string): boolean {
  const hay = [a.name, a.organization, a.street, a.city, a.state, a.postalCode, a.country, a.phone, a.email].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export { firstLine as firstStreetLine };
