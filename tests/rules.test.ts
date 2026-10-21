import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { doneNotesWarning, extractIssueRefs, parseChangeNoteComment, parseIdentifier, sortBetween } from '../src/server/rules.ts';
import { verifyGithubSignature } from '../src/server/hooks.ts';

describe('doneNotesWarning', () => {
  it('warns about Done without both notes', () => {
    expect(doneNotesWarning('completed', { changeHuman: '', changeAi: '' })).toMatch(/HUMAN and AI/);
    expect(doneNotesWarning('completed', { changeHuman: 'x', changeAi: ' ' })).toMatch(/AI/);
  });
  it('allows Done with notes and other statuses without', () => {
    expect(doneNotesWarning('completed', { changeHuman: 'x', changeAi: 'y' })).toBeNull();
    expect(doneNotesWarning('canceled', { changeHuman: '', changeAi: '' })).toBeNull();
    expect(doneNotesWarning('duplicate', { changeHuman: '', changeAi: '' })).toBeNull();
    expect(doneNotesWarning('started', { changeHuman: '', changeAi: '' })).toBeNull();
  });
});

describe('identifiers', () => {
  it('parses ids of any project, bare numbers without a key', () => {
    expect(parseIdentifier('ACME-12')).toEqual({ key: 'ACME', number: 12 });
    expect(parseIdentifier('acme-7')).toEqual({ key: 'ACME', number: 7 });
    expect(parseIdentifier('WEB-3')).toEqual({ key: 'WEB', number: 3 });
    expect(parseIdentifier('15')).toEqual({ key: null, number: 15 });
    expect(parseIdentifier('A-1')).toBeNull();
    expect(parseIdentifier('ACME-0')).toBeNull();
  });
  it('extracts issue refs of known projects from commit messages', () => {
    expect(extractIssueRefs('fix(ACME-12): x\n\nRefs acme-30, ACME-12, WEB-2, ABC-4', ['ACME', 'WEB']))
      .toEqual([{ key: 'ACME', number: 12 }, { key: 'ACME', number: 30 }, { key: 'WEB', number: 2 }]);
    expect(extractIssueRefs('XACME-1 nothing', ['ACME'])).toEqual([]);
  });
});

describe('parseChangeNoteComment', () => {
  it('maps the old close-linear-ticket comments', () => {
    expect(parseChangeNoteComment('**HUMAN**\n\nDodano coś.\nUsunięto coś.')).toEqual({ kind: 'human', text: 'Dodano coś.\nUsunięto coś.' });
    expect(parseChangeNoteComment('**AI**\n\n## Kontekst\nabc')).toEqual({ kind: 'ai', text: '## Kontekst\nabc' });
    expect(parseChangeNoteComment('Komentarz Claude: **AI**')).toBeNull();
    expect(parseChangeNoteComment('**HUMAN**\n\n')).toBeNull();
  });
});

describe('sortBetween', () => {
  it('places between neighbours', () => {
    expect(sortBetween(1, 2)).toBe(1.5);
    expect(sortBetween(null, 2)).toBe(1);
    expect(sortBetween(5, null)).toBe(6);
  });
});

describe('github signature', () => {
  it('verifies HMAC', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyGithubSignature('s3cret', body, sig)).toBe(true);
    expect(verifyGithubSignature('other', body, sig)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, undefined)).toBe(false);
  });
});
