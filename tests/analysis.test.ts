/**
 * analysis.ts: limity wejścia, przenoszenie wyborów między analizami (fromInput/remap) i markdown (render).
 */
import { describe, expect, it } from 'vitest';
import { analysisInputSchema, fromInput, parseData, render, type AnalysisData } from '../src/server/analysis.ts';

const opts = (...labels: string[]) => labels.map((label) => ({ label, desc: '' }));
const input = (decisions: { question: string; options: { label: string; desc?: string; recommended?: boolean }[] }[], sections: Record<string, string> = { verdict: 'Yes' }) =>
  analysisInputSchema.parse({ type: 'bug', sections, decisions: decisions.map((d) => ({ ...d, options: d.options.map((o) => ({ desc: '', ...o })) })) });

describe('analysisInputSchema', () => {
  it('allows 4000 characters per section and rejects more', () => {
    expect(analysisInputSchema.safeParse({ type: 'bug', sections: { verdict: 'a'.repeat(4000) } }).success).toBe(true);
    expect(analysisInputSchema.safeParse({ type: 'bug', sections: { verdict: 'a'.repeat(4001) } }).success).toBe(false);
  });
  it('needs at least one section and at most one recommended option', () => {
    expect(analysisInputSchema.safeParse({ type: 'bug', sections: {} }).success).toBe(false);
    const two = { question: 'Q?', options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] };
    expect(analysisInputSchema.safeParse({ type: 'bug', sections: { verdict: 'x' }, decisions: [two] }).success).toBe(false);
  });
});

describe('fromInput', () => {
  const prev: AnalysisData = {
    type: 'bug', sections: { verdict: 'old' },
    decisions: [
      { question: 'Which way?', options: opts('Left', 'Right'), choice: { option: 1, other: '', by: 'Ann', at: 'then' } },
      { question: 'Custom?', options: opts('X', 'Y'), choice: { option: null, other: 'my own', by: 'Ann', at: 'then' } },
    ],
  };

  it('keeps the choice by option label even when the options move', () => {
    const a = fromInput(input([{ question: ' which WAY? ', options: opts('Middle', 'Right', 'Left') }]), prev);
    expect(a.decisions[0].choice).toMatchObject({ option: 1, by: 'Ann' });
  });
  it('drops the choice when the chosen option label is gone', () => {
    const a = fromInput(input([{ question: 'Which way?', options: opts('Left', 'Up') }]), prev);
    expect(a.decisions[0].choice).toBeUndefined();
  });
  it('keeps a custom answer and drops choices of questions that changed', () => {
    const a = fromInput(input([{ question: 'Custom?', options: opts('P', 'Q') }, { question: 'Brand new?', options: opts('A', 'B') }]), prev);
    expect(a.decisions[0].choice).toMatchObject({ option: null, other: 'my own' });
    expect(a.decisions[1].choice).toBeUndefined();
  });
  it('works without a previous analysis and only copies filled sections', () => {
    const a = fromInput(input([], { verdict: 'v', risk: 'r' }), null);
    expect(a.sections).toEqual({ verdict: 'v', risk: 'r' });
    expect(a.decisions).toEqual([]);
  });
});

describe('render', () => {
  it('writes type, sections in fixed order and the decided option', () => {
    const md = render({
      type: 'feature', sections: { risk: 'R', current: 'C' },
      decisions: [{ question: 'Q?', options: [{ label: 'A', desc: 'da', recommended: true }, { label: 'B', desc: 'db' }], choice: { option: 0, other: '', by: 'Ann', at: 'x' } }],
    });
    expect(md.indexOf('Current state')).toBeLessThan(md.indexOf('Watch out for'));
    expect(md).toContain('Decided: A');
    expect(md).toContain('(Ann)');
    expect(md).toContain('- **A (recommended):** da ✓');
    expect(md).toContain('- **B:** db');
  });
  it('parseData accepts only objects with a type', () => {
    expect(parseData(null)).toBeNull();
    expect(parseData({ nope: 1 })).toBeNull();
    expect(parseData({ type: 'bug', sections: {}, decisions: [] })).not.toBeNull();
  });
});
