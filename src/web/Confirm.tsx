import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

/**
 * Potwierdzenie w stylu aplikacji zamiast systemowego confirm(). askConfirm zwraca Promise<boolean>;
 * Enter potwierdza, Escape i klik w tło anulują.
 */
type Ask = { title: string; body?: string; action: string; danger: boolean; resolve: (ok: boolean) => void };
let current: Ask | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function askConfirm(opts: { title: string; body?: string; action?: string; danger?: boolean }): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { title: opts.title, body: opts.body, action: opts.action ?? t('Delete'), danger: opts.danger ?? true, resolve };
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
  useEffect(() => { ok.current?.focus(); }, [a]);
  if (!a) return null;
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false); }}>
      <div className="modal guard confirm" role="alertdialog" aria-label={a.title}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') answer(false); }}>
        <div className="guard-head">
          <span className={`guard-icon ${a.danger ? 'danger' : ''}`}>{a.danger ? <Icon.trash size={18} /> : <Icon.question size={18} />}</span>
          <div>
            <div className="guard-title">{a.title}</div>
            {a.body && <div className="hint">{a.body}</div>}
          </div>
        </div>
        <div className="foot">
          <span className="spacer" />
          <button className="btn" onClick={() => answer(false)}>{t('Cancel')}</button>
          <button ref={ok} className={`btn ${a.danger ? 'danger' : 'primary'}`} onClick={() => answer(true)}>{a.action}</button>
        </div>
      </div>
    </div>
  );
}
