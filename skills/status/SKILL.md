---
name: status
description: Barra de estado moderna con iconos y colores: tiempo de sesión, toks, contexto, límites 5h/7d y cuenta atrás de resets.
---

# Status moderno (barra de estado)

Una sola línea con iconos geométricos y colores por umbral
(verde <80%, ámbar 80–95%, rojo ≥95%):

`Sonnet · ◷ 1h 23m · ◈ 4.2k · 5h 9% · ▣ ctx 38% ▰▰▱▱▱ · ◉ 7d 62% ▰▰▰▱▱ · ↻ 2h 36m · ↻7d 5d 10h`

| Icono | Qué es | De dónde sale |
|---|---|---|
| `◷` | tiempo de la sesión actual | `session_id` (inicio guardado) o `session.started_at` |
| `◈` | toks consumidos en la sesión | `transcript_path` o `usage.session_tokens` |
| `5h` | % del límite de 5 horas | mod (`$.session.usage()`) o `usage.session_pct` |
| `▣ ctx` | % de la ventana de contexto + barra | `transcript_path` o `usage.context_pct` |
| `◉ 7d` | % del límite semanal + barra | mod (`$.session.usage()`) o `usage.weekly_pct` |
| `↻` | cuenta atrás del reset de sesión (rojo <15m) | mod o `limits.session_reset_at` |
| `↻7d` | cuenta atrás del reset semanal | mod o `limits.weekly_reset_at` |

Cada métrica sin dato se omite; sin ningún dato sale
`sin datos de sesión todavía`. El script nunca falla por campos ausentes.

## Script clásico (funciona hoy, con colores ANSI)

Lee el JSON que Claude Code envía por `stdin` y escribe la línea en `stdout`:

```bash
echo '{"model":{"display_name":"Sonnet"},"session_id":"abc123"}' | bun skills/status/statusline.ts
```

`session_id` registra el inicio en un fichero temporal (el cronómetro
◷ arranca en la primera ejecución). `transcript_path` alimenta ◈ y ▣
(suma de toks y último `usage` / tamaño de ventana; transcripts de más
de 64 MiB se saltan). Ejemplo con todo manual:

```bash
echo '{"model":{"display_name":"Sonnet"},"session":{"started_at":"2026-10-03T10:00:00Z"},"usage":{"session_tokens":1250,"weekly_pct":62},"limits":{"session_reset_at":"2026-10-03T15:00:00Z"}}' | bun skills/status/statusline.ts
```

Instalación como `statusLine` en `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /ruta/a/claude-mod-status/skills/status/statusline.ts",
    "padding": 0
  }
}
```

## Mod con function hooks

La banda de píldoras (límites vivos, contexto, tokens) la dibuja
`hooks/register.tsx`; ver el README del repositorio para instalarla.
Este script es la alternativa sin function hooks y no necesita acceso
anticipado.
