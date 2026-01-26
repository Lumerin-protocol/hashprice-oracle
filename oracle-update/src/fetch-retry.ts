/**
 * Fetch with exponential backoff retry for transient failures.
 * Retries on: network errors, 429 (rate limit), 5xx (server errors)
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  context: string,
  maxRetries = 3,
  initialDelayMs = 1000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Retry on rate limit (429) or server errors (5xx)
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const delay = initialDelayMs * Math.pow(2, attempt);
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
          console.log(
            `${context}: HTTP ${response.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`
          );
          await sleep(waitMs);
          continue;
        }
      }

      return response;
    } catch (error) {
      // Network errors (DNS, connection refused, timeout, etc.)
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        console.log(
          `${context}: Network error (${lastError.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await sleep(delay);
        continue;
      }
    }
  }

  throw new Error(`${context}: All ${maxRetries + 1} attempts failed. Last error: ${lastError?.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
