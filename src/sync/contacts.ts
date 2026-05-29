/**
 * Contact deduplication.
 *
 * Two systems independently capture the same person, often with slightly different emails
 * (case, whitespace, or gmail dot/plus variants). These helpers normalize emails and detect
 * duplicates so the dedupe tool can merge them into a single Salesforce Contact — falling back
 * to an elicitation prompt when the canonical address is ambiguous.
 */

export interface ContactLike {
  id: string;
  name?: string;
  email?: string;
  source: "procore" | "salesforce";
}

/**
 * Canonicalize an email for comparison: lowercase, trim, and for Gmail/Googlemail strip dots
 * and any `+tag` from the local part (Gmail ignores both). Other providers keep the local part
 * verbatim. Returns "" for missing/invalid input.
 */
export function normalizeEmail(email: string | undefined | null): string {
  if (!email) return "";
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return ""; // no local part or no domain
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  if (!local) return "";
  return `${local}@${domain}`;
}

/** True if two contacts are the same person by normalized email. */
export function sameContactByEmail(a: ContactLike, b: ContactLike): boolean {
  const na = normalizeEmail(a.email);
  const nb = normalizeEmail(b.email);
  return na !== "" && na === nb;
}

export interface DuplicateGroup {
  normalizedEmail: string;
  contacts: ContactLike[];
  /** True when the raw emails differ (so a canonical address must be chosen). */
  emailsDiffer: boolean;
}

/**
 * Group contacts that resolve to the same normalized email. Only groups with 2+ members are
 * returned. `emailsDiffer` flags groups where the raw addresses aren't identical — those need a
 * human-confirmed canonical email (elicitation) before merging.
 */
export function findDuplicates(contacts: ContactLike[]): DuplicateGroup[] {
  const groups = new Map<string, ContactLike[]>();
  for (const c of contacts) {
    const key = normalizeEmail(c.email);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const out: DuplicateGroup[] = [];
  for (const [normalizedEmail, list] of groups) {
    if (list.length < 2) continue;
    const distinctRaw = new Set(list.map((c) => (c.email ?? "").trim().toLowerCase()));
    out.push({ normalizedEmail, contacts: list, emailsDiffer: distinctRaw.size > 1 });
  }
  return out;
}
