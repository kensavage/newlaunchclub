import {
  CONTENT_SELECTION_VERSION,
  type ContentPageClassification,
  type ContentSelectionLimits,
  type ContentSelectionPage,
  type ContentSelectionResult,
  type WebsiteEvidencePage
} from "@/lib/research/contracts";
import { sha256, stableJson } from "@/lib/research/integrity";

export const DEFAULT_CONTENT_SELECTION_LIMITS: ContentSelectionLimits = {
  maximumTotalCharacters: 48_000,
  maximumPageCharacters: 12_000,
  maximumLegalCharacters: 3_600,
  maximumPages: 8,
  duplicateThreshold: 0.88
};

const CLASSIFICATION_PRIORITY: Record<ContentPageClassification, number> = {
  homepage: 0,
  product_service: 1,
  solution_use_case: 2,
  pricing: 3,
  about: 4,
  proof: 5,
  team: 6,
  contact_location: 7,
  documentation: 8,
  general: 9,
  legal_admin: 10
};

export function selectCompanyProfileContext(
  evidencePages: WebsiteEvidencePage[],
  limits: ContentSelectionLimits = DEFAULT_CONTENT_SELECTION_LIMITS
): ContentSelectionResult {
  validateLimits(limits);
  const classified = evidencePages.map((page) => ({
    page,
    classification: classifyPage(page)
  })).sort((left, right) =>
    CLASSIFICATION_PRIORITY[left.classification] - CLASSIFICATION_PRIORITY[right.classification] ||
    left.page.pageIndex - right.page.pageIndex ||
    left.page.canonicalUrl.localeCompare(right.page.canonicalUrl)
  );
  const selectedFingerprints: Set<string>[] = [];
  const maximumOrdinaryPage = Math.min(
    limits.maximumPageCharacters,
    Math.floor(limits.maximumTotalCharacters * 0.25)
  );
  const maximumLegal = Math.min(
    limits.maximumLegalCharacters,
    Math.floor(limits.maximumTotalCharacters * 0.09)
  );
  let remainingTotal = limits.maximumTotalCharacters;
  let remainingLegal = maximumLegal;
  let includedCount = 0;
  let selectedOrder = 0;

  const ranked = classified.map(({ page, classification }, rank): ContentSelectionPage => {
    const originalCharacters = page.markdown.length;
    const candidate = classification === "legal_admin"
      ? selectLegalExcerpts(page.markdown)
      : removeRepeatedLines(page.markdown);
    const fingerprint = wordShingles(candidate);
    const duplicateOf = selectedFingerprints.findIndex(
      (prior) => similarity(prior, fingerprint) >= limits.duplicateThreshold
    );
    let exclusionReason: string | null = null;
    if (!candidate.trim()) exclusionReason = "No useful business-profile text remained after filtering.";
    else if (duplicateOf >= 0) exclusionReason = `Near-duplicate of selected page ${duplicateOf + 1}.`;
    else if (includedCount >= limits.maximumPages) exclusionReason = "Maximum included-page limit reached.";
    else if (remainingTotal <= 0) exclusionReason = "Total context limit reached.";
    else if (classification === "legal_admin" && remainingLegal <= 0) {
      exclusionReason = "Legal and administrative context limit reached.";
    }

    const selectedTotal = limits.maximumTotalCharacters - remainingTotal;
    const selectedLegal = maximumLegal - remainingLegal;
    const selectedNonLegal = selectedTotal - selectedLegal;
    const relativeLegalLimit = Math.floor(selectedNonLegal * 0.09 / 0.91);
    const remainingRelativeLegal = Math.max(0, relativeLegalLimit - selectedLegal);
    const pageLimit = classification === "legal_admin"
      ? Math.min(maximumOrdinaryPage, remainingLegal, remainingRelativeLegal)
      : maximumOrdinaryPage;
    const selectedMarkdown = exclusionReason
      ? ""
      : truncateAtBoundary(candidate, Math.min(pageLimit, remainingTotal));
    if (!selectedMarkdown.trim() && !exclusionReason) {
      exclusionReason = "No context capacity remained for this page.";
    }
    const included = !exclusionReason && selectedMarkdown.length > 0;
    if (included) {
      includedCount += 1;
      selectedOrder += 1;
      remainingTotal -= selectedMarkdown.length;
      if (classification === "legal_admin") remainingLegal -= selectedMarkdown.length;
      selectedFingerprints.push(fingerprint);
    }
    return {
      snapshotId: page.snapshotId,
      pageIndex: page.pageIndex,
      sourceUrl: page.sourceUrl,
      canonicalUrl: page.canonicalUrl,
      title: page.title,
      description: page.description,
      contentHash: page.contentHash,
      classification,
      rank: rank + 1,
      included,
      inclusionReason: included ? inclusionReason(classification) : null,
      exclusionReason,
      originalCharacters,
      selectedCharacters: selectedMarkdown.length,
      selectedOrder: included ? selectedOrder : null,
      selectedContentHash: included ? sha256(selectedMarkdown) : null,
      selectedMarkdown
    };
  });
  const pages = ranked.sort((left, right) => left.pageIndex - right.pageIndex);
  const totalSelectedCharacters = pages.reduce((sum, page) => sum + page.selectedCharacters, 0);
  return {
    version: CONTENT_SELECTION_VERSION,
    inputHash: sha256(stableJson({
      version: CONTENT_SELECTION_VERSION,
      limits,
      pages: pages.map((page) => [page.snapshotId, page.contentHash])
    })),
    limits,
    totalOriginalCharacters: pages.reduce((sum, page) => sum + page.originalCharacters, 0),
    totalSelectedCharacters,
    legalSelectedCharacters: pages
      .filter((page) => page.classification === "legal_admin")
      .reduce((sum, page) => sum + page.selectedCharacters, 0),
    pages
  };
}

function classifyPage(page: WebsiteEvidencePage): ContentPageClassification {
  const url = new URL(page.canonicalUrl);
  const value = `${url.pathname} ${page.title ?? ""}`.toLocaleLowerCase("en-US");
  if (url.pathname === "/" || url.pathname === "") return "homepage";
  if (/privacy|terms|cookie|legal|accessibility|login|sign-in|account|wp-admin/.test(value)) return "legal_admin";
  if (/pricing|plans|packages/.test(value)) return "pricing";
  if (/case-stud|customer-stor|testimonial|reviews?|results|success-stor/.test(value)) return "proof";
  if (/products?|services?/.test(value)) return "product_service";
  if (/solutions?|use-cases?|industries/.test(value)) return "solution_use_case";
  if (/about|company|our-story|mission/.test(value)) return "about";
  if (/team|founder|leadership|people/.test(value)) return "team";
  if (/contact|locations?|offices?/.test(value)) return "contact_location";
  if (/docs?|guides?|resources?|help|knowledge/.test(value)) return "documentation";
  return "general";
}

function inclusionReason(classification: ContentPageClassification) {
  if (classification === "legal_admin") return "Targeted legal excerpt supports company identity or location facts.";
  return `Selected as ${classification.replaceAll("_", " ")} business evidence.`;
}

function selectLegalExcerpts(markdown: string) {
  const useful = /\b(?:company|corporation|incorporated|inc|llc|limited|ltd|address|located|jurisdiction|registered|headquarters|contact)\b/i;
  return markdown.split(/\n+/).map((line) => line.trim()).filter((line) =>
    line.length >= 20 && useful.test(line)
  ).join("\n");
}

function removeRepeatedLines(markdown: string) {
  const seen = new Set<string>();
  return markdown.split(/\n+/).map((line) => line.trim()).filter((line) => {
    if (line.length < 20) return false;
    const normalized = line.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join("\n");
}

function wordShingles(value: string) {
  const words = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  for (let index = 0; index < words.length - 4; index += 1) {
    shingles.add(words.slice(index, index + 5).join(" "));
  }
  if (!shingles.size && words.length) shingles.add(words.join(" "));
  return shingles;
}

function similarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(left.size, right.size);
}

function truncateAtBoundary(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  if (maximum <= 0) return "";
  const candidate = value.slice(0, maximum);
  const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(". "));
  return candidate.slice(0, boundary >= maximum * 0.7 ? boundary + 1 : maximum).trim();
}

function validateLimits(limits: ContentSelectionLimits) {
  if (
    limits.maximumTotalCharacters < 4_000 ||
    limits.maximumPageCharacters < 1_000 ||
    limits.maximumLegalCharacters < 0 ||
    limits.maximumPages < 1 ||
    limits.duplicateThreshold < 0.5 ||
    limits.duplicateThreshold > 1
  ) {
    throw new Error("Invalid company-profile context-selection limits.");
  }
}
