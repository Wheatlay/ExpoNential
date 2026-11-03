import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMeta } from './api.ts';
import { Avatar } from './icons.tsx';
import { t, tn } from './i18n.ts';

// Bez polskich znaków i wielkości liter: "lukasz" znajdzie "Łukasz".
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'l').toLowerCase();
const WORD = /(^|\s)([@#])([\w.-]*)$/;
const MAX = 6;

type Option = { key: string; insert: string; node: React.ReactNode };

/**
 * Podpowiedzi @osoba i #tag pod polem tekstowym. Wołający wywołuje onKeyDown PIERWSZY i pomija własną obsługę,
 * gdy e.defaultPrevented (Enter wybiera pozycję zamiast wysyłać komentarz).
 */
export function useMentionAutocomplete(ref: RefObject<HTMLTextAreaElement | null>, value: string, setValue: (v: string) => void) {
  const meta = useMeta().data;
  const [hl, setHl] = useState(0);
  // Escape zamyka podpowiedź dla tego fragmentu; kolejny znak (inny fragment) otwiera ją znowu.
  const [closedFor, setClosedFor] = useState<string | null>(null);

  const el = ref.current;
  const focused = !!el && document.activeElement === el;
  const caret = focused ? el.selectionStart : 0;
  const m = focused ? WORD.exec(value.slice(0, caret)) : null;
  const sign = m?.[2];
  const q = m?.[3] ?? '';
  const start = m ? caret - (sign!.length + q.length) : 0;
  const fragment = m ? `${start}:${sign}${q}` : null;

  let options: Option[] = [];
  if (m && meta && closedFor !== fragment) {
    const pq = plain(q);
    if (sign === '@') {
      options = meta.users.filter((u) => u.active && (plain(u.name).includes(pq) || plain(u.login).includes(pq))).slice(0, MAX).map((u) => ({
        key: `u${u.id}`, insert: `@${u.login} `,
        node: <><Avatar user={u} size={18} /><span>{u.name}</span><span className="mp-muted">@{u.login}</span></>,
      }));
    } else {
      options = (meta.tags ?? []).filter((x) => plain(x.name).includes(pq)).slice(0, MAX).map((x) => ({
        key: `t${x.id}`, insert: `#${x.name} `,
        node: <><span className="tag-dot" style={{ '--tag': `var(--tag-${x.color})` } as React.CSSProperties} /><span>#{x.name}</span><span className="mp-muted">{tn(x.memberIds.length, '{n} person', '{n} people')}</span></>,
      }));
    }
  }
  const open = options.length > 0;
  const cur = Math.min(hl, Math.max(0, options.length - 1));
  useEffect(() => setHl(0), [fragment]);

  const choose = (o: Option) => {
    const node = ref.current;
    if (!node) return;
    const pos = node.selectionStart;
    setValue(value.slice(0, start) + o.insert + value.slice(pos));
    requestAnimationFrame(() => { node.focus(); node.selectionStart = node.selectionEnd = start + o.insert.length; });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((cur + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((cur - 1 + options.length) % options.length); }
    else if ((e.key === 'Enter' && !e.altKey && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); choose(options[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); setClosedFor(fragment); }
  };

  let popup: React.ReactNode = null;
  if (open && el) {
    const r = el.getBoundingClientRect();
    const below = r.bottom + 8 + options.length * 36 < window.innerHeight;
    const style: React.CSSProperties = { left: Math.max(8, Math.min(r.left, window.innerWidth - 320)), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) };
    popup = createPortal(
      // mousedown nie zabiera fokusu polu, więc wybór myszą nie gubi kursora.
      <div className="popover mention-pop" style={style} role="listbox" aria-label={sign === '@' ? t('People') : t('Tags')} onMouseDown={(e) => e.preventDefault()}>
        {options.map((o, i) => (
          <button key={o.key} type="button" role="option" aria-selected={i === cur} className={`menu-item ${i === cur ? 'hl' : ''}`}
            onMouseEnter={() => setHl(i)} onClick={() => choose(o)}>{o.node}</button>
        ))}
      </div>,
      document.body,
    );
  }
  return { onKeyDown, popup };
}
