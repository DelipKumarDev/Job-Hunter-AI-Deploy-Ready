// ============================================================
// Human Behavior Engine
// Simulates realistic human interaction with web pages.
// Every interaction has randomised timing, movement paths,
// and micro-imperfections that distinguish humans from bots.
//
// Techniques:
//   Mouse  → Quadratic Bézier curves with jitter
//   Typing → Gaussian WPM distribution, 2% typo rate
//   Scroll → Momentum-based deceleration in chunks
//   Click  → Hover → settle → press → hold → release
//   Focus  → Natural tab order simulation
// ============================================================

import type { Page, Mouse } from 'playwright';

// ── Math helpers ──────────────────────────────────────────────

/** Box-Muller Gaussian transform */
function gauss(mean: number, stdDev: number): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stdDev);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// MOUSE — Quadratic Bézier curved movement
// ─────────────────────────────────────────────────────────────

/** Quadratic Bézier point at t ∈ [0,1] */
function bezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  t:  number,
): [number, number] {
  const mt = 1 - t;
  return [
    mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
    mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
  ];
}

/**
 * Move mouse from current position to (toX, toY) along a
 * randomised Bézier curve. Steps ∝ distance for natural speed.
 */
export async function moveMouse(
  page: Page,
  toX:  number,
  toY:  number,
  opts?: { steps?: number; jitterPx?: number },
): Promise<void> {
  const mouse  = page.mouse as Mouse & { _x?: number; _y?: number };
  const fromX  = (mouse as unknown as { _x: number })._x ?? 400;
  const fromY  = (mouse as unknown as { _y: number })._y ?? 300;

  const dx    = toX - fromX;
  const dy    = toY - fromY;
  const dist  = Math.sqrt(dx * dx + dy * dy);
  const steps = opts?.steps ?? Math.max(12, Math.floor(dist / 8));
  const jitter = opts?.jitterPx ?? 3;

  // Random control point offset (makes curve asymmetric)
  const ctrlOffX = gauss(0, dist * 0.3);
  const ctrlOffY = gauss(0, dist * 0.3);

  const ctrl: [number, number] = [
    (fromX + toX) / 2 + ctrlOffX,
    (fromY + toY) / 2 + ctrlOffY,
  ];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out via smooth step
    const ts = t * t * (3 - 2 * t);
    const [bx, by] = bezier([fromX, fromY], ctrl, [toX, toY], ts);

    // Micro-jitter on each step
    const jx = jitter > 0 ? gauss(0, jitter * 0.3) : 0;
    const jy = jitter > 0 ? gauss(0, jitter * 0.3) : 0;

    await page.mouse.move(bx + jx, by + jy);

    // Variable step delay: fast in middle, slower at start/end
    const speedFactor = 1 - Math.abs(t - 0.5) * 0.6;
    await sleep(Math.floor(gauss(8 / speedFactor, 3)));
  }
}

/**
 * Full click: move → hover pause → mousedown → hold → mouseup
 */
export async function humanClick(
  page:    Page,
  x:       number,
  y:       number,
  opts?:   { doubleClick?: boolean; rightClick?: boolean },
): Promise<void> {
  await moveMouse(page, x, y);

  // Hover settle
  await sleep(gauss(120, 40));

  // Tiny pre-click jitter
  await page.mouse.move(x + gauss(0, 1.5), y + gauss(0, 1.5));
  await sleep(gauss(30, 10));

  const button = opts?.rightClick ? 'right' : 'left';
  await page.mouse.down({ button });
  await sleep(gauss(80, 25));   // Human hold duration
  await page.mouse.up({ button });

  if (opts?.doubleClick) {
    await sleep(gauss(90, 20));
    await page.mouse.down({ button });
    await sleep(gauss(70, 20));
    await page.mouse.up({ button });
  }
}

/**
 * Click a Playwright locator element with full human simulation.
 * Gets bounding box and clicks within it (not always dead-center).
 */
export async function humanClickLocator(
  page:     Page,
  selector: string,
): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 8000 });
    const box = await el.boundingBox();
    if (!box) return false;

    // Click slightly off-center (humans rarely click dead-center)
    const targetX = box.x + box.width  * gauss(0.5, 0.15);
    const targetY = box.y + box.height * gauss(0.5, 0.12);

    await humanClick(page, clamp(targetX, box.x + 2, box.x + box.width - 2),
                           clamp(targetY, box.y + 2, box.y + box.height - 2));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// TYPING — Gaussian WPM, 2% typo + backspace correction
// ─────────────────────────────────────────────────────────────

// Realistic WPM distribution for office workers: ~55 WPM mean
const WPM_MEAN   = 55;
const WPM_STDDEV = 12;
const TYPO_RATE  = 0.02;   // 2% chance of typo per character

// Common adjacent-key typos
const TYPO_MAP: Record<string, string[]> = {
  'a': ['s','q','z'], 'e': ['r','w','d'], 'i': ['u','o','k'],
  'o': ['i','p','l'], 's': ['a','d','w'], 't': ['r','y','g'],
  'n': ['b','m','h'], 'r': ['e','t','f'], 'l': ['k','o',';'],
  'd': ['s','f','e'], 'h': ['g','j','y'], 'c': ['x','v','d'],
};

function getTypoChar(c: string): string | null {
  const alternatives = TYPO_MAP[c.toLowerCase()];
  if (!alternatives) return null;
  return alternatives[Math.floor(Math.random() * alternatives.length)]!;
}

function charDelay(wpm: number): number {
  // ms per character = (60000ms/min) / (wpm * 5 chars/word)
  const baseMs = 60000 / (wpm * 5);
  return Math.max(30, gauss(baseMs, baseMs * 0.4));
}

/**
 * Type text with realistic WPM, Gaussian jitter, and occasional
 * typos that are immediately backspaced and corrected.
 */
export async function humanType(
  page:     Page,
  selector: string,
  text:     string,
  opts?:    { clearFirst?: boolean; pressEnter?: boolean },
): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 8000 });

  // Click into field first
  const box = await el.boundingBox();
  if (box) {
    await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await el.click();
  }
  await sleep(gauss(150, 50));

  if (opts?.clearFirst) {
    await page.keyboard.press('Control+a');
    await sleep(gauss(80, 20));
    await page.keyboard.press('Delete');
    await sleep(gauss(80, 20));
  }

  const wpm = clamp(gauss(WPM_MEAN, WPM_STDDEV), 25, 90);

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    // Occasional pause (thinking, distraction)
    if (Math.random() < 0.02 && i > 0) {
      await sleep(gauss(400, 150));
    }

    // Typo simulation
    if (Math.random() < TYPO_RATE && char.match(/[a-zA-Z]/)) {
      const typo = getTypoChar(char);
      if (typo) {
        await page.keyboard.type(typo, { delay: 0 });
        await sleep(gauss(charDelay(wpm) * 1.5, 30));
        await page.keyboard.press('Backspace');
        await sleep(gauss(charDelay(wpm) * 0.8, 20));
      }
    }

    await page.keyboard.type(char, { delay: 0 });
    await sleep(charDelay(wpm));
  }

  if (opts?.pressEnter) {
    await sleep(gauss(200, 60));
    await page.keyboard.press('Enter');
  }
}

// ─────────────────────────────────────────────────────────────
// SCROLLING — Momentum-based deceleration
// ─────────────────────────────────────────────────────────────

/**
 * Scroll page by `totalPx` pixels with human momentum.
 * Split into 4–7 chunks with decreasing speed (deceleration).
 */
export async function humanScroll(
  page:     Page,
  totalPx:  number,
  opts?:    { horizontal?: boolean },
): Promise<void> {
  const chunks = randInt(4, 7);
  let remaining = totalPx;

  for (let i = 0; i < chunks; i++) {
    const isLast      = i === chunks - 1;
    // Decelerate: first chunks faster, last chunk slower
    const fraction    = isLast ? 1 : gauss(1 / chunks, 0.1 / chunks);
    const chunkPx     = isLast ? remaining : Math.round(remaining * fraction);
    const speed       = Math.max(0.3, 1 - (i / chunks) * 0.7); // Slow down

    if (opts?.horizontal) {
      await page.mouse.wheel(chunkPx, 0);
    } else {
      await page.mouse.wheel(0, chunkPx);
    }

    remaining -= chunkPx;
    await sleep(gauss(180 / speed, 60));
  }
}

/**
 * Scroll to reveal an element, then pause as if reading it.
 */
export async function scrollToElement(
  page:     Page,
  selector: string,
): Promise<void> {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  await sleep(gauss(300, 100));

  // Small over-scroll + correction (human overshoot)
  if (Math.random() < 0.4) {
    await humanScroll(page, 80);
    await sleep(gauss(200, 60));
    await humanScroll(page, -60);
    await sleep(gauss(150, 40));
  }
}

// ─────────────────────────────────────────────────────────────
// SELECT — Dropdown with human timing
// ─────────────────────────────────────────────────────────────

export async function humanSelect(
  page:     Page,
  selector: string,
  value:    string,
): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 6000 });

    // Click to open dropdown
    await humanClickLocator(page, selector);
    await sleep(gauss(300, 80));

    // Try native select first
    await el.selectOption({ label: value }).catch(() => null);
    await sleep(gauss(200, 50));

    // Verify selection
    const selected = await el.inputValue().catch(() => '');
    if (selected && selected !== '') return true;

    // Fallback: try by value
    await el.selectOption({ value }).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// CHECKBOX / RADIO
// ─────────────────────────────────────────────────────────────

export async function humanCheckbox(
  page:     Page,
  selector: string,
  check:    boolean,
): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'attached', timeout: 5000 });
  const checked = await el.isChecked().catch(() => false);

  if (checked !== check) {
    const box = await el.boundingBox();
    if (box) {
      await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await el.click();
    }
    await sleep(gauss(150, 40));
  }
}

// ─────────────────────────────────────────────────────────────
// READING PAUSE — simulate reading job description
// ─────────────────────────────────────────────────────────────

/**
 * Pause as if reading content. Duration ∝ word count.
 */
export async function readingPause(
  page:      Page,
  wordCount: number = 200,
): Promise<void> {
  // Average reading speed: ~200 WPM → 3.33 words/sec
  const baseMs   = (wordCount / 3.33) * 1000;
  const duration = gauss(baseMs * 0.3, baseMs * 0.1); // Skim reading
  const scrolls  = Math.floor(wordCount / 150);

  for (let i = 0; i < scrolls; i++) {
    await sleep(duration / (scrolls + 1));
    await humanScroll(page, randInt(200, 500));
  }
  await sleep(gauss(1000, 300));
}
