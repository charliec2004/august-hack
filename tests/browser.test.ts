import { describe, expect, it } from "vitest";

import { looksCommitting } from "../src/server/browser/runBrowser";
import { normalizeLoginOrigin, originAllowed } from "../src/server/vault/origin";

describe("login origin binding", () => {
  it("normalizes to the exact https origin", () => {
    expect(normalizeLoginOrigin("https://Example.com/login?next=/")).toBe("https://example.com");
    expect(normalizeLoginOrigin("https://example.com:8443/x")).toBe("https://example.com:8443");
  });

  it("refuses non-https, IPs, single-label hosts and embedded credentials", () => {
    for (const bad of ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://intranet", "https://u:p@example.com", "nope"]) {
      expect(normalizeLoginOrigin(bad)).toBeNull();
    }
  });

  it("never widens to sibling subdomains, other ports, or http", () => {
    const origins = ["https://example.com"];
    expect(originAllowed("https://example.com/account", origins)).toBe(true);
    expect(originAllowed("https://login.example.com/", origins)).toBe(false);
    expect(originAllowed("https://example.com.evil.net/", origins)).toBe(false);
    expect(originAllowed("https://example.com:444/", origins)).toBe(false);
    expect(originAllowed("http://example.com/", origins)).toBe(false);
  });
});

describe("non-committing browser steps", () => {
  it("flags committing controls", () => {
    for (const label of ["Place order", "Book now", "Confirm reservation", "Send", "Pay $20", "Delete account", "Submit"]) {
      expect(looksCommitting(label)).toBe(true);
    }
  });
  it("allows ordinary navigation controls", () => {
    for (const label of ["Next", "Search", "Sign in", "Log in", "Show more", "Filters", "Download report.csv"]) {
      expect(looksCommitting(label)).toBe(false);
    }
  });
});
