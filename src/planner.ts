/**
 * Planner: turns a buyer's request into a pipeline of Fixlark services.
 *
 * Nemotron proposes the steps. Code then checks every step (the service
 * exists, the input type fits, the language pair is offered, the size is
 * within limits) and prices the plan from the fixed table. The model sees the
 * request and a description of each attachment (type, size), never the
 * attachment's content, and it never sees or sets a price.
 */
import { z } from 'zod';
import type { LLM } from './llm/client.ts';
import { SERVICES, priceCents, type ServiceId } from './catalog.ts';
import { checkOutput, newCanary, safeLine, scopedSystem, wrapUser } from './guard/guard.ts';
import { config } from './config.ts';

export type DataKind = 'text' | 'audio' | 'image';

export interface InputDesc {
  kind: DataKind;
  name: string;
  bytes?: number;
  chars?: number;
  /** Audio length, estimated at upload. */
  minutes?: number;
  /** A text's language, detected by code from its script. Wins over the planner's guess. */
  language?: string;
}

const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g;
/**
 * The language of a text from its script alone, or undefined when the script
 * doesn't settle it (most Latin-script languages). The planner never sees the
 * text, only its size, so without this it guesses from the request's wording.
 */
export function detectLanguage(text: string): string | undefined {
  const t = text.toLowerCase();
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters < 3) return undefined;
  const share = (re: RegExp) => (t.match(re) ?? []).length / letters;
  if (share(/[\uac00-\ud7af\u1100-\u11ff]/g) > 0.3) return 'ko';
  if (share(/[\u3040-\u30ff]/g) > 0.1) return 'ja';
  if (share(/[\u4e00-\u9fff]/g) > 0.3) return 'zh';
  if (share(VIETNAMESE) > 0.03) return 'vi';
  return undefined;
}

export const TRANSLATE_PAIRS = new Set(['zh-en', 'en-zh', 'en-vi', 'vi-en', 'ja-en', 'ko-en']);
const TEXT_LIMITS: Record<string, number> = { translate: 6000, tts: 3000, grammar: 20000 };

/** Kokoro voices Fixlark offers, by language. The first is the default. */
export const VOICES: Record<string, string[]> = {
  en: ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_adam', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'],
  fr: ['ff_siwis'], es: ['ef_dora'], it: ['if_sara', 'im_nicola'], pt: ['pf_dora'], hi: ['hf_alpha'], ja: ['jf_alpha'], zh: ['zf_xiaobei'],
};
const voiceLanguage = (v: string) => Object.entries(VOICES).find(([, vs]) => vs.includes(v))?.[0];

/** What each English voice sounds like, for the planner and for the quote. */
export const VOICE_LABELS: Record<string, string> = {
  af_heart: 'American woman', af_bella: 'American woman', af_nicole: 'American woman', am_michael: 'American man', am_adam: 'American man',
  bf_emma: 'British woman', bf_isabella: 'British woman', bm_george: 'British man', bm_lewis: 'British man',
  ff_siwis: 'French', ef_dora: 'Spanish', if_sara: 'Italian woman', im_nicola: 'Italian man', pf_dora: 'Portuguese', hf_alpha: 'Hindi', jf_alpha: 'Japanese', zf_xiaobei: 'Mandarin',
};
const voiceGuide = VOICES.en!.map((v) => `${v} (${VOICE_LABELS[v]})`).join(', ');
const otherVoices = Object.entries(VOICES).filter(([l]) => l !== 'en').flatMap(([, vs]) => vs).map((v) => `${v} (${VOICE_LABELS[v]})`).join(', ');

const LANGS = ['en', 'vi', 'zh', 'ja', 'ko', 'fr', 'es', 'it', 'pt', 'hi', 'unknown'] as const;

const StepSchema = z.object({
  service: z.enum(['transcribe', 'tts', 'background', 'translate', 'grammar']),
  input: z.object({ from: z.enum(['input', 'step']), index: z.number().int().min(0).max(9) }),
  source: z.enum(LANGS).optional(),
  target: z.enum(LANGS).optional(),
  voice: z.string().max(20).optional(),
});

export const PlanSchema = z.object({
  can_do: z.boolean(),
  summary: z.string().max(300),
  input_languages: z.array(z.enum(LANGS)).max(3),
  steps: z.array(StepSchema).max(8),
});
export type ModelPlan = z.infer<typeof PlanSchema>;

export interface PlannedStep {
  index: number;
  service: ServiceId;
  title: string;
  input: { from: 'input' | 'step'; index: number };
  params: { source?: string; target?: string; voice?: string };
  produces: DataKind;
  language?: string;
  /** Estimated size used for pricing: minutes, chars or images. */
  quantity: number;
  cents: number;
  check: string;
}

export interface Quote {
  summary: string;
  steps: PlannedStep[];
  totalCents: number;
}

export type PlanOutcome =
  | { ok: true; quote: Quote }
  | { ok: false; reason: string; code: 'cannot_do' | 'invalid_plan' | 'model_error' };

const TASK_SPEC = `You plan jobs for Agent Desk, a shop that sells these AI services:
${Object.values(SERVICES).map((s) => `- ${s.id}: ${s.summary}`).join('\n')}

The buyer's request is inside <user_input>. A list of the buyer's attachments follows it (index, type, size).
Return a plan as JSON:
- can_do: false if the request needs anything other than these services (for example writing new text, summarising, editing photos beyond background removal, or a language pair that is not offered). Then explain briefly in summary and return no steps.
- summary: one plain sentence describing what will be delivered.
- input_languages: the language of each text or audio attachment, in order ("unknown" if you cannot tell). Transcription is English only.
- steps: in order. Each step reads one attachment ({"from": "input", "index": i}) or the output of an earlier step ({"from": "step", "index": j}).
  transcribe reads audio and gives English text. tts reads text and gives audio. background reads an image and gives an image. translate reads text and needs "source" and "target". grammar reads English text and gives suggestions.
For tts, if the buyer asked for a kind of voice, set "voice" to the closest id: ${voiceGuide}. For another language use: ${otherVoices}. If they did not ask, leave "voice" out.
Use the fewest steps that deliver exactly what was asked. Never add a service the buyer did not ask for.`;

export async function planRequest(llm: LLM, request: string, inputs: InputDesc[], onUsage?: (u: { in: number; out: number }) => void): Promise<PlanOutcome> {
  const canary = newCanary();
  const attachments = inputs.length
    ? inputs.map((x, i) => `${i}: ${x.kind}, ${x.kind === 'text' ? `${x.chars} characters${x.language ? `, written in ${x.language}` : ''}` : x.kind === 'audio' ? `about ${(x.minutes ?? 0).toFixed(1)} minutes` : 'one image'}`).join('\n')
    : '(none)';
  const result = await llm.json({
    model: config.llm.planner, name: 'plan', schema: PlanSchema, maxTokens: 2000, temperature: 0.1,
    system: scopedSystem(TASK_SPEC, canary),
    user: `${wrapUser(request)}\n\nAttachments:\n${attachments}`,
  });
  onUsage?.(result.usage);
  if (!result.ok || !result.value) {
    if (result.raw && !checkOutput(result.raw, canary)[0]) return { ok: false, code: 'cannot_do', reason: 'Agent Desk only plans jobs with its listed services.' };
    return { ok: false, code: 'model_error', reason: 'The planner could not produce a plan. Try rephrasing the request.' };
  }
  const plan = result.value;
  const [clean] = checkOutput(plan.summary, canary, { maxChars: 300 });
  if (!clean) return { ok: false, code: 'cannot_do', reason: 'Agent Desk only plans jobs with its listed services.' };
  if (!plan.can_do || plan.steps.length === 0) {
    return { ok: false, code: 'cannot_do', reason: safeLine(plan.summary) || 'That request needs something Agent Desk does not sell.' };
  }
  return validatePlan(plan, inputs);
}

/** Every rule a plan must pass before it is priced. Pure code; the model's plan is a proposal. */
export function validatePlan(plan: ModelPlan, inputs: InputDesc[]): PlanOutcome {
  const bad = (reason: string): PlanOutcome => ({ ok: false, code: 'invalid_plan', reason });
  if (plan.steps.length > config.limits.steps) return bad(`A job can have at most ${config.limits.steps} steps.`);

  const steps: PlannedStep[] = [];
  for (const [i, s] of plan.steps.entries()) {
    // What the step reads: its kind, language and size.
    let kind: DataKind; let lang: string | undefined; let size: number;
    if (s.input.from === 'input') {
      const inp = inputs[s.input.index];
      if (!inp) return bad(inputs.length
        ? `Step ${i + 1} reads attachment ${s.input.index + 1}, which does not exist.`
        : 'Nothing is attached for this job to work on. Add the text or file it should use: on the web, click "Attach text" or "Attach audio or image"; over MCP, pass it as text.');
      kind = inp.kind;
      lang = inp.language ?? plan.input_languages[s.input.index];
      size = inp.kind === 'text' ? inp.chars ?? 0 : inp.kind === 'audio' ? inp.minutes ?? 0 : 1;
    } else {
      const prev = steps[s.input.index];
      if (!prev || s.input.index >= i) return bad(`Step ${i + 1} reads a step that does not come before it.`);
      if (prev.service === 'grammar') return bad('The grammar check gives suggestions, not new text, so no step can read its output.');
      kind = prev.produces; lang = prev.language;
      size = prev.service === 'transcribe' ? Math.ceil(prev.quantity * 900) // ~150 words a minute
        : prev.service === 'translate' ? Math.ceil(prev.quantity * 1.3)
        : prev.service === 'tts' ? Math.max(0.1, prev.quantity / 900)
        : prev.quantity;
    }
    if (lang === 'unknown') lang = undefined;

    const need: Record<ServiceId, DataKind> = { transcribe: 'audio', tts: 'text', background: 'image', translate: 'text', grammar: 'text' };
    if (kind !== need[s.service]) return bad(`${SERVICES[s.service].title} needs ${need[s.service]}, but step ${i + 1} would get ${kind}.`);
    if (TEXT_LIMITS[s.service] && size > TEXT_LIMITS[s.service]!) return bad(`${SERVICES[s.service].title} takes at most ${TEXT_LIMITS[s.service]} characters.`);

    const params: PlannedStep['params'] = {};
    let produces: DataKind = kind; let outLang = lang;
    switch (s.service) {
      case 'transcribe':
        if (lang && lang !== 'en') return bad('Transcription is English only for now.');
        produces = 'text'; outLang = 'en';
        break;
      case 'tts': {
        const want = s.voice && voiceLanguage(s.voice) ? s.voice : undefined;
        const l = lang ?? (want ? voiceLanguage(want) : 'en');
        if (!l || !VOICES[l]) return bad(`Text to speech cannot read ${l === 'vi' ? 'Vietnamese' : l === 'ko' ? 'Korean' : 'that language'} yet.`);
        params.voice = want && voiceLanguage(want) === l ? want : VOICES[l]![0]!;
        produces = 'audio'; outLang = l;
        break;
      }
      case 'translate': {
        const src = lang ?? s.source; const tgt = s.target;
        if (!src || !tgt || src === 'unknown' || tgt === 'unknown') return bad('Translation needs a source and a target language.');
        if (!TRANSLATE_PAIRS.has(`${src}-${tgt}`)) return bad(`Translation from ${src} to ${tgt} is not offered.`);
        params.source = src; params.target = tgt;
        outLang = tgt;
        break;
      }
      case 'grammar':
        if (lang && lang !== 'en') return bad('The grammar check is for English text.');
        break;
      case 'background':
        break;
    }
    const quantity = s.service === 'background' ? 1 : Math.max(size, s.service === 'transcribe' ? 0.1 : 1);
    steps.push({
      index: i, service: s.service, title: s.service === 'tts' && params.voice ? `${SERVICES.tts.title} (${VOICE_LABELS[params.voice]})` : SERVICES[s.service].title, input: s.input, params,
      produces, language: outLang, quantity, cents: priceCents(s.service, quantity), check: SERVICES[s.service].check,
    });
  }
  return { ok: true, quote: { summary: safeLine(plan.summary, 300), steps, totalCents: steps.reduce((a, s) => a + s.cents, 0) } };
}
