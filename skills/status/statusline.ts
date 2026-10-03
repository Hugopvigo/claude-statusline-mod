import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { statusLine } from '../../hooks/render.ts';

/**
 * statusline clásica: lee el JSON que Claude Code envía por stdin y
 * escribe una línea con colores ANSI por stdout. No falla nunca por
 * campos ausentes: cada métrica sin dato se omite.
 *
 * Campos que entiende (todos opcionales):
 * - model.display_name / model.id: nombre visible y tamaño de ventana
 * - session_id: se guarda el inicio de sesión en un fichero temporal
 *   para el cronómetro ◷ (primera ejecución = inicio)
 * - transcript_path: de ahí salen los toks de sesión ◈ y el % de
 *   contexto ▣ (último usage del transcript / tamaño de ventana)
 * - session.started_at o session_started_at: inicio explícito (manual)
 * - usage.session_pct: % 5h manual · usage.weekly_pct: % 7d manual
 * - usage.session_tokens / usage.context_pct: valores manuales
 * - limits.session_reset_at / limits.weekly_reset_at: resets manuales
 * - context_window.used_percentage (o context.used_percentage)
 */

type In = {
  model?: { display_name?: string; id?: string };
  session_id?: string;
  transcript_path?: string;
  session?: { started_at?: string };
  session_started_at?: string;
  context_window?: { used_percentage?: number };
  context?: { used_percentage?: number };
  usage?: {
    session_tokens?: number;
    session_pct?: number;
    context_pct?: number;
    weekly_pct?: number;
  };
  limits?: { session_reset_at?: string; weekly_reset_at?: string };
};

const WINDOW_DEFAULT = 200_000;
/** Transcripts mayores que esto no se leen (línea sin ◈/▣ en vez de lenta). */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function windowForModel(modelId: string | undefined): number {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('haiku') || id.includes('sonnet') || id.includes('opus')) return 200_000;
  return WINDOW_DEFAULT;
}

type Usage = { input: number; output: number; cacheRead: number; cacheCreate: number };

function readUsage(row: unknown): Usage | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const message = (row as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const rec = usage as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const input = num(rec['input_tokens']);
  if (input === undefined) return undefined;
  return {
    input,
    output: num(rec['output_tokens']) ?? 0,
    cacheRead: num(rec['cache_read_input_tokens']) ?? 0,
    cacheCreate: num(rec['cache_creation_input_tokens']) ?? 0,
  };
}

/**
 * Una sola pasada al transcript: suma toks de sesión y guarda el uso
 * del último mensaje (base del % de contexto).
 */
function fromTranscript(transcriptPath: string): { sessionTokens?: number; lastUsed?: number } {
  const size = fs.statSync(transcriptPath).size;
  if (size > MAX_TRANSCRIPT_BYTES) return {};
  const text = fs.readFileSync(transcriptPath, 'utf8');
  let total = 0;
  let seen = false;
  let lastUsed: number | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage = readUsage(row);
    if (usage === undefined) continue;
    total += usage.input + usage.output + usage.cacheRead + usage.cacheCreate;
    seen = true;
    lastUsed = usage.input + usage.cacheRead + usage.cacheCreate;
  }
  return seen ? { sessionTokens: total, lastUsed } : {};
}

/** Cronómetro: inicio explícito, o primera ejecución vista por session_id. */
function elapsedMs(sessionId: string | undefined, startedAt: string | undefined, now: number): number | undefined {
  if (startedAt !== undefined) {
    const at = Date.parse(startedAt);
    if (Number.isFinite(at)) return Math.max(0, now - at);
  }
  if (sessionId === undefined || sessionId === '') return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(os.tmpdir(), `claude-mod-status-${safe}.start`);
  try {
    const at = Date.parse(fs.readFileSync(file, 'utf8').trim());
    if (Number.isFinite(at)) return Math.max(0, now - at);
  } catch {
    /* primera vez que se ve esta sesión: se registra ahora */
  }
  try {
    fs.writeFileSync(file, new Date(now).toISOString());
  } catch {
    return undefined;
  }
  return 0;
}

function parseAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  /* sin stdin: línea de espera */
}
let d: In = {};
try {
  d = raw.trim() !== '' ? (JSON.parse(raw) as In) : {};
} catch {
  d = {};
}
const now = Date.now();

let sessionTokens = d.usage?.session_tokens;
let lastUsed: number | undefined;
if (sessionTokens === undefined && d.transcript_path !== undefined && d.transcript_path !== '') {
  try {
    const fromFile = fromTranscript(d.transcript_path);
    sessionTokens = fromFile.sessionTokens;
    lastUsed = fromFile.lastUsed;
  } catch {
    /* transcript ilegible: se omite ◈/▣ */
  }
}
const contextPct =
  d.context_window?.used_percentage ??
  d.context?.used_percentage ??
  d.usage?.context_pct ??
  (lastUsed !== undefined ? (lastUsed / windowForModel(d.model?.id)) * 100 : undefined);

console.log(
  statusLine(
    {
      model: d.model?.display_name,
      elapsedMs: elapsedMs(d.session_id, d.session?.started_at ?? d.session_started_at, now),
      sessionTokens,
      sessionPct: d.usage?.session_pct,
      contextPct,
      weeklyPct: d.usage?.weekly_pct,
      sessionResetAt: parseAt(d.limits?.session_reset_at),
      weeklyResetAt: parseAt(d.limits?.weekly_reset_at),
      now,
    },
    true,
  ),
);
