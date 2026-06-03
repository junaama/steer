# Steer — Design System

**Source:** the hi-fi design handoff in `design-reference/interception-console/` (`console.html` + `styles.css` + `app.jsx`/`trace.jsx`/`sidebar.jsx`/`ui.jsx` + `data.js`).

**Hard rule:** the handoff's assets (React-18-UMD, in-browser Babel, plain CSS, the mock streaming engine, `window.IC` seed data) are **reference only and do not ship**. Rebuild as typed React components in `apps/web`, carrying over the tokens, type scale, spacing, status color semantics, component structure/states, icon set, and motion defined below. The wordmark is **steer**.

Aesthetic: *Solarized × Perplexity-calm, mono-forward* — JetBrains Mono throughout, wide tracking on uppercase labels, negative tracking on dense mono content. Dark is the default; light is fully supported via `data-theme` on the root.

---

## 1. Design tokens

### Solarized accents (theme-independent)
| Token | Hex | Use |
|---|---|---|
| `--sol-yellow` | `#b58900` | pending / needs-approval |
| `--sol-orange` | `#cb4b16` | error |
| `--sol-red` | `#dc322f` | cancelled / danger |
| `--sol-magenta` | `#d33682` | (reserved) |
| `--sol-violet` | `#6c71c4` | **accent / interception / substituted** |
| `--sol-blue` | `#268bd2` | running |
| `--sol-cyan` | `#2aa198` | **accent-2 / highlights** |
| `--sol-green` | `#859900` | done |

`--accent: violet`, `--accent-2: cyan`. Interception and primary actions are violet.

### Semantic status (tool-call lifecycle) — the core color language
`proposed`→`text-dim` · `pending`→yellow · `running`→blue · `cancelled`→red · `substituted`→violet · `done`→green · `error`→orange.

Session status: `idle`→dim · `starting/connecting`→blue · `running`→blue · `awaiting-approval`→yellow · `interrupted`→yellow · `completed`→green · `error`→orange.

### Dark theme (default)
| Token | Value |
|---|---|
| `--bg` | `#002b36` |
| `--bg-elev` | `#073642` |
| `--bg-elev2` | `#06323d` |
| `--bg-inset` | `#00242e` |
| `--border` | `#0d4150` |
| `--border-strong` | `#16566a` |
| `--text` | `#93a1a1` |
| `--text-body` | `#839496` |
| `--text-strong` | `#e6dfc8` |
| `--text-dim` | `#5c727a` |
| `--hover` | `rgba(255,255,255,.035)` |
| `--selected` | `rgba(108,113,196,.16)` |
| `--diff-add-bg / fg` | `rgba(133,153,0,.14)` / `#9fb300` |
| `--diff-del-bg / fg` | `rgba(220,50,47,.13)` / `#f0594f` |
| `--scrim` | `rgba(0,15,20,.62)` |

### Light theme
| Token | Value |
|---|---|
| `--bg` | `#fdf6e3` |
| `--bg-elev` | `#f4eeda` |
| `--bg-elev2` | `#efe8d2` |
| `--bg-inset` | `#f7f1de` |
| `--border` | `#e4dcc2` |
| `--border-strong` | `#d6cdaf` |
| `--text` | `#586e75` |
| `--text-body` | `#657b83` |
| `--text-strong` | `#0a3a47` |
| `--text-dim` | `#94a0a0` |
| `--hover` | `rgba(0,43,54,.04)` |
| `--selected` | `rgba(108,113,196,.12)` |
| `--diff-add-bg / fg` | `rgba(133,153,0,.16)` / `#5f6d00` |
| `--diff-del-bg / fg` | `rgba(220,50,47,.10)` / `#b3241f` |
| `--scrim` | `rgba(40,30,10,.28)` |

### Radii / shadow / motion
- Radii: `--r-sm 6px · --r-md 9px · --r-lg 13px · --r-pill 999px`.
- Shadows: card `0 1px 2px rgba(0,0,0,.04), 0 8px 24px -16px rgba(0,0,0,.25)`; pop `0 12px 40px -12px rgba(0,0,0,.45)`.
- Easing: `cubic-bezier(.2,.7,.3,1)`; standard transitions .12–.18s.
- Theme swap: add a `no-trans` class for one frame so var-driven colors snap instead of interpolating.

---

## 2. Typography

- **Font:** JetBrains Mono (weights 400–700, italic 400/500), `ui-monospace` fallback. **Self-host** (e.g. `@fontsource/jetbrains-mono`) — do not rely on the handoff's Google Fonts `<link>` tags.
- **Base:** 13px / line-height 1.55, antialiased, `optimizeLegibility`.
- **Tracking rule:** wide positive tracking on uppercase labels (`.07em`–`.18em`); slight negative tracking (`-.005em` to `-.01em`) on dense mono content.

| Role | Size / weight / tracking |
|---|---|
| eyebrow / section label | 9.5–10px · 600 · `.14–.18em` · UPPERCASE · dim |
| body message | 13px · `1.62` lh · `-.005em` |
| thinking | 12.5px · italic · dim · left border rule |
| detail title (h1) | 14px · 600 · `-.01em` |
| modal h3 / placeholder h2 | 14px / 16px · 600 |
| sidebar row title | 12.5px · 500 · `-.01em` (inactive 400) |
| sidebar meta | 10px · dim · `.03em` |
| tool name | 12.5px · 600 |
| tool kind tag | 9px · UPPERCASE · `.1em` |
| status pill | 10.5px · 600 · UPPERCASE · `.07em` |
| stat badge | 9.5px · 600 · UPPERCASE · `.09em` |
| button | 11px · 600 · `.05em` (sm 10.5px) |
| diff / result block | 11.5px |
| key-value | 12px |

---

## 3. Layout & spacing

- **App:** CSS grid, rows `52px` (topbar) + `1fr` (body).
- **Body:** grid cols `304px` (sidebar) + `1fr` (main).
- **Sidebar:** rows head / list / foot; padding 14px; search 34px tall; rows 10–11px padding, radius md, 2px inter-row gap; active row = `--selected` bg + a 2.5px violet left rail.
- **Main:** rows detail-head (auto) + trace (1fr). Detail head padding 12/18px.
- **Trace:** centered column, `max-width 880px`, horizontal padding 28px, top 22px, bottom 120px; events `margin-bottom 18px`.
- Control gaps 6–10px; section paddings 10–14px. Slim 9px scrollbars.

---

## 4. Component inventory

Rebuild each as a typed React component. States in **bold** must be handled.

- **Topbar:** wordmark (`steer`, 20px violet glyph + text) · spacer · theme toggle (sun/moon) · userchip (gradient avatar initials + email) · Logout button (logout flushes synced rows + reloads).
- **Buttons (`btn`):** `primary` (violet, white), default (elevated), `ghost`, `danger` (red outline), modifiers `sm` / `block`; **disabled** at .45 opacity.
- **Sidebar search:** input + `⌘K` kbd hint; focus-within → violet border + inset bg.
- **Filter chips:** All / Live / Paused / Done / Error, each with a status dot; `data-on` = selected (violet-tinted).
- **Session row:** pulsing status dot · title · meta (`status · relTime`) · unread pill · hover-revealed delete; **active / hover / inactive** states; **skeleton** while syncing; **empty** ("No sessions yet" / "No sessions match" + clear).
- **Status pill / status dot / stat badge:** color driven by the status→color map; live statuses (running/starting/awaiting-approval) get a pulsing halo.
- **Detail head:** title (+ hover rename hint, inline `titleedit`) · sub (`model · N events · updated …`) · status pill · contextual actions (**Interrupt** when live, **Continue** when interrupted, **Reconnect & retry** on error).
- **Trace events:**
  - *message* — `assistant` role label + body + **streaming caret** while not done.
  - *thinking* — italic dim text, violet rail icon, left border rule, streaming caret.
  - *tool card* (below).
- **Tool card:** head = tool name + kind tag (`read-only` / `side-effect`, orange for write) + inline primary-arg summary + stat badge; `data-live` (status-colored border) and `data-attn` (yellow ring when pending). Body sections: **Arguments** (key-value), **Proposed change** (diff, for writes), **executing…** live-tail (running, no result yet), **Result** block (done/substituted), **cancelled** block. **Audit** row when `substitutedFrom` ("operator substituted grep → read") or `editedArgs`.
- **Intercept controls** (rendered when status is `running` or `pending`): eyebrow = "Will not run until you act" (pending) / "Read-only · intervene live" (running). Modes **view / swap / edit**.
  - pending (side-effecting): **Approve** (primary) · **Swap → read-only** · **Edit args** · **Reject** (danger).
  - running (read-only): **Cancel & swap → read** · **Edit args** · **Cancel** (danger).
- **Swap picker** (subpanel): lists **read-only tools only** (name + desc), `SELECT →` on hover.
- **Args editor** (subpanel): one field per arg (textarea when value >38 chars), **Run with edits** / Cancel.
- **Diff:** file header (`file  +add −del`) + lines (`gutter | sign | code`), add = green bg/fg, del = red bg/fg.
- **Live-tail** ("live — following") and **Jump to live** pill (appears when scrolled away from bottom).
- **States:** placeholder (no session selected), error/warn **banners**, **skeleton** shimmer rows, **toasts** (bottom-right, auto-dismiss).
- **Modals:** New session (prompt textarea + model chips `sonnet`/`opus`/`haiku`, ⌘+Enter to submit) and Delete confirm (`sm`); both over a blurred scrim.

---

## 5. Iconography

Minimal stroke line icons, 24px viewBox, stroke 1.6, round caps/joins, `currentColor`. Glyphs: `search, plus, x, check, chevron, chevdown, swap, edit, pause, play, trash, bolt, wrench, file, read, grep, folder, spinner, brain, msg, sun, moon, logout, bell, warn, plug, arrowdown, dot, sliders, sparkle`.

Tool→icon map: `read→read · grep→grep · glob/ls→folder · outline/write_file→file · default→wrench`.

**Recommendation:** reproduce as a typed `Icon` React component, or adopt `lucide-react` (same stroke aesthetic) and keep these glyph semantics — don't copy the handoff's inline-SVG JS verbatim.

---

## 6. Mapping to UI requirements (`docs/brainstorms/2026-06-02-web-ui-requirements.md`)

| UI-R | Realized by |
|---|---|
| R4 app shell | App grid + topbar + body |
| R5/R6 sidebar list + search/filter | Sidebar, search, filter chips, session row |
| R7 deep-link/active | session row active state + `#/s/:id` hash route |
| R8/R9/R10 create | New session modal → session row → detail |
| R11/R12 live trace + tool cards | Trace events, ToolCard |
| R13 status indicator | Status pill / status dot |
| R14 auto-follow / scroll-back | Live-tail + Jump-to-live |
| R15/R16 intercept controls | InterceptControls (running / pending sets) |
| R17 swap picker | SwapPicker (read-only only) |
| R18 edit args | ArgsEditor |
| R19 audit | Tool card audit row |
| R21/R22 diff vs text | Diff component / Result block |
| R26 empty/loading/error | placeholder, banner, skeleton |
| R27 delete confirm | ConfirmModal |
| R28 interrupt/continue | detail-head actions + banners |

---

## 7. Translation rules (handoff → shipped app)

1. **Nothing from the handoff ships.** No UMD React, no in-browser Babel, no `window.IC`, no scripted streaming engine, no raw CSS file copied wholesale.
2. **Tokens once, as the single source.** Define the dark/light variable sets (and the semantic status names) as CSS custom properties or a typed theme object — keep the names above so components reference `--status` etc.
3. **Data comes from real sync.** Replace `window.IC` + the scripted engine with TanStack DB collections projecting Electric-synced `events`. The mock's event/tool/status shapes already match the planned schema (`sessions` / append-only `events` / tool lifecycle states) — reuse them as the **fixture reference for U13's `seed.ts`** and as a sanity check on the schema spine (U2).
4. **Fonts self-hosted**, icons as a typed component (or lucide-react).
5. **Components are typed** (props interfaces, no `any`), matching the repo TS style; status→color and tool→icon maps become typed lookup objects.
6. **Wordmark = steer.**
</content>
