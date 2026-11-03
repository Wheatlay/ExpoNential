/** Adres z serwera trafia do href tylko jako http(s): data:, javascript: i inne schematy odpadają. */
export const isHttpUrl = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
