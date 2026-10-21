import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type ProjectSummary } from './api.ts';
import { ProjectBadge, switchProject } from './ProjectSwitcher.tsx';
import { toast } from './toast.ts';
import { t } from './i18n.ts';

/** Nowy projekt (osobny zespół): klucz do numerów zadań, nazwa, kolor. Twórca zostaje adminem projektu. */
let open = false;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openNewProject() { open = true; emit(); }
function close() { open = false; emit(); }

export function NewProjectHost() {
  const o = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => open);
  return o ? <NewProjectModal /> : null;
}

const COLORS = ['#5e6ad2', '#2563eb', '#26b5ce', '#059669', '#d97706', '#e5484d', '#a855f7'];

/** Propozycja klucza z nazwy: "Strona szefa" -> "SS", "Website" -> "WEBS". */
function suggestKey(name: string) {
  const words = name.normalize('NFD').replace(/[^A-Za-z\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 4)).toUpperCase().slice(0, 6);
}

function NewProjectModal() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [color, setColor] = useState(COLORS[1]);
  const [busy, setBusy] = useState(false);
  const k = keyTouched ? key : suggestKey(name);
  const valid = name.trim() && /^[A-Z]{2,6}$/.test(k);
  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const p = await api<ProjectSummary>('/api/projects', { method: 'POST', body: { key: k, name, color } });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      close();
      toast(t('Created {id}', { id: `${p.name} (${p.key})` }));
      switchProject(p.key);
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 520 }} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') void create();
      }}>
        <div className="crumbs">{t('New project')}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <ProjectBadge project={{ name: name || '?', color }} size={32} />
          <input className="title" autoFocus placeholder={t('Project name')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, alignItems: 'center', padding: '12px 0' }}>
          <label className="hint" htmlFor="np-key">{t('Issue prefix')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input id="np-key" className="input" style={{ width: 110, textTransform: 'uppercase' }} value={k} maxLength={6}
              onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '')); }} />
            <span className="hint">{k ? t('Issues will be {a}, {b}…', { a: `${k}-1`, b: `${k}-2` }) : t('2-6 letters')}</span>
          </div>
          <span className="hint">{t('Color')}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {COLORS.map((c) => (
              <button key={c} aria-label={`${t('Color')} ${c}`} onClick={() => setColor(c)}
                style={{ width: 22, height: 22, borderRadius: 6, background: c, outline: c === color ? '2px solid var(--text-primary)' : 'none', outlineOffset: 2 }} />
            ))}
          </div>
        </div>
        <div className="foot">
          <span className="hint">{t('You become the project admin. Add people in Settings › Project.')}</span>
          <span className="spacer" />
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!valid || busy} title={valid ? undefined : t('Enter a name and a 2-6 letter prefix')} onClick={() => void create()}>{t('Create project')}</button>
        </div>
      </div>
    </div>
  );
}
