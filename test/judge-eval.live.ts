/**
 * How well does the translation inspector catch real errors? Labelled en->vi
 * pairs, real back-translations from Fixlark, real Nemotron, run twice.
 *   node --env-file=.env --import tsx test/judge-eval.live.ts
 *
 * Nov 9 results, pass mark 4/5:
 *   old prompt, no reasoning:      10/12  (passed "table for four" as "table 4" at 5/5)
 *   current prompt, no reasoning:  11/12  (still passed it, at 4/5)
 *   current prompt, reasoning:     12/12 and 11/12 (caught it both times; never failed a good one)
 * This is a small sample and a model's judgement: it improves the odds, it is no guarantee.
 */
import { judge } from '../src/judge/judge.ts';
import { OpenAICompatible } from '../src/llm/client.ts';
import { Fixlark } from '../src/fixlark/client.ts';
import type { PlannedStep } from '../src/planner.ts';

const set: [boolean, string, string][] = [
  [false, 'Seats for six at the bar are ready.', 'Ghế số 6 ở quầy bar đã sẵn sàng.'],
  [false, 'Return the key to the front desk.', 'Trả lại chìa khóa cho cái bàn phía trước.'],
  [false, 'The discount is 15%, not 50%.', 'Mức giảm giá là 50%, không phải 15%.'],
  [false, 'Do not take this medicine with milk.', 'Hãy uống thuốc này với sữa.'],
  [false, 'Your flight leaves at 6 pm.', 'Chuyến bay của bạn khởi hành lúc 6 giờ sáng.'],
  [false, 'Your table for four is confirmed for Saturday at seven.', 'Bàn 4 của anh đã được xác nhận vào thứ Bảy lúc 7 giờ.'],
  [true, 'Seats for six at the bar are ready.', 'Chỗ ngồi cho sáu người ở quầy bar đã sẵn sàng.'],
  [true, 'Return the key to the front desk.', 'Vui lòng trả chìa khóa cho quầy lễ tân.'],
  [true, 'The discount is 15%, not 50%.', 'Mức giảm giá là 15%, không phải 50%.'],
  [true, 'Do not take this medicine with milk.', 'Không uống thuốc này với sữa.'],
  [true, 'Your flight leaves at 6 pm.', 'Chuyến bay của bạn khởi hành lúc 6 giờ chiều.'],
  [true, 'Your table for four is confirmed for Saturday at seven.', 'Bàn cho bốn người của quý khách đã được xác nhận vào lúc bảy giờ thứ Bảy.'],
];

const step = { index: 0, service: 'translate', title: 'Translate', input: { from: 'input', index: 0 }, params: { source: 'en', target: 'vi' }, produces: 'text', quantity: 1, cents: 5, check: '' } as PlannedStep;
const deps = { llm: new OpenAICompatible(), fixlark: new Fixlark() };
let right = 0;
for (const [good, src, out] of set) {
  const v = await judge(step, { kind: 'text', text: src }, { kind: 'text', text: out }, deps);
  const ok = v.pass === good;
  if (ok) right++;
  console.log(`${ok ? 'ok  ' : 'MISS'} want ${good ? 'pass' : 'fail'} score ${v.score ?? '-'}  ${out.slice(0, 50)}`);
}
console.log(`${right}/${set.length}`);
process.exitCode = right === set.length ? 0 : 1;
