// ============================================================
// Delay Utilities — Human-like timing for bot automation
// ============================================================

/**
 * Sleep for exactly ms milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random delay between min and max milliseconds
 * Used for human-like pacing between actions
 */
export async function randomDelay(
  minMs: number = 800,
  maxMs: number = 3000,
): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await sleep(delay);
}

/**
 * Typing delay — simulate human typing speed
 * Returns delay per character in ms
 */
export function typingDelay(
  minMs: number = 80,
  maxMs: number = 220,
): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Reading delay — simulate time to read page content
 * Based on average reading speed (~200 words/min)
 */
export async function readingDelay(wordCount: number): Promise<void> {
  const wordsPerMs = 200 / 60000; // 200 words per minute in ms
  const baseDelay = wordCount / wordsPerMs;
  // Add ±20% variance
  const variance = baseDelay * 0.2;
  const delay = baseDelay + (Math.random() * variance * 2 - variance);
  await sleep(Math.max(500, Math.min(delay, 8000))); // Clamp to 0.5s-8s
}

/**
 * Jitter delay — small random delays to avoid patterns
 */
export async function jitter(maxMs: number = 200): Promise<void> {
  await sleep(Math.floor(Math.random() * maxMs));
}

/**
 * Exponential backoff delay for retries
 */
export function exponentialBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  // Add jitter to prevent thundering herd
  return delay + Math.random() * 1000;
}
