/**
 * What Agent Desk sells and what it costs.
 *
 * Prices live here, in code, and nowhere else. The planner (an LLM) chooses
 * which services a request needs; it never chooses a price. All money is in
 * integer cents so no rounding happens between the quote and the capture.
 */

export type ServiceId = 'transcribe' | 'tts' | 'background' | 'translate' | 'grammar';

export interface Service {
  id: ServiceId;
  title: string;
  /** One line for the planner and the MCP tool list. */
  summary: string;
  unit: 'minute' | 'char' | 'image';
  /** Cents per `per` units, rounded up to whole blocks. */
  cents: number;
  per: number;
  minCents: number;
  /** How the QA judge decides whether the output is worth paying for. */
  check: string;
}

export const SERVICES: Record<ServiceId, Service> = {
  transcribe: {
    id: 'transcribe',
    title: 'Transcribe audio (English)',
    summary: 'Speech to text for English audio or video, up to 25 MB.',
    unit: 'minute', cents: 10, per: 1, minCents: 25,
    check: 'Words-per-minute sanity check, then a model rates coherence and language.',
  },
  tts: {
    id: 'tts',
    title: 'Text to speech',
    summary: 'Natural voice-over in English, French, Spanish, Italian, Portuguese, Hindi, Japanese or Mandarin.',
    unit: 'char', cents: 5, per: 500, minCents: 10,
    check: 'The audio is transcribed back and must match the text (word error rate 15% or less).',
  },
  background: {
    id: 'background',
    title: 'Remove image background',
    summary: 'Cut the subject out of a PNG, JPEG or WebP image.',
    unit: 'image', cents: 15, per: 1, minCents: 15,
    check: 'The cut-out must keep between 5% and 95% of the image as one main subject.',
  },
  translate: {
    id: 'translate',
    title: 'Translate text',
    summary: 'Machine translation for zh→en, en→zh, en→vi, vi→en, ja→en and ko→en.',
    unit: 'char', cents: 5, per: 500, minCents: 5,
    check: 'Translated back, then a model checks numbers, negatives and meaning phrase by phrase; it must score 4/5 or better.',
  },
  grammar: {
    id: 'grammar',
    title: 'Grammar and spelling check',
    summary: 'Rule-based grammar, spelling and style suggestions.',
    unit: 'char', cents: 2, per: 1000, minCents: 2,
    check: 'Deterministic: passes when the checker answers.',
  },
};

/** Price in cents for `quantity` units of a service. */
export function priceCents(id: ServiceId, quantity: number): number {
  const s = SERVICES[id];
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError(`bad quantity for ${id}: ${quantity}`);
  const blocks = Math.ceil(quantity / s.per);
  return Math.max(s.minCents, blocks * s.cents);
}

/** "1.25" for PayPal's amount.value. */
export const toPayPalValue = (cents: number): string => {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`bad cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
};
