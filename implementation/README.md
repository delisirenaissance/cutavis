# cutavis — pattern prototype

Frontend prototype for the cutavis platform: parse measurement **formulas**
(values supplied by the user) and render the resulting pattern as **SVG**.
Implements **Phase 1 (variables → part → SVG)** and **Phase 3 (SVG editor)**
from `../projectplan/arch.drawio`.

## Stack

- **Next.js 14** (App Router) + **TypeScript**
- **expr-eval** — safe math parser (no `eval` / `Function` on user input)
- React renders the SVG directly

## Run

```bash
npm install
npm run dev      # http://localhost:3000
```

## How it works

- `lib/types.ts` — `PartDef` (named `points`, each `[xFormula, yFormula]`; and
  `lines`, each a cubic-Bézier segment via 4 point references) and
  `Measurements` (`{ margin: 4, width: 30, ... }`). Mirrors the diagram.
- `lib/geometry.ts` — evaluates every formula against the measurements,
  auto-detects referenced variables, and emits SVG path data. Errors are
  collected per-field so partial results still render while editing.
- `app/page.tsx` — measurements form (inputs auto-derived from the formulas) +
  live JSON part editor.
- `components/PatternSvg.tsx` — auto-fits the viewBox to the geometry.

### Gotcha handled: built-in name collisions

expr-eval defines built-ins like `length`, `sin`, `min`, `E`, `PI` (some as
unary operators). Since `length` is a very common measurement name, the engine
strips any built-in that collides with a user variable, so **user variable
names always win** — while non-colliding functions (e.g. `sqrt`) stay usable in
formulas.

## Note on building inside Google Drive

`npm run build` can hit `EPERM` / hang because Google Drive locks files in
`.next/`. `npm run dev` is unaffected. For production builds, pause Drive sync
or copy the project to a local (non-synced) path first.
