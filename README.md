# Claude Status Line Mod

Banda de estado moderna encima del prompt de Claude Code, en píldoras de
color: límites de uso de **5 horas** y **7 días** con barra y cuenta atrás,
**contexto** y **tokens** de la sesión.

```
(5h ▰▰▱▱▱ 20% | 2h 40m)  (7d ▰▰▰▱▱ 58% | 1d 7h)  (ctx 18%)  (↑ 15.6k)  (↓ 3.0k)  (▤ 954.2k)
```

> Proyecto no oficial. Usa los *function hooks* de Claude Code, que son de
> acceso anticipado: su API puede cambiar sin aviso.

## Qué muestra

| Píldora | Qué es | Fuente |
|---|---|---|
| `5h` | % del límite de 5 horas, barra y tiempo hasta el reset | `$.session.usage().rateLimits` |
| `7d` | % del límite semanal, barra y tiempo hasta el reset | ídem |
| `ctx` | % de la ventana de contexto usada | `$.session.usage().context.percent` |
| `↑` `↓` | tokens de entrada y de salida acumulados | `usage` de cada `turn.complete` |
| `▤` | tokens de caché (lectura + escritura) | ídem |

- **Marca de ritmo.** La barra de 5h y 7d lleva una marca vertical: la parte
  del periodo que ya ha pasado. Si el relleno la sobrepasa, estás gastando
  más rápido de lo que toca.
- **Colores por umbral.** Pasan a ámbar al 80 % y a rojo al 95 %.
- **Avisos.** Al cruzar el 80 % y el 95 % de un límite, escribe una línea en
  el transcript (una vez por ciclo).
- **Escritorio y terminal.** En la app de escritorio se dibuja como SVG
  (píldoras redondeadas, iconos, modo claro y oscuro automático). En terminal
  cae a texto con fondo de color.

Los límites 5h y 7d solo existen con suscripción (Pro, Max). Sin ella, esas
dos píldoras no salen; contexto y tokens sí. Todo se rellena tras la primera
respuesta de la sesión.

## Requisitos

- Claude Code con *function hooks* disponibles (acceso anticipado).
- Para los límites 5h/7d: cuenta con suscripción.

## Instalación

1. Activa los function hooks en `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
   ```

2. Clona el repositorio:

   ```bash
   git clone https://github.com/<usuario>/claude-statusline-mod.git
   ```

3. En Claude Code: `/plugin` → instalar plugin local → elige la carpeta
   clonada. En la app de escritorio, sube la carpeta como plugin local.
4. Reinicia Claude Code. Las sesiones abiertas antes no cargan el mod.
5. Manda un mensaje: la banda aparece al terminar el primer turno.

Para comprobar el plugin sin cargarlo: `claude plugin validate <carpeta>`.

## Ajustes

Todo son constantes al principio de [hooks/register.tsx](hooks/register.tsx):

| Constante | Por defecto | Qué hace |
|---|---|---|
| `SCALE` | `1.35` | Tamaño de la banda en escritorio (vectorial, no pierde nitidez) |
| `TICK_MS` | `30000` | Cada cuánto se refrescan límites y cuentas atrás |
| `WARN_AT` / `CRIT_AT` | `80` / `95` | Umbrales de color y de aviso |
| `BAR_W`, `CW` | `46`, `7.5` | Ancho de la barra y de cada carácter del SVG |

## Limitaciones

- Los tokens `↑ ↓ ▤` cuentan desde que el mod carga, no desde el inicio de
  la sesión. Con `--resume` o tras recargar el mod empiezan de cero.
- El SVG fija el ancho de cada carácter para que el texto no se desalinee;
  con una fuente monoespaciada muy distinta puede verse algo estirado.
- Un módulo de function hooks es un solo fichero: el entorno no resuelve
  imports de código relativos. Por eso los helpers viven dentro de
  `register.tsx`.
- El motor lee los átomos de estado con análisis estático: `read($, atomo)`
  solo admite constantes del fichero, no parámetros.

## Estructura

```
.claude-plugin/plugin.json   manifiesto del plugin
hooks/hooks.json             declara el módulo
hooks/register.tsx           la banda (render, muestreo de límites, tokens)
types/index.d.ts             contrato del estado ($.state) del módulo
hooks/render.ts              formateador de la alternativa clásica
skills/status/               alternativa clásica con `statusLine` (ver abajo)
```

## Alternativa clásica (sin function hooks)

`skills/status/statusline.ts` es un script `statusLine` normal: lee el JSON
que Claude Code envía por stdin y escribe una línea de texto con colores
ANSI. No muestra píldoras ni límites vivos, pero no necesita acceso
anticipado. Detalle en [skills/status/SKILL.md](skills/status/SKILL.md).

## Desarrollo

```bash
npm install
```

La declaración de tipos de la API la genera Claude Code (`/plugin-types`
dentro de una sesión, que escribe `.claude/types/`). No se versiona. Después:

```bash
npx tsc -p .
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
