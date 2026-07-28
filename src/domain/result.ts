export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });
