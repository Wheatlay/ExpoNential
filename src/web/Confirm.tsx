import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useModal } from './modal.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

/**
 * Potwierdzenie w stylu aplikacji zamiast systemowego confirm(). askConfirm zwraca Promise<boolean>;
 * Enter potwierdza, Escape i klik w tło anulują. `type`: potwierdzenie wymaga wpisania tego tekstu (np. loginu przy usuwaniu konta).
 */
type Ask = { title: string; body?: string; action: string; danger: boolean; type?: string; resolve: (ok: boolean) => void };
let current: Ask | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function askConfirm(opts: { title: string; body?: string; action?: string; danger?: boolean; type?: string }): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { title: opts.title, body: opts.body, action: opts.action ?? t('Delete'), danger: opts.danger ?? true, type: opts.type, resolve };
    emit();
  });
}

function answer(ok: boolean) {
  current?.resolve(ok);
  current = null;
  emit();
}

export function ConfirmHost() {
  const a = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => current);
  const ok = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const modalRef = useModal();
  useEffect(() => { setTyped(''); (field.current ?? ok.current)?.focus(); }, [a]);
  if (!a) return null;
  const blocked = a.type !== undefined && typed.trim() !== a.type;
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false); }}>
      <div className="modal guard confirm" role="alertdialog" aria-modal="true" aria-label={a.title} ref={modalRef} tabIndex={-1}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') answer(false); }}>
        <div className="guard-head">
          <span className={`guard-icon ${a.danger ? 'danger' : ''}`}>{a.danger ? <Icon.trash size={18} /> : <Icon.question size={18} />}</span>
          <div>
            <div className="guard-title">{a.title}</div>
            {a.body && <div className="hint">{a.body}</div>}
          </div>
        </div>
        {a.type !== undefined && (
          <input ref={field} className="input" value={typed} placeholder={a.type} aria-label={a.type} autoComplete="off"
            onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !blocked) answer(true); }} />
        )}
        <div className="foot">
          <span className="spacer" />
          <button className="btn" onClick={() => answer(false)}>{t('Cancel')}</button>
          <button ref={ok} className={`btn ${a.danger ? 'danger' : 'primary'}`} disabled={blocked} onClick={() => answer(true)}>{a.action}</button>
        </div>
      </div>
    </div>
  );
}
