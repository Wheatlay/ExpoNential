/** Tytuły z `backtickami` jak w Linearze: fragment w kodzie, bez pełnego markdownu. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return <>{parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}
