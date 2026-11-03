import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/server/mentions.ts';

const members = [
  { id: 1, login: 'ann' },
  { id: 2, login: 'ann_' },
  { id: 3, login: 'jan.kowalski@gmail.com' },
  { id: 4, login: 'a@b.com' },
];
const ids = (s: string) => parseMentions(s, members, []).userIds;

describe('parseMentions', () => {
  it('plain login', () => expect(ids('hi @ann')).toEqual([1]));
  it('trailing dot is punctuation', () => expect(ids('hi @ann.')).toEqual([1]));
  it('login with underscore then dot', () => expect(ids('hi @ann_.')).toEqual([2]));
  it('email login with trailing comma', () => expect(ids('hi @jan.kowalski@gmail.com,')).toEqual([3]));
  it('email address is not a mention', () => expect(ids('email a@b.com')).toEqual([]));
  it('in parentheses', () => expect(ids('(@ann)')).toEqual([1]));
});
