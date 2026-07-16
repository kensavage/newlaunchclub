// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WebsiteEvidencePage } from "@/lib/research/contracts";
import { selectCompanyProfileContext } from "@/lib/research/context-selection";
import { sha256 } from "@/lib/research/integrity";

const limits = {
  maximumTotalCharacters: 20_000,
  maximumPageCharacters: 8_000,
  maximumLegalCharacters: 3_000,
  maximumPages: 8,
  duplicateThreshold: 0.88
};

describe("PR4 deterministic company-profile context selection", () => {
  it("ranks business pages, caps each page, and excludes near-duplicates", () => {
    const serviceText = paragraphs("Buyer visibility research service", 90);
    const pages = [
      evidencePage(0, "/", "Launch Club", paragraphs("Homepage company positioning", 100)),
      evidencePage(1, "/services", "Services", serviceText),
      evidencePage(2, "/services-copy", "Services copy", serviceText),
      evidencePage(3, "/about", "About Launch Club", paragraphs("Company mission and team", 70)),
      evidencePage(4, "/case-studies", "Customer results", paragraphs("Customer proof and results", 70))
    ];

    const selection = selectCompanyProfileContext(pages, limits);
    const duplicate = selection.pages.find((page) => page.pageIndex === 2)!;

    expect(selection.totalSelectedCharacters).toBeLessThanOrEqual(limits.maximumTotalCharacters);
    expect(selection.pages.filter((page) => page.included)).toHaveLength(4);
    expect(selection.pages.filter((page) => page.included).every(
      (page) => page.selectedCharacters <= limits.maximumTotalCharacters * 0.25
    )).toBe(true);
    expect(duplicate).toMatchObject({
      included: false,
      selectedCharacters: 0,
      selectedMarkdown: ""
    });
    expect(duplicate.exclusionReason).toMatch(/Near-duplicate/);
    expect(selection.pages.find((page) => page.pageIndex === 0)?.rank).toBe(1);
    expect(selection.pages.find((page) => page.pageIndex === 1)?.classification)
      .toBe("product_service");
  });

  it("retains auditable legal evidence while selecting only a small targeted excerpt", () => {
    const legalBoilerplate = paragraphs("Your use of this policy is subject to generic provisions", 220);
    const identityLine = "Launch Club LLC is a registered company located at 123 Market Street, New York.";
    const pages = [
      evidencePage(0, "/", "Launch Club", paragraphs("Homepage buyer visibility offer", 70)),
      evidencePage(1, "/about", "About", paragraphs("Company background and customers", 70)),
      evidencePage(2, "/privacy", "Privacy policy", `${legalBoilerplate}\n${identityLine}`)
    ];

    const selection = selectCompanyProfileContext(pages, limits);
    const legal = selection.pages.find((page) => page.pageIndex === 2)!;

    expect(legal).toMatchObject({
      classification: "legal_admin",
      included: true,
      originalCharacters: pages[2]!.markdown.length
    });
    expect(legal.selectedMarkdown).toBe(identityLine);
    expect(legal.selectedMarkdown).not.toContain("generic provisions");
    expect(selection.legalSelectedCharacters).toBeLessThanOrEqual(
      Math.floor(limits.maximumTotalCharacters * 0.09)
    );
    expect(selection.legalSelectedCharacters / selection.totalSelectedCharacters).toBeLessThan(0.1);
    expect(pages[2]!.markdown).toContain(legalBoilerplate.slice(0, 80));
  });

  it("is deterministic and records an audit decision for every immutable snapshot", () => {
    const pages = [
      evidencePage(0, "/", "Home", paragraphs("Core company positioning", 60)),
      evidencePage(1, "/pricing", "Pricing", paragraphs("Pricing packages and plans", 60)),
      evidencePage(2, "/terms", "Terms", paragraphs("Terms without useful identity facts", 80)),
      evidencePage(3, "/contact", "Contact", paragraphs("Contact and office details", 60))
    ];

    const first = selectCompanyProfileContext(pages, { ...limits, maximumPages: 2 });
    const second = selectCompanyProfileContext(structuredClone(pages), { ...limits, maximumPages: 2 });

    expect(second).toEqual(first);
    expect(first.pages).toHaveLength(pages.length);
    expect(first.pages.every((page) => Boolean(page.inclusionReason) !== Boolean(page.exclusionReason)))
      .toBe(true);
    expect(first.pages.filter((page) => page.included)).toHaveLength(2);
    expect(first.pages.find((page) => page.pageIndex === 2)).toMatchObject({
      classification: "legal_admin",
      included: false,
      selectedCharacters: 0
    });
  });
});

function evidencePage(
  pageIndex: number,
  pathname: string,
  title: string,
  markdown: string
): WebsiteEvidencePage {
  const canonicalUrl = new URL(pathname, "https://launchclub.example/").toString();
  return {
    snapshotId: `00000000-0000-4000-8000-${String(pageIndex + 1).padStart(12, "0")}`,
    pageIndex,
    sourceUrl: canonicalUrl,
    canonicalUrl,
    title,
    description: null,
    markdown,
    contentHash: sha256(markdown),
    crawledAt: "2026-01-15T12:00:00.000Z",
    providerCreatedAt: "2026-01-15T12:00:00.000Z",
    freshUntil: "2026-01-17T12:00:00.000Z"
  };
}

function paragraphs(seed: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    `${seed} paragraph ${index + 1} explains a distinct factual detail for prospective customers and evaluators.`
  ).join("\n");
}
