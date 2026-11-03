import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TAG_COLORS, api, useMe, useMeta, type TagColor } from './api.ts';
import { Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { useCurrentProject } from './ProjectSwitcher.tsx';
import { tn, t } from './i18n.ts';

/** Ustawienia › Ty › Profil i tagi: moje tagi w bieżącym projekcie (wspólne dla projektu, bez właściciela). */
export function ProfileTags() {
  const qc = useQueryClient();
  const meta = useMeta().data;
  const me = useMe().data;
  const projectName = useCurrentProject()?.name;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  // Kolor: otwarty wybór dla istniejącego taga (zmiana) albo dla nowego (tworzenie).
  const [colorFor, setColorFor] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  if (!meta || !me) return null;
  const tags = meta.tags ?? [];
  const mine = tags.filter((x) => x.memberIds.includes(me.id));
  const typed = name.trim().replace(/^#/, '').toLowerCase();
  const exact = tags.find((x) => x.name.toLowerCase() === typed);
  const matches = tags.filter((x) => !x.memberIds.includes(me.id) && x.name.toLowerCase().includes(typed)).slice(0, 6);

  const refresh = () => qc.invalidateQueries({ queryKey: ['meta'] });
  // Błąd z serwera (np. zła nazwa) pokazujemy przy polu, nie jako toast.
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await refresh(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const setMine = (ids: number[]) => run(() => api('/api/me/tags', { method: 'PUT', body: { tagIds: ids } }));
  const close = () => { setAdding(false); setName(''); setColorFor(null); };
  const join = async (id: number) => { if (await setMine([...mine.map((x) => x.id), id])) close(); };
  const create = async (color: TagColor) => { if (await run(() => api('/api/tags', { method: 'POST', body: { name: typed, color } }))) close(); };
  const recolor = async (id: number, color: TagColor) => { if (await run(() => api(`/api/tags/${id}`, { method: 'PATCH', body: { color } }))) setColorFor(null); };

  const swatches = (current: TagColor | null, pick: (c: TagColor) => void) => (
    <div className="tag-swatches" role="radiogroup" aria-label={t('Tag color')}>
      {TAG_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === current} aria-label={c} title={c}
          className={`tag-swatch${c === current ? ' on' : ''}`} style={{ '--tag': `var(--tag-${c})` } as React.CSSProperties} onClick={() => pick(c)} />
      ))}
    </div>
  );

  return (
    <div className="s-card" id="my-tags">
      <div className="s-row s-row-head">
        <Tooltip text={t('People get notified when someone writes #tag. Your tags show on your person card.')}>
          <b>{t('My tags in {project}', { project: projectName ?? '' })}</b>
        </Tooltip>
      </div>
      <div className="s-row tag-row">
        {mine.map((x) => (
          <span key={x.id} className="tag-chip" style={{ '--tag': `var(--tag-${x.color})` } as React.CSSProperties}>
            <button type="button" className="tag-chip-dot" aria-label={t('Change color')} title={t('Change color')}
              onClick={() => setColorFor(colorFor === x.id ? null : x.id)}><span className="dot" /></button>
            #{x.name}
            <button type="button" className="tag-chip-x" aria-label={t('Remove')} title={`${tn(x.memberIds.length, '{n} person', '{n} people')}`}
              onClick={() => void setMine(mine.filter((y) => y.id !== x.id).map((y) => y.id))}><Icon.close size={10} /></button>
          </span>
        ))}
        {!adding && <button className="btn sm" onClick={() => setAdding(true)}><Icon.plus size={13} /> {t('Tag')}</button>}
      </div>
      {mine.filter((x) => x.id === colorFor).map((x) => (
        <div key={x.id} className="s-row">{swatches(x.color, (c) => void recolor(x.id, c))}</div>
      ))}
      {adding && (
        <div className="s-row tag-add">
          <div className="tag-add-line">
            <input className="input" autoFocus placeholder="#tag" aria-label={t('Tag')} value={name}
              onChange={(e) => { setName(e.target.value); setError(''); setColorFor(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); close(); }
                else if (e.key === 'Enter') { e.preventDefault(); if (exact) { if (!exact.memberIds.includes(me.id)) void join(exact.id); } else if (typed) setColorFor('new'); }
              }} />
            <button className="btn sm" onClick={close}>{t('Cancel')}</button>
          </div>
          <div className="tag-options">
            {matches.map((x) => (
              <button key={x.id} type="button" className="tag-option" style={{ '--tag': `var(--tag-${x.color})` } as React.CSSProperties} onClick={() => void join(x.id)}>
                <span className="dot" />#{x.name}<span className="hint">{tn(x.memberIds.length, '{n} person', '{n} people')}</span>
              </button>
            ))}
            {typed && !exact && (
              <button type="button" className="tag-option create" onClick={() => setColorFor('new')}><Icon.plus size={12} /> {t('Create #{name}', { name: typed })}</button>
            )}
          </div>
          {colorFor === 'new' && typed && !exact && swatches(null, (c) => void create(c))}
        </div>
      )}
      {error && <div className="s-row"><span className="tag-error">{error}</span></div>}
    </div>
  );
}
