import { Fragment, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TAG_COLORS, api, useMe, useMeta, type Tag, type TagColor } from './api.ts';
import { askConfirm } from './Confirm.tsx';
import { Avatar, Icon } from './icons.tsx';
import { Tooltip, openMenu, type MenuSpec } from './menu.tsx';
import { Swatches } from './Swatches.tsx';
import { t, tn } from './i18n.ts';

const MAX_AVATARS = 6;
const tagVar = (c: TagColor) => ({ '--tag': `var(--tag-${c})` }) as React.CSSProperties;

/** Ustawienia › Projekt › Tagi: wspólne tagi osób (#tag) projektu; każdy członek tworzy, zmienia i dołącza, usuwa admin albo twórca. */
export function ProjectTags() {
  const qc = useQueryClient();
  const meta = useMeta().data;
  const me = useMe().data;
  // Otwarty wybór koloru dla istniejącego taga, edycja nazwy, dodawanie nowego.
  const [colorFor, setColorFor] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('green');
  const [error, setError] = useState('');
  // Escape zamyka pole nazwy, a blur po nim nie może zapisać.
  const cancelled = useRef(false);
  if (!meta || !me) return null;
  const tags = [...(meta.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const mine = tags.filter((x) => x.memberIds.includes(me.id)).map((x) => x.id);
  const isProjectAdmin = me.isAdmin || meta.users.find((u) => u.id === me.id)?.role === 'admin';
  const norm = (v: string) => v.trim().replace(/^#/, '').toLowerCase();

  // Błąd z serwera (już przetłumaczony przez api()) pokazujemy w ramce, nie jako toast.
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await qc.invalidateQueries({ queryKey: ['meta'] }); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const patch = (id: number, body: { name?: string; color?: TagColor }) => run(() => api(`/api/tags/${id}`, { method: 'PATCH', body }));
  const toggle = (x: Tag) => run(() => api('/api/me/tags', { method: 'PUT', body: { tagIds: mine.includes(x.id) ? mine.filter((id) => id !== x.id) : [...mine, x.id] } }));
  const remove = async (x: Tag) => {
    const ok = await askConfirm({ title: t('Delete #{name}?', { name: x.name }), body: t('Nobody will be notified by #{name} anymore.', { name: x.name }), action: t('Delete') });
    if (ok) await run(() => api(`/api/tags/${x.id}`, { method: 'DELETE' }));
  };
  // Admin projektu dodaje i usuwa członków dowolnego taga; ptaszki odświeżają się od razu, zapis idzie w tle.
  const membersMenu = (x: Tag): MenuSpec => {
    const build = (ids: number[]): MenuSpec => ({
      searchable: true, placeholder: t('Add or remove people…'),
      items: meta.users.filter((u) => u.active).map((u) => ({
        key: `u${u.id}`, label: u.name, icon: <Avatar user={u} size={16} />, checked: ids.includes(u.id), keepOpen: true,
        onSelect: () => {
          const has = ids.includes(u.id);
          void run(() => has ? api(`/api/tags/${x.id}/members/${u.id}`, { method: 'DELETE' }) : api(`/api/tags/${x.id}/members`, { method: 'POST', body: { userId: u.id } }));
          return build(has ? ids.filter((i) => i !== u.id) : [...ids, u.id]);
        },
      })),
    });
    return build(x.memberIds);
  };
  const commitName = async (x: Tag) => {
    if (cancelled.current || !editing) return;
    const next = norm(editing.value);
    if (!next || next === x.name) { setEditing(null); return; }
    if (await patch(x.id, { name: next })) setEditing(null);
  };
  const closeAdd = () => { setAdding(false); setName(''); setColor('green'); setError(''); };
  const create = async () => {
    const next = norm(name);
    if (next && await run(() => api('/api/tags', { method: 'POST', body: { name: next, color } }))) closeAdd();
  };

  const swatches = (current: TagColor | null, pick: (c: TagColor) => void) => (
    <Swatches value={current} tagColors={TAG_COLORS} label={t('Tag color')} onChange={(c) => pick(c as TagColor)} />
  );

  return (
    <div className="s-card" id="project-tags">
      <div className="s-row s-row-head">
        <Tooltip text={t('People get notified when someone writes #tag. Anyone in the project can create and join tags.')}>
          <b>{t('Tags')}</b>
        </Tooltip>
      </div>
      {tags.map((x) => {
        const members = x.memberIds.map((id) => meta.users.find((u) => u.id === id)).filter((u) => !!u);
        const joined = mine.includes(x.id);
        const canDelete = isProjectAdmin || x.createdBy === me.id;
        return (
          <Fragment key={x.id}>
            <div className="s-row">
              <button type="button" className="tag-chip-dot" style={tagVar(x.color)} aria-label={t('Change color')} title={t('Change color')}
                onClick={() => setColorFor(colorFor === x.id ? null : x.id)}><span className="tag-dot" /></button>
              {editing?.id === x.id ? (
                <input className="input tag-name-input" autoFocus aria-label={t('Tag')} value={editing.value}
                  onChange={(e) => { setEditing({ id: x.id, value: e.target.value }); setError(''); }}
                  onFocus={() => { cancelled.current = false; }}
                  onBlur={() => void commitName(x)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setEditing(null); setError(''); }
                    else if (e.key === 'Enter') { e.preventDefault(); void commitName(x); }
                  }} />
              ) : (
                <button type="button" className="pill tag-pill" style={tagVar(x.color)} title={t('Rename')}
                  onClick={() => { cancelled.current = false; setEditing({ id: x.id, value: x.name }); setError(''); }}>#{x.name}</button>
              )}
              <span className="grow tag-members" title={tn(x.memberIds.length, '{n} person', '{n} people')}>
                {members.slice(0, MAX_AVATARS).map((u) => <span key={u.id} title={u.name}><Avatar user={u} size={20} /></span>)}
                {members.length > MAX_AVATARS && <span className="hint">+{members.length - MAX_AVATARS}</span>}
              </span>
              {isProjectAdmin && <button className="icon-btn" aria-label={t('Edit members')} title={t('Edit members')} onClick={(e) => openMenu(e.currentTarget, membersMenu(x))}><Icon.user size={14} /></button>}
              <button className="btn sm" onClick={() => void toggle(x)}>{joined ? t('Leave') : t('Join')}</button>
              <Tooltip text={canDelete ? null : t('Only the tag creator or a project admin can delete a tag')}>
                <button className="icon-btn" disabled={!canDelete} aria-label={t('Delete tag')} title={canDelete ? t('Delete tag') : undefined} onClick={() => void remove(x)}>
                  <Icon.trash size={14} />
                </button>
              </Tooltip>
            </div>
            {colorFor === x.id && (
              <div className="s-row">{swatches(x.color, (c) => { void patch(x.id, { color: c }).then((ok) => { if (ok) setColorFor(null); }); })}</div>
            )}
          </Fragment>
        );
      })}
      {adding ? (
        <div className="s-row tag-add">
          <div className="tag-add-line">
            <input className="input" autoFocus placeholder="#tag" aria-label={t('Tag')} value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); closeAdd(); }
                else if (e.key === 'Enter') { e.preventDefault(); void create(); }
              }} />
            <button className="btn sm primary" disabled={!norm(name)} onClick={() => void create()}>{t('Create')}</button>
            <button className="btn sm" onClick={closeAdd}>{t('Cancel')}</button>
          </div>
          {swatches(color, setColor)}
        </div>
      ) : (
        <div className="s-row"><button className="btn sm" onClick={() => setAdding(true)}><Icon.plus size={13} /> {t('New tag')}</button></div>
      )}
      {error && <div className="s-row"><span className="tag-error">{error}</span></div>}
    </div>
  );
}
