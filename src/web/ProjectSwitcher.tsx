import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjects, type ProjectSummary } from './api.ts';
import { openMenu } from './menu.tsx';
import { navigate } from './router.ts';
import { setProjectKey, useProjectKey } from './project.ts';
import { openNewProject } from './NewProject.tsx';
import { t, tn } from './i18n.ts';

/** Kwadracik projektu: jego logo, a bez logo inicjały na kolorze projektu (jak "AC" dla Acme). */
export function ProjectBadge({ project, size = 20 }: { project: (Pick<ProjectSummary, 'name' | 'color'> & { key?: string; logoUrl?: string }) | undefined; size?: number }) {
  const words = (project?.name ?? '?').trim().split(/\s+/);
  const initials = (project?.key?.slice(0, 2) ?? (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2))).toUpperCase();
  const c = project?.color ?? 'var(--project-1)';
  if (project?.logoUrl) return <span className="ws-badge" style={{ width: size, height: size }}><img src={project.logoUrl} alt="" /></span>;
  return (
    <span className="ws-badge" style={{ width: size, height: size, fontSize: size * 0.5, background: c }}>
      {initials}
    </span>
  );
}

export function CurrentProjectBadge({ size = 16 }: { size?: number }) {
  return <ProjectBadge project={useCurrentProject()} size={size} />;
}

export function useCurrentProject() {
  const key = useProjectKey();
  return useProjects().data?.find((p) => p.key === key);
}

/** Przełączenie projektu: strona zadania należy do starego projektu, więc wracamy na board. */
export function switchProject(key: string) {
  if (location.pathname.startsWith('/issue/')) navigate('/');
  setProjectKey(key);
}

const WHEEL_DELAY = 600;

/**
 * Bęben jak w zegarze: poprzedni i kolejne projekty wokół wybranego. Pojawia się pod nazwą, ale nigdy poza ekranem
 * (pasek boczny leży przy krawędzi, więc przesuwamy go do środka i dociskamy do okna).
 */
function Drum({ anchor, projects, index }: { anchor: HTMLElement; projects: ProjectSummary[]; index: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(a.bottom + 4, window.innerHeight - r.height - 8)),
    });
  }, [anchor, index, projects.length]);
  const n = projects.length;
  const half = Math.min(2, Math.floor(n / 2));
  const offsets = [-2, -1, 0, 1, 2].filter((o) => Math.abs(o) <= half);
  const rows: { i: number; d: number }[] = [];
  for (const o of offsets) { const i = (index + o + n * 2) % n; if (!rows.some((r) => r.i === i)) rows.push({ i, d: Math.abs(o) }); }
  return createPortal(
    <div ref={box} className="popover project-drum" style={pos} aria-hidden="true">
      {rows.map(({ i, d }) => (
        <div key={projects[i].key} className={`drum-row d${d}`}>
          <ProjectBadge project={projects[i]} /><span className="ws-name">{projects[i].name}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Nazwa projektu w górze sidebara. Klik: lista projektów. Kółko nad nazwą: podgląd kolejnego
 * projektu z paskiem odliczania i bębnem sąsiednich projektów; po chwili bez ruchu przełącza (zjechanie kursorem nie anuluje). Esc anuluje.
 */
export function ProjectSwitcher() {
  const projects = useProjects().data ?? [];
  const current = useProjectKey();
  const [preview, setPreview] = useState<{ index: number; started: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewIndex = useRef<number | null>(null);
  const lastStep = useRef(0);
  const curIndex = Math.max(0, projects.findIndex((p) => p.key === current));

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    previewIndex.current = null;
    setPreview(null);
  };

  // Kółko: listener nie-pasywny, żeby przewijanie nie przesuwało sidebara.
  useEffect(() => {
    const el = ref.current;
    if (!el || projects.length < 2) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 1) return;
      // Touchpad i "wolne" kółko sypią dziesiątkami zdarzeń: najwyżej jeden projekt na 150 ms.
      if (Date.now() - lastStep.current < 150) return;
      lastStep.current = Date.now();
      const index = ((previewIndex.current ?? curIndex) + (e.deltaY > 0 ? 1 : -1) + projects.length) % projects.length;
      previewIndex.current = index;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        previewIndex.current = null;
        setPreview(null);
        if (projects[index].key !== current) switchProject(projects[index].key);
      }, WHEEL_DELAY);
      setPreview({ index, started: Date.now() });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [projects, curIndex, current]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const shown = preview ? projects[preview.index] : projects[curIndex];

  const open = () => {
    cancel();
    openMenu(ref.current!, {
      items: [
        ...projects.map((p) => ({
          key: p.key,
          label: p.name,
          icon: <ProjectBadge project={p} />,
          kbd: [`${p.key} · ${tn(p.memberCount, '{n} person', '{n} people')}`],
          checked: p.key === current,
          onSelect: () => { if (p.key !== current) switchProject(p.key); },
        })),
        { key: 'sep', separator: true as const },
        {
          key: 'new', label: t('+ New project'),
          onSelect: () => openNewProject(),
        },
        { key: 'settings', label: t('Project settings and members'), onSelect: () => navigate('/settings#project') },
      ],
    });
  };

  return (
    <button
      ref={ref}
      className={`project-switch ${preview ? 'previewing' : ''}`}
      onClick={open}
      title={projects.length > 1 ? t('Switch project (click, or scroll over the name)') : t('Project')}
      aria-haspopup="menu"
    >
      <ProjectBadge project={shown} />
      <span className="ws-name">{shown?.name ?? current}</span>
      {preview
        ? <span className="hint">{preview.index + 1}/{projects.length}</span>
        : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 3.5h6L5 7z" /></svg>}
      {preview && <span key={preview.started} className="project-switch-bar" style={{ animationDuration: `${WHEEL_DELAY}ms` }} />}
      {preview && ref.current && <Drum anchor={ref.current} projects={projects} index={preview.index} />}
    </button>
  );
}
