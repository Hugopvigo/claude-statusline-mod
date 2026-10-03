import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code';
import type { Snapshot, Totals } from '../types';

/**
 * Banda de estado sobre el prompt: límites 5h/7d (barra con marca de ritmo,
 * % y cuenta atrás), contexto y tokens ↑ entrada ↓ salida ▤ caché.
 * En escritorio se dibuja como un SVG de píldoras; en terminal, como
 * texto con fondo. Avisa en el transcript al 80% y 95% de cada límite.
 *
 * Un módulo es un solo fichero: el entorno no resuelve imports de código
 * relativos, así que los helpers viven aquí (hooks/render.ts es solo del
 * script clásico). Los átomos se nombran con constantes del fichero: el
 * motor las lee con análisis estático y rechaza `read($, parametro)`.
 */

const TICK_MS = 30_000;
const WARN_AT = 80;
const CRIT_AT = 95;
const WARN_LEVELS = [WARN_AT, CRIT_AT];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Un reset que se mueve más que esto abre un ciclo nuevo. */
const CYCLE_JITTER_MS = 5 * MINUTE;

const totals = atom({ plugin: 'claude-mod-status', key: 'totals' } as const, { input: 0, output: 0, cache: 0 } as Totals);
const snapshot = atom({ plugin: 'claude-mod-status', key: 'snapshot' } as const, {} as Snapshot);
const warned5h = atom({ plugin: 'claude-mod-status', key: 'warned5h' } as const, [] as number[]);
const warned7d = atom({ plugin: 'claude-mod-status', key: 'warned7d' } as const, [] as number[]);
const reset5h = atom({ plugin: 'claude-mod-status', key: 'reset5h' } as const, null as string | null);
const reset7d = atom({ plugin: 'claude-mod-status', key: 'reset7d' } as const, null as string | null);

function shortNum(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function pctText(pct: number): string {
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : '—';
}

/** Una duración como `<1m`, `45m`, `2h 5m` o `5d 11h`. */
function durationText(ms: number): string {
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

function bar(pct: number, cells = 5): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

type Level = 'ok' | 'warn' | 'crit';
const levelOf = (pct: number): Level => (pct >= CRIT_AT ? 'crit' : pct >= WARN_AT ? 'warn' : 'ok');

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function resetMs(limit: SessionRateLimit | undefined): number | undefined {
  if (limit?.resetsAt === undefined) return undefined;
  const at = Date.parse(limit.resetsAt);
  return Number.isFinite(at) ? at : undefined;
}

function sameCycle(before: string | null, after: string | undefined): boolean {
  if (before === null || after === undefined) return before === (after ?? null);
  return Math.abs(Date.parse(after) - Date.parse(before)) <= CYCLE_JITTER_MS;
}

async function sample($: EngineInterface): Promise<void> {
  const now = await $.clock.now();
  const usage = await $.session.usage();
  const h5 = usage.rateLimits.find(l => l.kind === 'five_hour');
  const h7 = usage.rateLimits.find(l => l.kind === 'seven_day');

  if (!sameCycle(await read($, reset5h), h5?.resetsAt)) await update($, warned5h, () => []);
  if (!sameCycle(await read($, reset7d), h7?.resetsAt)) await update($, warned7d, () => []);
  await update($, reset5h, () => h5?.resetsAt ?? null);
  await update($, reset7d, () => h7?.resetsAt ?? null);

  const warn = (limit: SessionRateLimit | undefined, done: number[], label: string): number[] | null => {
    if (limit === undefined) return null;
    const fresh = WARN_LEVELS.filter(t => limit.percentUsed >= t && !done.includes(t));
    const top = fresh[fresh.length - 1];
    if (top === undefined) return null;
    const reset = resetMs(limit);
    const when = reset === undefined ? '' : `, renueva en ${durationText(reset - now)}`;
    $.ui.log(`límite de ${label} superó ${top}% (ahora ${pctText(limit.percentUsed)})${when}`);
    return [...done, ...fresh];
  };
  const next5h = warn(h5, await read($, warned5h), '5 horas');
  if (next5h !== null) await update($, warned5h, () => next5h);
  const next7d = warn(h7, await read($, warned7d), '7 días');
  if (next7d !== null) await update($, warned7d, () => next7d);

  await update($, snapshot, () => ({
    pct5h: h5?.percentUsed,
    reset5h: resetMs(h5),
    pct7d: h7?.percentUsed,
    reset7d: resetMs(h7),
    contextPct: usage.context.percent,
  }));
}

async function sampleSafe($: EngineInterface): Promise<void> {
  try {
    await sample($);
  } catch (err) {
    $.ui.log(`claude-mod-status: ${errText(err)}`);
  }
}

// --- Dibujo SVG (escritorio) ---------------------------------------------

const H = 28;
const PAD = 11;
const GAP = 6;
const CW = 7.5;
const BAR_W = 46;
/** Factor de ampliación del dibujo (vectorial: no pierde nitidez). */
const SCALE = 1.35;

type Seg =
  | { k: 'icon'; d: string }
  | { k: 'text'; t: string; bold?: boolean }
  | { k: 'bar'; pct: number; pace?: number; level: Level }
  | { k: 'div' };

// Iconos de línea sobre rejilla de 16.
const ICON = {
  gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5 10.6 7.8"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2V8l2 1.3"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  up: '<path d="M8 10V3M5.2 5.6 8 2.8l2.8 2.8"/><path d="M2.5 10.5v2h11v-2"/>',
  down: '<path d="M8 3v7M5.2 7.4 8 10.2l2.8-2.8"/><path d="M2.5 10.5v2h11v-2"/>',
  layers: '<path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5Z"/><path d="M2.5 8.2 8 11.2l5.5-3"/><path d="M2.5 10.8 8 13.8l5.5-3"/>',
  ctx: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5.2 7h5.6M5.2 9.6h3.4"/>',
} as const;

const FILL = { ok: '#86b05f', warn: '#e0a526', crit: '#e0574f' } as const;

const STYLE = `
.a{color:#2f6f5e}.a .bg{fill:#d6e8e0}
.p{color:#5b4fa8}.p .bg{fill:#dedaf1}
.r{color:#b04a35}.r .bg{fill:#f3d9d2}
.g{color:#3d7a4d}.g .bg{fill:#d7e9da}
.b{color:#4b5fc0}.b .bg{fill:#d9def3}
.s{color:#4f5b6a}.s .bg{fill:#e1e5ea}
.w{color:#8a5a00}.w .bg{fill:#f6e2b8}
.c{color:#a3262a}.c .bg{fill:#f6cfcf}
.track{fill:rgba(110,110,110,.28)}
@media (prefers-color-scheme:dark){
.a{color:#7fd3b5}.a .bg{fill:#1c3a32}
.p{color:#b8aef0}.p .bg{fill:#2c2750}
.r{color:#f0a08c}.r .bg{fill:#43241d}
.g{color:#8fd5a0}.g .bg{fill:#1d3825}
.b{color:#a3b2f5}.b .bg{fill:#222a52}
.s{color:#b4c0cf}.s .bg{fill:#2a3139}
.w{color:#f2c46b}.w .bg{fill:#3d2f0e}
.c{color:#f59a9a}.c .bg{fill:#431a1a}
.track{fill:rgba(200,200,200,.25)}
}`;

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function segWidth(s: Seg): number {
  if (s.k === 'icon') return 16;
  if (s.k === 'text') return CW * s.t.length;
  if (s.k === 'bar') return BAR_W;
  return 1;
}

function drawSeg(s: Seg, x: number): string {
  if (s.k === 'icon') {
    return `<g transform="translate(${x} 6)" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${s.d}</g>`;
  }
  if (s.k === 'text') {
    const w = CW * s.t.length;
    return `<text x="${x}" y="18.3" textLength="${w}" lengthAdjust="spacingAndGlyphs" fill="currentColor" font-size="13" font-weight="${s.bold === true ? 700 : 500}">${esc(s.t)}</text>`;
  }
  if (s.k === 'bar') {
    const fill = Math.max(s.pct > 0 ? 3 : 0, (Math.min(100, s.pct) / 100) * BAR_W);
    const tick =
      s.pace === undefined
        ? ''
        : `<rect x="${x + Math.min(BAR_W - 2, Math.max(0, s.pace * BAR_W - 1))}" y="7" width="2" height="14" rx="1" fill="currentColor"/>`;
    return `<rect class="track" x="${x}" y="11" width="${BAR_W}" height="6" rx="3"/><rect x="${x}" y="11" width="${fill}" height="6" rx="3" fill="${FILL[s.level]}"/>${tick}`;
  }
  return `<rect x="${x}" y="8" width="1" height="12" fill="currentColor" opacity=".25"/>`;
}

function drawPill(cls: string, segs: Seg[], x: number): { svg: string; w: number } {
  let cx = x + PAD;
  let body = '';
  for (const s of segs) {
    body += drawSeg(s, cx);
    cx += segWidth(s) + GAP;
  }
  const w = cx - GAP + PAD - x;
  return { svg: `<g class="${cls}"><rect class="bg" x="${x}" y="0" width="${w}" height="${H}" rx="${H / 2}"/>${body}</g>`, w };
}

type Pill = { cls: string; segs: Seg[] };

function bandSvg(pills: Pill[]): { source: string; width: number } {
  let x = 0;
  let out = '';
  for (const p of pills) {
    const d = drawPill(p.cls, p.segs, x);
    out += d.svg;
    x += d.w + 8;
  }
  const width = Math.max(1, x - 8);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"><style>${STYLE}</style>${out}</svg>`;
  return { source, width };
}

/** Qué fracción de la ventana ya ha pasado: la marca "ritmo" de la barra. */
function pace(resetAt: number | undefined, now: number, windowMs: number): number | undefined {
  if (resetAt === undefined) return undefined;
  return Math.min(1, Math.max(0, 1 - (resetAt - now) / windowMs));
}

const CLS = { ok: 'a', warn: 'w', crit: 'c' } as const;
const CLS7 = { ok: 'p', warn: 'w', crit: 'c' } as const;

function limitPill(label: string, icon: string, cls: Record<Level, string>, pct: number | undefined, resetAt: number | undefined, windowMs: number, now: number): Pill | null {
  if (pct === undefined) return null;
  const level = levelOf(pct);
  const segs: Seg[] = [
    { k: 'icon', d: icon },
    { k: 'text', t: label },
    { k: 'bar', pct, pace: pace(resetAt, now, windowMs), level },
    { k: 'text', t: pctText(pct), bold: true },
  ];
  if (resetAt !== undefined) {
    segs.push({ k: 'div' }, { k: 'icon', d: ICON.clock }, { k: 'text', t: durationText(resetAt - now) });
  }
  return { cls: cls[level], segs };
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e);
    if (e.isInteractive) $.clock.every(TICK_MS, () => void sampleSafe($));
    await sampleSafe($);
    return r;
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (e.usage !== undefined) {
      const u = e.usage;
      await update($, totals, t => ({
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cache: t.cache + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      }));
    }
    if (e.agentId === undefined) await sampleSafe($);
    return r;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    try {
      const snap = await read($, snapshot);
      const sum = await read($, totals);
      const now = await $.clock.now();
      const hasTokens = sum.input + sum.output + sum.cache > 0;

      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e);
        const pills: Pill[] = [];
        const p5 = limitPill('5h', ICON.gauge, CLS, snap.pct5h, snap.reset5h, 5 * HOUR, now);
        const p7 = limitPill('7d', ICON.calendar, CLS7, snap.pct7d, snap.reset7d, 168 * HOUR, now);
        if (p5 !== null) pills.push(p5);
        if (p7 !== null) pills.push(p7);
        if (snap.contextPct !== undefined) {
          pills.push({
            cls: snap.contextPct >= WARN_AT ? CLS[levelOf(snap.contextPct)] : 's',
            segs: [
              { k: 'icon', d: ICON.ctx },
              { k: 'text', t: 'ctx' },
              { k: 'text', t: pctText(snap.contextPct), bold: true },
            ],
          });
        }
        if (hasTokens) {
          pills.push({ cls: 'r', segs: [{ k: 'icon', d: ICON.up }, { k: 'text', t: shortNum(sum.input), bold: true }] });
          pills.push({ cls: 'g', segs: [{ k: 'icon', d: ICON.down }, { k: 'text', t: shortNum(sum.output), bold: true }] });
          pills.push({ cls: 'b', segs: [{ k: 'icon', d: ICON.layers }, { k: 'text', t: shortNum(sum.cache), bold: true }] });
        }
        if (pills.length === 0) return next(e);
        const band = bandSvg(pills);
        const alt = `5h ${snap.pct5h ?? '?'}%, 7d ${snap.pct7d ?? '?'}%, contexto ${snap.contextPct ?? '?'}%`;
        return (
          <Box>
            <Svg source={band.source} alt={alt} width={Math.round(band.width * SCALE)} height={Math.round(H * SCALE)} />
          </Box>
        );
      }

      // Terminal y demás: texto con fondo.
      const tone = {
        ok: { fg: '#6ee7b7', bg: '#14342b' },
        warn: { fg: '#fcd34d', bg: '#3b2f0b' },
        crit: { fg: '#fca5a5', bg: '#3f1414' },
        up: { fg: '#fdba74', bg: '#3b2210' },
        down: { fg: '#86efac', bg: '#143321' },
        cache: { fg: '#a5b4fc', bg: '#1e2554' },
      } as const;
      const pill = (key: string, t: { fg: string; bg: string }, text: string) => (
        <Box key={key} marginRight={1}>
          <Text color={t.fg} backgroundColor={t.bg}>{` ${text} `}</Text>
        </Box>
      );
      const limit = (key: string, pct: number | undefined, resetAt: number | undefined) => {
        if (pct === undefined) return null;
        const left = resetAt === undefined ? '' : ` · ↻ ${durationText(resetAt - now)}`;
        return pill(key, tone[levelOf(pct)], `${key} ${bar(pct, 6)} ${pctText(pct)}${left}`);
      };
      const items = [
        limit('5h', snap.pct5h, snap.reset5h),
        limit('7d', snap.pct7d, snap.reset7d),
        snap.contextPct === undefined ? null : pill('ctx', tone[levelOf(snap.contextPct)], `▣ ctx ${pctText(snap.contextPct)}`),
        hasTokens ? pill('in', tone.up, `↑ ${shortNum(sum.input)}`) : null,
        hasTokens ? pill('out', tone.down, `↓ ${shortNum(sum.output)}`) : null,
        sum.cache === 0 ? null : pill('cache', tone.cache, `▤ ${shortNum(sum.cache)}`),
      ].filter(p => p !== null);
      if (items.length === 0) return next(e);
      return <Box flexWrap="wrap">{items}</Box>;
    } catch (err) {
      return (
        <Box>
          <Text color="#fca5a5">{`claude-mod-status: ${errText(err)}`}</Text>
        </Box>
      );
    }
  });
};
