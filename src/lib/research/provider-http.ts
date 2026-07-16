import { ProviderResearchError } from "@/lib/research/contracts";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function requestProviderJson(input: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMilliseconds: number;
  phase: "submit" | "poll";
  fetchImplementation?: typeof fetch;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMilliseconds);
  const providerHost = safeHost(input.url);

  try {
    const response = await (input.fetchImplementation ?? fetch)(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw mapHttpFailure({
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        phase: input.phase,
        providerHost
      });
    }
    const value = parseJson(text, input.phase);
    return { value, response };
  } catch (error) {
    if (error instanceof ProviderResearchError) throw error;
    const timeoutFailure = isAbortError(error);
    throw new ProviderResearchError(
      "transient",
      timeoutFailure ? "provider_timeout" : "provider_connection_failed",
      timeoutFailure
        ? "The provider request timed out and will be reconciled safely."
        : "The provider connection was temporarily unavailable.",
      {
        retryAfterSeconds: 10,
        outcome: input.phase === "submit" ? "outcome_uncertain" : "transient_retryable",
        cause: error
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function mapHttpFailure(input: {
  status: number;
  retryAfterSeconds: number | null;
  phase: "submit" | "poll";
  providerHost: string;
}) {
  const priorPaidAcceptancePossible = input.phase === "poll";
  if (input.status === 401 || input.status === 403) {
    return new ProviderResearchError(
      "configuration_error",
      "provider_authentication_failed",
      "The research provider requires administrator configuration.",
      {
        httpStatus: input.status,
        outcome: priorPaidAcceptancePossible ? "outcome_uncertain" : "definitively_rejected"
      }
    );
  }
  if (input.status === 402) {
    return new ProviderResearchError(
      "budget_blocked",
      "provider_credits_unavailable",
      "The research provider has no available credits.",
      {
        httpStatus: input.status,
        outcome: priorPaidAcceptancePossible ? "outcome_uncertain" : "definitively_rejected"
      }
    );
  }
  if (RETRYABLE_STATUS.has(input.status)) {
    const outcomeUncertain = input.phase === "submit" && input.status !== 429;
    return new ProviderResearchError(
      "transient",
      input.status === 429 ? "provider_rate_limited" : "provider_temporarily_unavailable",
      input.status === 429
        ? "The research provider asked us to retry later."
        : "The research provider was temporarily unavailable.",
      {
        retryAfterSeconds: input.retryAfterSeconds ?? 10,
        httpStatus: input.status,
        outcome: outcomeUncertain ? "outcome_uncertain" : "transient_retryable"
      }
    );
  }
  return new ProviderResearchError(
    "permanent",
    "provider_request_rejected",
    `The ${input.providerHost} research request could not be accepted.`,
    {
      httpStatus: input.status,
      outcome: priorPaidAcceptancePossible ? "outcome_uncertain" : "definitively_rejected"
    }
  );
}

function parseJson(text: string, phase: "submit" | "poll"): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new ProviderResearchError(
      phase === "submit" ? "configuration_error" : "transient",
      "provider_response_invalid",
      "The research provider returned an invalid response.",
      {
        outcome: phase === "submit" ? "outcome_uncertain" : "transient_retryable",
        retryAfterSeconds: phase === "poll" ? 10 : undefined,
        cause: error
      }
    );
  }
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3_600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(3_600, Math.max(0, Math.ceil((date - Date.now()) / 1_000)));
}

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function safeHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "provider";
  }
}
