import { useState, useSyncExternalStore } from 'react';
import { useMeta, useUpdateIssue, type IssuePatch, type Meta, type Status } from './api.ts';
import { Icon } from './icons.tsx';
import { enterToSubmit } from './keys.ts';
import { ident } from './project.ts';
import { openInClaude } from './startWork.ts';
import { t } from './i18n.ts';

/**
 * Przejście do Done z brakami (bez notatek HUMAN/AI albo z pominięciem Testing): zamiast samego
 * powiadomienia okno, które mówi, co jest nie tak, i pozwala to poprawić od razu albo świadomie zaakceptować.
 */
type Guard = { number: number; statusId: number; extra?: IssuePatch; missingNotes: boolean; skippedTesting: boolean };
let current: Guard | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());
function close() { current = null; emit(); }

export type GuardTarget = { number: number; statusId: number; hasChangeNotes: boolean; wasTested?: boolean };

/** Zwraca true, gdy okno zostało otwarte (wtedy wywołujący nie zmienia statusu sam). */
export function guardDone(meta: Meta, to: Status, t: GuardTarget, extra?: IssuePatch): boolean {
  if (to.type !== 'completed' || t.number <= 0 || t.statusId === to.id) return false;
  const from = meta.statuses.find((s) => s.id === t.statusId);
  const missingNotes = !t.hasChangeNotes;
  const skippedTesting = t.wasTested === false && from?.role !== 'testing';
  if (!missingNotes && !skippedTesting) return false;
  current = { number: t.number, statusId: to.id, extra, missingNotes, skippedTesting };
  emit();
  return true;
}

export function DoneGuardHost() {
  const g = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => current);
  return g ? <DoneGuardModal g={g} /> : null;
}

function DoneGuardModal({ g }: { g: Guard }) {
  const meta = useMeta().data;
  const update = useUpdateIssue();
  const [human, setHuman] = useState('');
  const [ai, setAi] = useState('');
  if (!meta) return null;
  const testing = meta.statuses.find((s) => s.type === 'started' && /test/i.test(s.name));
  const filled = !!human.trim() && !!ai.trim();
  const done = () => {
    update.mutate({ number: g.number, patch: { ...g.extra, statusId: g.statusId, ...(human.trim() ? { changeHuman: human } : {}), ...(ai.trim() ? { changeAi: ai } : {}) } });
    close();
  };
  const toTesting = () => {
    if (!testing) return;
    update.mutate({ number: g.number, patch: { ...g.extra, statusId: testing.id, ...(human.trim() ? { changeHuman: human } : {}), ...(ai.trim() ? { changeAi: ai } : {}) } });
    close();
  };
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal guard" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="guard-head">
          <span className="guard-icon"><Icon.question size={18} /></span>
          <div>
            <div className="guard-title">{t('Move {id} to Done?', { id: ident(g.number) })}</div>
            <div className="hint">{t('Something is missing. Fix it here or move it anyway.')}</div>
          </div>
        </div>
        {g.skippedTesting && (
          <div className="guard-item">
            <b>{t('It never went through Testing.')}</b>
            <span className="hint">{t('Nobody checked it on the test server yet.')}</span>
          </div>
        )}
        {g.missingNotes && (
          <div className="guard-item">
            <b>{t('No change notes.')}</b>
            <span className="hint">{t('HUMAN says what changed for people, AI describes the changes for the next agent. Usually written by Claude with close-ticket.')}</span>
            <button className="btn sm ai-btn" style={{ alignSelf: 'flex-start' }} onClick={() => { void openInClaude(g.number, 'close'); close(); }}
              title={t('Opens Claude Code in VS Code with the close prompt; move it to Done once the notes are in')}>
              <Icon.sparkle size={13} /> {t('Close in Claude')}
            </button>
            <label className="guard-field"><span className="badge human">HUMAN</span>
              <textarea placeholder={t('One change per line (Alt+Enter new line)')} value={human} onChange={(e) => setHuman(e.target.value)}
                onKeyDown={(e) => enterToSubmit(e, done, setHuman)} />
            </label>
            <label className="guard-field"><span className="badge tech">TECH</span>
              <textarea placeholder={t('Commits, files, reasons, verification')} value={ai} onChange={(e) => setAi(e.target.value)}
                onKeyDown={(e) => enterToSubmit(e, done, setAi)} />
            </label>
          </div>
        )}
        <div className="foot">
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <span className="spacer" />
          {g.skippedTesting && testing && <button className="btn" onClick={toTesting}>{t('Move to {name} instead', { name: testing.name })}</button>}
          <button className={`btn ${filled || !g.missingNotes ? 'primary' : 'warn'}`} onClick={done}>
            {g.missingNotes && filled ? t('Save notes and move to Done') : t('Move to Done anyway')}
          </button>
        </div>
      </div>
    </div>
  );
}
