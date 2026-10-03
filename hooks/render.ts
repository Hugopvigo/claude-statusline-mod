/**
 * Formateador puro de la barra de estado.
 *
 * Lo usan los dos caminos del mod:
 * - el script clásico `skills/status/statusline.ts` (colores ANSI, `ansi = true`)
 * - (histórico) la barra de texto del mod; la banda actual vive en `hooks/register.tsx`, que no importa este fichero (`$.ui.status` pintaba
 *   texto plano, así que `ansi = false`: iconos y mini-barras unicode, sin ANSI)
 *
 * Reglas visuales: iconos geométricos (nada de emoji), sin morados,
 * verde <80%, ámbar 80–95%, rojo ≥95% (los mismos umbrales del mod
 * de referencia limit-watch). `5h` es titular de ritmo (sin barra);
 * `ctx` y `7d` son medidores de capacidad (con mini-barra de 5 celdas).
 */

export type StatusData = {
  model?: string;
  elapsedMs?: number;
  sessionTokens?: number;
  /** % del límite de 5 horas (sesión). */
  sessionPct?: number;
  /** % de la ventana de contexto. */
  contextPct?: number;
  /** % del límite de 7 días (semanal). */
  weeklyPct?: number;
  /** epoch ms del reset de sesión. */
  sessionResetAt?: number;
  /** epoch ms del reset semanal. */
  weeklyResetAt?: number;
  now?: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WARN_AT = 80;
export const CRIT_AT = 95;
/** Un reset a menos de esto se pinta en rojo. */
const URGENT_RESET_MS = 15 * MINUTE;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[38;2;148;163;184m',
  time: '\x1b[38;2;94;234;212m',
  toks: '\x1b[38;2;125;211;252m',
  ok: '\x1b[38;2;52;211;153m',
  warn: '\x1b[38;2;251;191;36m',
  crit: '\x1b[38;2;248;113;113m',
  resetIn: '\x1b[38;2;253;186;116m',
};

export type Level = 'ok' | 'warn' | 'crit';

export function levelOf(pct: number): Level {
  if (pct >= CRIT_AT) return 'crit';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}

export function shortNum(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function pctText(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  return `${Math.round(pct)}%`;
}

/** Una duración como `<1m`, `45m`, `2h 5m` o `5d 11h`. */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH > 0 ? `${days}d ${restH}h` : `${days}d`;
}

/** Mini-barra de `cells` celdas rellena según el porcentaje. */
export function bar(pct: number, cells = 5): string {
  const n = Math.max(1, cells);
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * n);
  return '▰'.repeat(filled) + '▱'.repeat(n - filled);
}

const paint = (ansi: boolean, code: string, text: string): string =>
  ansi ? `${code}${text}${C.reset}` : text;

/**
 * Una línea de estado. Cada métrica sin dato se omite; sin ningún
 * dato devuelve un texto de espera en lugar de una línea vacía.
 */
export function statusLine(d: StatusData, ansi = true): string {
  const now = d.now ?? Date.now();
  const parts: string[] = [];
  if (d.model !== undefined && d.model !== '') parts.push(paint(ansi, C.dim, d.model));
  if (d.elapsedMs !== undefined) parts.push(paint(ansi, C.time, `◷ ${durationText(d.elapsedMs)}`));
  if (d.sessionTokens !== undefined) parts.push(paint(ansi, C.toks, `◈ ${shortNum(d.sessionTokens)}`));
  if (d.sessionPct !== undefined) {
    parts.push(paint(ansi, C[levelOf(d.sessionPct)], `5h ${pctText(d.sessionPct)}`));
  }
  if (d.contextPct !== undefined) {
    parts.push(paint(ansi, C[levelOf(d.contextPct)], `▣ ctx ${pctText(d.contextPct)} ${bar(d.contextPct)}`));
  }
  if (d.weeklyPct !== undefined) {
    parts.push(paint(ansi, C[levelOf(d.weeklyPct)], `◉ 7d ${pctText(d.weeklyPct)} ${bar(d.weeklyPct)}`));
  }
  if (d.sessionResetAt !== undefined) {
    const left = d.sessionResetAt - now;
    if (left <= 0) parts.push(paint(ansi, C.crit, '↻ ahora'));
    else parts.push(paint(ansi, left <= URGENT_RESET_MS ? C.crit : C.resetIn, `↻ ${durationText(left)}`));
  }
  if (d.weeklyResetAt !== undefined) {
    const left = d.weeklyResetAt - now;
    if (left > 0) parts.push(paint(ansi, C.dim, `↻7d ${durationText(left)}`));
  }
  if (parts.length === 0) return 'sin datos de sesión todavía';
  return parts.join(paint(ansi, C.dim, ' · '));
}
