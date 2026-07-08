export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 20_000, ...requestInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal
    });

    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}: ${safeErrorMessage(json)}`);
    }

    return json as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Request to ${safeHostname(url)} timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      String(error.name) === "AbortError"
  );
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "provider";
  }
}

function safeErrorMessage(value: unknown) {
  if (typeof value === "object" && value && "message" in value) {
    return String(value.message).slice(0, 180);
  }

  if (typeof value === "object" && value && "error" in value) {
    return String(value.error).slice(0, 180);
  }

  return "Provider request failed.";
}
