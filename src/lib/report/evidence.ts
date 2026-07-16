import {
  evidenceMetadataSchema,
  type EvidenceMetadata,
  type EvidenceReference
} from "@/lib/report/schema";

interface EvidenceReferenceInput {
  referenceId: string;
  provider: string;
  observationDate: string;
  description: string;
  sourceUrl?: string | null;
}

interface EvidenceInput {
  provider: string;
  observationDate: string;
  explanation: string;
  references?: EvidenceReference[];
  confidence?: number | null;
}

export function createEvidenceReference(input: EvidenceReferenceInput): EvidenceReference {
  return {
    referenceId: input.referenceId,
    provider: input.provider,
    sourceUrl: input.sourceUrl ?? null,
    observationDate: input.observationDate,
    description: input.description
  };
}

export function createMeasuredEvidence(input: EvidenceInput): EvidenceMetadata {
  return evidenceMetadataSchema.parse({
    evidenceStatus: "Measured",
    evidenceReferences: input.references ?? [],
    observationDate: input.observationDate,
    sourceProvider: input.provider,
    confidence: input.confidence ?? null,
    publicExplanation: input.explanation
  });
}

export function createInferredEvidence(input: EvidenceInput): EvidenceMetadata {
  return evidenceMetadataSchema.parse({
    evidenceStatus: "Inferred",
    evidenceReferences: input.references ?? [],
    observationDate: input.observationDate,
    sourceProvider: input.provider,
    confidence: input.confidence ?? null,
    publicExplanation: input.explanation
  });
}

export function createUnavailableEvidence({
  provider,
  observationDate,
  explanation
}: {
  provider?: string | null;
  observationDate?: string | null;
  explanation: string;
}): EvidenceMetadata {
  return evidenceMetadataSchema.parse({
    evidenceStatus: "Unavailable",
    evidenceReferences: [],
    observationDate: observationDate ?? null,
    sourceProvider: provider ?? null,
    confidence: null,
    publicExplanation: explanation
  });
}

export function createNotMeasuredEvidence(explanation: string): EvidenceMetadata {
  return evidenceMetadataSchema.parse({
    evidenceStatus: "Not measured",
    evidenceReferences: [],
    observationDate: null,
    sourceProvider: null,
    confidence: null,
    publicExplanation: explanation
  });
}

export function hasReportableValue(evidence: EvidenceMetadata) {
  return ["Measured", "Estimated", "Inferred"].includes(evidence.evidenceStatus);
}

export function evidenceReferenceId(prefix: string, value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

  return `${prefix}:${normalized || "item"}`;
}
