import { useState, useSyncExternalStore } from 'react';
import { useModal } from './modal.ts';
import { useQueryClient } from '@tanstack/react-query';
import { api, type ProjectSummary } from './api.ts';
import { ProjectBadge, switchProject } from './ProjectSwitcher.tsx';
import { toast } from './toast.ts';
import { Tooltip } from './menu.tsx';
import { Swatches, projectPalette } from './Swatches.tsx';
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
  const [color, setColor] = useState(() => projectPalette()[1]);
  const [busy, setBusy] = useState(false);
  const modalRef = useModal();
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
      <div className="modal np-modal" role="dialog" aria-modal="true" aria-label={t('New project')} ref={modalRef} tabIndex={-1} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') void create();
      }}>
        <Tooltip text={t('You become the project admin. Add people in Settings › Project.')}><div className="crumbs">{t('New project')}</div></Tooltip>
        <div className="np-head">
          <ProjectBadge project={{ name: name || '?', color }} size={32} />
          <input className="title" autoFocus placeholder={t('Project name')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="np-grid">
          <label className="hint" htmlFor="np-key">{t('Issue prefix')}</label>
          <div className="np-key">
            <input id="np-key" className="input" size={8} value={k} maxLength={6}
              onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '')); }} />
            <span className="hint">{k ? t('Issues will be {a}, {b}…', { a: `${k}-1`, b: `${k}-2` }) : t('2-6 letters')}</span>
          </div>
          <span className="hint">{t('Color')}</span>
          <Swatches value={color} onChange={setColor} />
        </div>
        <div className="foot">
          <span className="spacer" />
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <Tooltip text={valid ? null : t('Enter a name and a 2-6 letter prefix')}><button className="btn primary" disabled={!valid || busy} onClick={() => void create()}>{t('Create project')}</button></Tooltip>
        </div>
      </div>
    </div>
  );
}
