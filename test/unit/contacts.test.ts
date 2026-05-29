import { describe, it, expect } from "vitest";
import { normalizeEmail, sameContactByEmail, findDuplicates, type ContactLike } from "../../src/sync/contacts.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  John.Doe@Acme.COM ")).toBe("john.doe@acme.com");
  });
  it("strips dots and +tags for gmail", () => {
    expect(normalizeEmail("jordan.rivera+jobs@gmail.com")).toBe("jordanrivera@gmail.com");
    expect(normalizeEmail("jordanrivera@googlemail.com")).toBe("jordanrivera@googlemail.com");
  });
  it("keeps dots for non-gmail providers", () => {
    expect(normalizeEmail("jordan.rivera@acme.com")).toBe("jordan.rivera@acme.com");
  });
  it("returns empty for invalid/missing", () => {
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail("not-an-email")).toBe("");
    expect(normalizeEmail("@nolocal.com")).toBe("");
    expect(normalizeEmail("nodomain@")).toBe("");
    expect(normalizeEmail(".@gmail.com")).toBe(""); // local empties out after dot-stripping
  });
});

describe("sameContactByEmail", () => {
  const a: ContactLike = { id: "1", email: "Jordan.Rivera@acme.com", source: "procore" };
  const b: ContactLike = { id: "2", email: "jordan.rivera@acme.com", source: "salesforce" };
  const c: ContactLike = { id: "3", email: "other@acme.com", source: "salesforce" };
  it("matches case-insensitively", () => expect(sameContactByEmail(a, b)).toBe(true));
  it("rejects different people", () => expect(sameContactByEmail(a, c)).toBe(false));
  it("rejects when an email is missing", () =>
    expect(sameContactByEmail({ id: "x", source: "procore" }, b)).toBe(false));
});

describe("findDuplicates", () => {
  it("groups same-email contacts and flags differing raw addresses", () => {
    const contacts: ContactLike[] = [
      { id: "p1", email: "jrivera@gmail.com", source: "procore" },
      { id: "s1", email: "j.rivera@gmail.com", source: "salesforce" }, // gmail dot → same
      { id: "p2", email: "unique@acme.com", source: "procore" },
    ];
    const groups = findDuplicates(contacts);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contacts.map((c) => c.id).sort()).toEqual(["p1", "s1"]);
    expect(groups[0]!.emailsDiffer).toBe(true);
  });

  it("returns no groups when all emails are distinct", () => {
    expect(findDuplicates([
      { id: "1", email: "a@x.com", source: "procore" },
      { id: "2", email: "b@x.com", source: "salesforce" },
    ])).toHaveLength(0);
  });
});
