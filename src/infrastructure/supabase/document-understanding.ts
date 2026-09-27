// Document Understanding owns Extracted Observations and never chooses canonical values
// (docs/ARCHITECTURE.md). This interface only resolves which observation to *display* as
// provenance for a field another module has already resolved, mirroring the resolution
// policy in migration 202609220010 (confidence desc nulls last, then created_at desc) so
// the shown provenance always matches the observation that actually won field resolution.

export interface InvoiceFieldProvenance {
  confidence: number | null;
  page: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  provider: string;
  modelVersion: string;
  promptVersion: string;
  extractedAt: string;
}

export interface RawExtractedObservation {
  field_name: string;
  source_location: unknown;
  confidence: number | null;
  provider: string;
  model_version: string;
  schema_version: string;
  created_at: string;
}

export function getDisplayProvenance(observations: RawExtractedObservation[]): Record<string, InvoiceFieldProvenance> {
  const provenance: Record<string, InvoiceFieldProvenance> = {};
  for (const observation of observations) {
    const location = parseSourceLocation(observation.source_location);
    if (!location) continue;
    const existing = provenance[observation.field_name];
    const confidence = observation.confidence === null ? null : Number(observation.confidence);
    if (existing && ((confidence ?? -1) < (existing.confidence ?? -1)
      || ((confidence ?? -1) === (existing.confidence ?? -1) && new Date(observation.created_at) <= new Date(existing.extractedAt)))) continue;
    provenance[observation.field_name] = { confidence, ...location, provider: observation.provider, modelVersion: observation.model_version,
      promptVersion: observation.schema_version, extractedAt: observation.created_at };
  }
  return provenance;
}

function parseSourceLocation(value: unknown): Pick<InvoiceFieldProvenance, "page" | "boundingBox"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const location = value as Record<string, unknown>;
  if (!Number.isSafeInteger(location.page) || Number(location.page) < 1) return null;
  const box = location.boundingBox;
  if (!box || typeof box !== "object" || Array.isArray(box)) return { page: Number(location.page) };
  const candidate = box as Record<string, unknown>;
  if (!["x", "y", "width", "height"].every((key) => typeof candidate[key] === "number")) return { page: Number(location.page) };
  return { page: Number(location.page), boundingBox: { x: Number(candidate.x), y: Number(candidate.y), width: Number(candidate.width), height: Number(candidate.height) } };
}
