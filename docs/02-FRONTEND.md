# 02 · Frontend build spec

Dune · CloudSmiths · First Commit (AWS x WeMakeDevs)

Owners: the two frontend builders. Read `03-API.md` alongside this.

## Scope and ground rules

Three screens. Nothing else gets built.

### Stack

- **React 18 + TypeScript + Vite.** Fast dev server, simple build, deploys to Amplify Hosting without configuration.
- **Tailwind** for styling, with the tokens in this doc defined as CSS variables.
- **shadcn/ui** for primitives: button, input, card, dialog, tabs, badge, skeleton, toast. Copy in only the components used.
- **TanStack Query** for server state. It gives polling, caching and loading states for free, and the indexing screen needs polling.
- **React Flow** for the graph. Reasons in the graph section.
- **lucide-react** for icons. One icon set, no mixing.

No state management library. TanStack Query holds server state, `useState` holds UI state. There is nothing else.

### Ground rules

**Types come from `packages/shared`.** Do not redeclare `Answer` or `GraphNode` in the frontend. If a type needs changing, it changes in shared and both sides see it.

**Never block on the backend.** Fixtures live in `src/mocks/`. A flag switches between mock and live, so the frontend runs before the API exists.

**Every component handles four states:** loading, empty, error, success. A component that only handles success is not finished.

**No raw error strings in the UI.** Every failure gets a human sentence and a retry action. The backend spec has a table of failure cases; each one needs a corresponding UI state.

**Desktop only, latest Chrome.** Nothing should be badly broken below 1280px, but mobile layouts are not a goal.

## Design direction

### The character

**A technical instrument, not a marketing site.** Dune shows a developer where they are in a codebase. It should feel like a precise tool: dense where density helps, quiet everywhere else, with nothing on screen that is not carrying information.

The reference points are a good terminal, a well-made IDE panel, a flight instrument. Not a SaaS landing page, not a dashboard full of cards with big numbers.

### Dark by default

Developers work in dark themes and a graph of coloured nodes reads better on dark. Dark only. There is no light theme.

### Three principles

**1. Typography does the work.** Almost all hierarchy comes from size, weight and colour of text. Very few boxes, very few borders. When something needs separating, try space first, a subtle border second, a card third.

**2. One accent colour, used sparingly.** Amber is the accent. It marks the recommended file, the active node, the primary action. If everything is accented, nothing is. A screen should have one or two amber elements, not eight.

**3. Monospace is the default voice.** What shipped is mono-first: `body` is monospace, so paths, symbol names, line numbers, code *and* prose are all set in it, and the interface reads as one instrument rather than two registers. Fraunces, a serif, is the exception, used for headings and section titles. See "Typography".

### What to avoid

- Gradients, glows, glassmorphism
- Animated transitions longer than 150ms
- Emoji in the interface
- Rounded corners above 8px, which read as consumer rather than tool
- Large hero text or marketing copy anywhere inside the app
- More than two font weights in use at once

### Where the shipped app diverges, deliberately

The theme that shipped is a desert night, not the neutral instrument this section describes, and three items on the avoid list above were overruled on purpose. They are recorded here as decisions, not oversights:

- **Screen 1 is a landing page**, with hero type, a scroll-triggered sandstorm and a section explaining the product. A visitor meets the product there before they meet the tool.
- **Motion is ambient and slow**: a caravan crosses the horizon over 48s, stars twinkle, dunes glow while a query runs. All of it is disabled under `prefers-reduced-motion`.
- **Radii reach 12 to 16px** on cards and panels, and glows and backdrop blur are used as depth.

What was *not* overruled: dark by default, typography carrying the hierarchy, skeletons over spinners, and the mono rule above.

### The test

A screenshot should look like something a developer would leave open all day. If it looks like a product launch page, it has gone wrong.

## Design tokens

Define these once as CSS variables. Never hardcode a colour or a spacing value anywhere else.

### Colour

```css
:root {
  /* surfaces, darkest to lightest: a desert night */
  --sky-deep:  #0A0B14;   /* page, and the darkest panels */
  --sky-mid:   #171833;   /* panels, cards, raised surfaces */
  --dune-far:  #241C2E;   /* hover, pressed, the recommended node */
  --dune-mid:  #3A2B33;   /* all borders */
  --dune-near: #57392C;   /* stronger borders: inputs, selects */

  /* text and accent */
  --ink:  #EAE2D4;        /* body text */
  --sand: #C89B6B;        /* labels, secondary text, the quieter accent */
  --moon: #F0DFB4;        /* headings, the primary action, the active node */
}
```

These eight variables are the palette, defined in `packages/web/src/index.css`. Semantic colours come from Tailwind directly rather than from variables: `emerald` for a decision, `red` for a dead end and every error state, `amber` for a constraint and for a pending suggestion, and the per-kind graph colours in `KIND_STYLES` (`CustomGraphNode.tsx`).

**Two accents, not one.** Sand carries labels and secondary text; moon marks headings, the primary button and the active node. The spec above asked for one; two shipped, and on a dark desert background they read as one family rather than as competition.


### Typography

```css
--font-serif: 'Fraunces', Georgia, serif;
--font-mono:  'IBM Plex Mono', Menlo, Monaco, Consolas, monospace;
```

**Mono-first.** `body` is monospace, so the whole interface is monospace unless something opts out. That inverts the rule the rest of this section was written around. Rather than mono marking what comes from the codebase, mono is the default voice of the instrument, and everything in it (paths, prose, labels) is set in it. Fraunces, a serif, carries headings and section titles: it is the one warm, non-technical note in the interface. Inter is loaded at 400 for the rare line of running prose (a low-confidence candidate's reason) and is used almost nowhere else.

Fonts load without blocking the first paint: `index.html` preloads the stylesheet and applies it with the `media="print"` swap, and requests only the weights in use: Fraunces 300/400/600, IBM Plex Mono 400/500/600/700 plus italic 400, Inter 400. Adding a weight means editing that URL.

Scale, and use nothing outside it:

| Token | Size / line-height | Use |
| --- | --- | --- |
| `text-xs` | 12 / 16 | Line numbers, metadata, badges |
| `text-sm` | 13 / 20 | Body default, most of the interface |
| `text-base` | 15 / 24 | Answer body, panel content |
| `text-lg` | 18 / 26 | Section headings |
| `text-xl` | 22 / 30 | Screen title, used once per screen |

Weights: 400 and 600 only. No 500, no 700. Two weights is a constraint that makes a small interface look considered.

### Spacing

4px base. Use 4, 8, 12, 16, 24, 32, 48 and nothing between them. Inconsistent spacing is the fastest way to look unfinished.

### Radius and shadow

```css
--radius-sm: 4px;   /* badges, small controls */
--radius:    6px;   /* buttons, inputs, cards */
--radius-lg: 8px;   /* panels, modals. Maximum. */
```

One shadow, used only on floating elements (dropdowns, modals):

```css
--shadow: 0 8px 24px rgba(0,0,0,0.4);
```

Cards and panels get a border, not a shadow.

### Motion

150ms ease-out for everything. Fade and small translate only. No spring, no bounce, no stagger. Skeletons for loading, never spinners, except inside a button during a submit.

## Screen 1 · Connect a repo

The first screen a visitor sees. It has one job and should look like it has one job.

### Layout

Centred column, max-width 560px, vertically centred in the viewport.

```
            Dune
            Know where you are in any codebase.

  ┌────────────────────────────────────────────┐
  │ github.com/owner/repo                      │  ← input, mono font
  └────────────────────────────────────────────┘
            [ Index repository ]                   ← primary, amber

            Try it on a sample repo →               ← text link
```

- Product name in `text-xl`, weight 600
- Tagline in `text-sm`, `--text-muted`
- Input is monospace, since it holds a URL
- 48px between the title block and the input, 24px between input and button

### The sample repo link matters

It loads a pre-indexed repo instantly, so anyone who does not want to wait through indexing is in the product in one click.

### Indexing state

On submit, the same centred column transforms in place. No page navigation, no modal.

```
            Indexing owner/repo

  ✓ Cloning                          412 files
  ✓ Parsing                          389 parsed, 2 skipped
  ⣾ Embedding                        1,204 / 2,180 chunks
  ○ Finalising

  ────────────────────────────  62%

            This usually takes under two minutes.
```

- Poll `GET /repos/:repoId` every 1.5 seconds with TanStack Query
- Completed stages: green check, `--ok`
- Active stage: small animated indicator, counts updating
- Pending stages: hollow circle, `--text-dim`
- Counts in monospace, right-aligned, so the numbers line up as they change
- Thin progress bar, amber fill, 2px tall. No thick rounded bars.

### Failure state

```
            Could not index owner/repo

            Cloning failed: repository not found or private.
            Check the URL, or try a public repository.

            [ Try another repo ]   [ Use sample repo ]
```

The stage that failed stays visible with a red marker. The user should be able to see how far it got. Never show a stack trace.

### On success

Navigate straight to Screen 2. No success screen, no confirmation. The map appearing is the confirmation.

## Screen 2 · Map and answers

The main screen. This is where the demo spends most of its time, so it gets the most care.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Dune   owner/repo   412 files                  Context  ⌘K   │  ← 48px bar
├───────────────────────────────────────┬──────────────────────┤
│                                       │                      │
│                                       │   Ask where a        │
│            GRAPH                      │   change belongs     │
│                                       │   ┌────────────────┐ │
│                                       │   │                │ │
│                                       │   └────────────────┘ │
│                                       │   [ Find ]           │
│                                       │                      │
│                                       │   ── answer card ──  │
│                                       │                      │
└───────────────────────────────────────┴──────────────────────┘
        flexible, min 60%                    fixed 420px
```

Top bar: product name, repo name in monospace, file count in `--text-dim`, and a link to the context panel on the right.

### Query input

- Textarea, two rows, grows to four
- Placeholder: `Where do I add rate limiting to the auth API?`
- Enter submits, Shift+Enter newlines
- Below it, three example questions as clickable chips when no answer is shown yet. This solves the blank-page problem and shows what the product is for without a tutorial.

### Answer card

The single most important component in the product. Structure, top to bottom:

```
┌────────────────────────────────────────┐
│ RECOMMENDED                      high  │  ← label + confidence badge
│                                        │
│ src/middleware/rateLimiter.ts          │  ← mono, 15px, amber
│                                        │
│ Attach to                              │
│ src/routes/auth.ts                     │  ← mono, clickable
│                                        │
│ Why                                    │
│ All authentication endpoints pass      │
│ through this router.                   │
│                                        │
│ Affected                               │
│ /login  /register  /forgot-password    │  ← mono badges
│                                        │
│ Tests to update                        │
│ auth.test.ts   rateLimit.test.ts       │
│                                        │
│ ── Sources ──────────────────────────  │
│ src/routes/auth.ts:12-48          →    │  ← clickable, opens viewer
│ src/services/authService.ts:3-20  →    │
│                                        │
│ [ Save to context ]                    │
└────────────────────────────────────────┘
```

**Section labels** are `text-xs`, uppercase, letter-spaced, `--text-muted`. **Values** are `text-base`. This label-value rhythm is what makes it scan like an instrument readout rather than a chat reply.

**Confidence badge:** green for high, amber for medium, grey for low. On low, replace the single recommendation with two or three candidates and a line saying the answer is uncertain. Do not hide uncertainty.

**Clicking a source** opens a side drawer with that file at the cited lines, syntax highlighted, the cited range marked. This is the verification step from the user flows and it is what makes the product trustworthy rather than another chat box.

### Graph interaction

- Clicking a node opens the same file drawer
- The recommended file and attach point get an amber ring on the graph when an answer is shown, connecting the two halves of the screen visually
- Affected files get a dimmer highlight
- Hovering a node shows a small tooltip: path, imports in, imports out

### Loading state

While a query runs, show a skeleton in the exact shape of the answer card. Not a spinner. The layout should not jump when the answer arrives.

## Screen 3 · Context panel

The team's shared memory. This is the differentiator, so it needs to feel substantial rather than like a notes field.

### Presentation

A full-height drawer sliding from the right, 520px wide, over the map. Not a separate route, so the user stays in the repo.

### Layout

```
┌──────────────────────────────────────────┐
│ Context                          ✕       │
│ owner/repo                               │
│                                          │
│ [ All ] [ Decisions ] [ Dead ends ]      │  ← filter tabs
│ [ Constraints ]                          │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ ⚡ SUGGESTED                          │ │  ← amber left border
│ │ Passport.js was removed from auth.ts │ │
│ │ Record why?                          │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ editable draft text              │ │ │
│ │ └──────────────────────────────────┘ │ │
│ │ [ Save ]  [ Dismiss ]                │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ DECISION                    2 hours ago  │
│ JWT over sessions                        │
│ Stateless auth needed for the edge       │
│ runtime; sessions would need a store.    │
│ src/auth/jwt.ts  src/middleware/auth.ts  │
│                                          │
│ DEAD END                       yesterday │
│ Passport.js                              │
│ Conflicted with the existing auth        │
│ middleware. Removed in #142.             │
│ src/routes/auth.ts                       │
│                                          │
│ ──────────────────────────────────────── │
│ [ + Add manually ]     [ Export ⧉ ]      │
└──────────────────────────────────────────┘
```

### Item types and their markers

| Type | Label colour | Meaning |
| --- | --- | --- |
| Decision | `--info` | A choice that was made and should not be re-litigated |
| Dead end | `--error` | Something tried and rejected. The most valuable type, because it stops an agent suggesting it again. |
| Constraint | `--warn` | A limit the code must respect |
| Suggested | `--accent` | A draft awaiting approval |

Labels are `text-xs` uppercase. Timestamps are relative and right-aligned in `--text-dim`. File paths at the bottom of each item are monospace `text-xs` and clickable.

### Suggestions

Pending suggestions sort to the top with an amber left border, so they are distinct from confirmed items. The body text is editable in place before saving. The point is human-confirmed context, so editing is one action, not a modal.

After save, the item animates into position in the main list. 150ms, nothing elaborate.

### Export

Opens a modal showing the generated markdown in a monospace block, with a copy button. Copy should be one click and should show a confirmation toast.

Below the markdown, a short line: `Or connect via MCP: <url>`, with the endpoint copyable. This is where MCP becomes visible in the UI rather than invisible plumbing.

### Empty state

Not a blank panel. Show one example item, greyed, with a line explaining what gets stored here and why it is shared. Someone who opens this panel first should still understand the feature.

## Component inventory

Every component below must handle loading, empty, error and success. A component that only renders the success case is not done.

| Component | Props | States to handle |
| --- | --- | --- |
| `RepoInput` | `onSubmit` | idle, validating, submitting, invalid URL |
| `IndexProgress` | `job` | each stage, failed at stage, complete |
| `GraphView` | `graph`, `highlight`, `onNodeClick` | loading skeleton, empty graph, too many nodes, rendered |
| `QueryBox` | `onAsk`, `disabled` | idle with examples, typing, submitting |
| `AnswerCard` | `answer` | skeleton, low confidence variant, no answer found, full answer |
| `FileDrawer` | `path`, `highlightLines` | loading, file not found, loaded |
| `ContextPanel` | `items`, `suggestions` | loading, empty with example, list, save failed |
| `ContextItemCard` | `item` | decision, dead end, constraint, agent-authored badge |
| `SuggestionCard` | `draft`, `onSave`, `onDismiss` | editable, saving, saved, dismissed |
| `ExportModal` | `markdown` | generating, ready, copied |
| `ConfidenceBadge` | `level` | high, medium, low |
| `ErrorState` | `message`, `action` | used everywhere something fails |

### Shared behaviours

**Skeletons, not spinners.** Every loading state is a skeleton in the shape of the thing that is coming. The only exception is a spinner inside a button during submit.

**Errors are sentences.** `ErrorState` takes a human message and an action. No component renders `error.message` directly.

**Monospace rule.** Anything originating in the codebase (paths, symbols, line numbers, route paths, code) renders in `--font-mono`. Applied without exception.

**Agent-authored items** carry a small badge. If an MCP client wrote a context item, a human must be able to see that at a glance.

### Build order

Frontend can build all of this against mocks before any endpoint exists:

1. Tokens, layout shell, top bar
2. `RepoInput` and `IndexProgress` against a fake job that advances on a timer
3. `AnswerCard` against a mock answer. Build this early. It is the component everything else supports
4. `GraphView` against a mock graph
5. `ContextPanel` and `SuggestionCard`
6. `FileDrawer`
7. `ExportModal`

Step 3 before step 4. The answer card matters more to the demo than the graph, and if time runs short the graph can be simpler than planned while the answer card cannot.

## Graph rendering

### Library

**React Flow.** Node positions come pre-computed from the backend, so no layout engine is needed in the browser. React Flow handles pan, zoom, custom nodes and edge rendering, and it renders 500 nodes without trouble.

Do not use D3 force simulation. It runs the layout in the browser, it is non-deterministic, and the graph settles differently on every load.

### Node design

A rounded rectangle, not a circle. Circles waste space and cannot hold a filename.

```
┌─────────────────────┐
│ ● auth.ts        12 │   ● category dot, name mono 12px,
└─────────────────────┘     inbound count right, --text-dim
```

- Width scales with name length, capped at 180px, with the middle of long paths elided
- Category dot colour from the `--node-*` tokens
- Entry points get a 1px amber border
- The recommended file from an active answer gets a 2px amber ring and a slight scale
- Affected files get a dimmer amber border
- Unrelated nodes drop to 40% opacity when an answer is shown, so the eye goes straight to what matters

### Edges

Thin, `--border`, 1px, with a small arrowhead. On node hover, edges touching it go to `--text-dim` while the rest fade. Do not animate edges, ever. Animated dashes on a dependency graph look like a screensaver.

### Clustering

Nodes are grouped by top-level directory, provided by the backend as a cluster label. Give each cluster a faint background region with a small label in the corner. This is what turns a hairball into a readable map, and it is most of the difference between a graph that looks impressive and one that looks like noise.

### Controls

Bottom left, minimal: zoom in, zoom out, fit to view. No minimap. The graph is not large enough to need one and it adds clutter.

### Performance guard

Isolated nodes never reach the frontend: the backend always excludes them and reports how many in `hiddenCount`, per `03-API.md`. Render that count as a small line: `showing 287 of 412 files; isolated files hidden`. Isolated files are almost always config and type-only modules and they add nothing to the picture.

### The fallback

If the graph is not working out, a grouped list view does the job: directories as sections, files as rows, with the same highlighting for recommended and affected files. Less impressive, still useful. The answer card is the product; the graph is context around it.

## Working without the backend

The frontend runs before a single endpoint exists. That is what the frozen API contract buys.

### Setup

```
src/mocks/
  graph.json        # ~40 nodes, ~60 edges, realistic paths
  answer.json       # one high-confidence answer
  answer-low.json   # low-confidence variant
  context.json      # 3 decisions, 2 dead ends, 1 constraint
  suggestions.json  # 2 pending drafts
  meta.json         # the repo record the map and top bar read
  files.json        # source for the file drawer
```

```ts
// src/api/client.ts
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
```

One flag. Every API function checks it and returns mock data with a 400ms delay, so loading states are visible and get built properly rather than being skipped because everything resolves instantly in development.

### Make the mocks realistic

Use paths from the actual demo repo, not `foo.ts` and `bar.ts`. Two reasons: the layout gets tested against real path lengths, which are longer than people expect, and switching to live data will not reshuffle the whole UI.

Include at least one path long enough to need eliding, one file with a very short name, and one answer with five affected routes. Build against the awkward cases, not the tidy ones.

### Switching to live

Flip the flag. If anything breaks, the contract was not followed by one side or the other, and that is a five-minute fix rather than a rebuild. This is the point of the whole arrangement.

### Integration checklist

Walk this list with the backend, in order:

1. Submit a repo, job id returned, polling starts
2. Progress advances through every stage and reaches ready
3. Graph renders from live data at real scale
4. A question returns an answer that renders in the card
5. Source links open the drawer at the right lines
6. Saving a context item persists and reappears on reload
7. A second browser sees the first browser's saved item
8. Export produces markdown
9. Every error path shows a human message, tested by deliberately breaking each one

Step 9 is the one that gets skipped and the one that ruins demos. Deliberately pass a bad repo URL, kill the network mid-query, and request a file that does not exist. Fix what you see.
