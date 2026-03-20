/**
 * ============================================================
 * Claude API Client — worker-ai
 *
 * connectClaude() must be called with the resolved API key
 * from the secrets loader before getClient() is used.
 * The key is stored in a module-level variable; it is never
 * written to logs or error messages.
 * ============================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

const MODELS = {
  FAST:  process.env['ANTHROPIC_MODEL_FAST']  ?? 'claude-haiku-4-5-20251001',
  SMART: process.env['ANTHROPIC_MODEL_SMART'] ?? 'claude-sonnet-4-6',
} as const;

const TOKEN_COSTS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.25,  output: 1.25  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
};

export interface ClaudeResponse {
  content: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  estimatedCostUsd: number;
  durationMs: number;
}

export interface ClaudeCallOptions {
  systemPrompt: string;
  userPrompt:   string;
  model?:       'FAST' | 'SMART';
  maxTokens?:   number;
  temperature?: number;
  maxRetries?:  number;
}

let _client: Anthropic | null = null;

/**
 * Initialise the Anthropic client with an explicitly provided key.
 * Call this once in the worker entry point after loading secrets.
 */
export function connectClaude(apiKey: string): void {
  if (!apiKey) throw new Error('[claudeClient] apiKey must be non-empty');
  _client = new Anthropic({ apiKey });
  // Log that connection was configured — NOT the key value
  logger.info('Anthropic client initialized');
}

function getClient(): Anthropic {
  if (!_client) throw new Error('[claudeClient] connectClaude() must be called first');
  return _client;
}

export async function callClaude(options: ClaudeCallOptions): Promise<ClaudeResponse> {
  const {
    systemPrompt,
    userPrompt,
    model      = 'FAST',
    maxTokens  = parseInt(process.env['AI_MAX_TOKENS'] ?? '2048', 10),
    temperature = parseFloat(process.env['AI_TEMPERATURE'] ?? '0.1'),
    maxRetries  = 3,
  } = options;

  const modelId = MODELS[model];
  const client  = getClient();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startMs = Date.now();
    try {
      const response = await client.messages.create({
        model: modelId, max_tokens: maxTokens, temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const durationMs    = Date.now() - startMs;
      const content       = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');
      const inputTokens   = response.usage.input_tokens;
      const outputTokens  = response.usage.output_tokens;
      const tokensUsed    = inputTokens + outputTokens;
      const costs         = TOKEN_COSTS[modelId];
      const estimatedCostUsd = costs
        ? (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output
        : 0;

      logger.debug('Claude call success', { model: modelId, inputTokens, outputTokens, durationMs, attempt });
      return { content, tokensUsed, inputTokens, outputTokens, model: modelId, estimatedCostUsd, durationMs };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRateLimit = lastError.message.includes('429') || lastError.message.includes('rate_limit');
      const isOverload  = lastError.message.includes('529') || lastError.message.includes('overloaded');

      if ((isRateLimit || isOverload) && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        logger.warn('Claude rate limited, retrying', { attempt, delayMs: delay });
        await sleep(delay);
        continue;
      }
      logger.error('Claude call failed', { attempt, model: modelId });
      throw lastError;
    }
  }

  throw lastError ?? new Error('Claude call failed after all retries');
}

export async function callClaudeForJson<T>(
  options: ClaudeCallOptions,
  validator: (parsed: unknown) => T,
): Promise<{ data: T; meta: Omit<ClaudeResponse, 'content'> }> {
  const response = await callClaude(options);
  let jsonText = response.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = jsonText.indexOf('{');
  const last  = jsonText.lastIndexOf('}');
  if (first !== -1 && last !== -1) jsonText = jsonText.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    logger.error('Claude returned invalid JSON', { raw: response.content.substring(0, 200) });
    throw new Error(`Claude returned invalid JSON: ${String(e)}`);
  }

  const data = validator(parsed);
  const { content: _c, ...meta } = response;
  return { data, meta };
}

export function selectModel(context: 'bulk' | 'detail'): 'FAST' | 'SMART' {
  return context === 'detail' ? 'SMART' : 'FAST';
}

let dailyCostAccumulator = 0;
const MAX_DAILY = parseFloat(process.env['MAX_DAILY_AI_COST_USD'] ?? '50');
export function trackCost(costUsd: number): void {
  dailyCostAccumulator += costUsd;
  if (dailyCostAccumulator > MAX_DAILY) {
    logger.error('Daily AI cost limit exceeded', { accumulated: dailyCostAccumulator.toFixed(4), limit: MAX_DAILY });
  }
}
export function getDailyAccumulatedCost(): number { return dailyCostAccumulator; }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
