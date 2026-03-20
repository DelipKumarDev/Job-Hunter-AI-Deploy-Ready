// ── Timing utilities for all scrapers ────────────────────────
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Gaussian-distributed random delay — realistic inter-request timing */
function gaussRandom(mean: number, stdDev: number): number {
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stdDev);
}

export const randomDelay = (min = 1000, max = 3000) =>
  sleep(min + Math.random() * (max - min));

export const humanDelay = (mean = 1500, stdDev = 500) =>
  sleep(gaussRandom(mean, stdDev));

export const pageDelay  = () => humanDelay(2500, 800);
export const scrollDelay= () => humanDelay(400, 150);
export const clickDelay = () => humanDelay(600, 200);
