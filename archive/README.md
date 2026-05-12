# archive/

This is the v1 orchestrator tree (commits `3287052` through `77bc9bc`, the
"v1.0-v1.2 Wave 3" line of work). It was superseded by `.sandcastle/main.mts`
at commit `eb36044` ("Wave 6.1B").

Kept here for history and pattern reference — in particular,
`recovery/diagnose.ts`'s halt-cause regexes are being ported to
`.sandcastle/lib/diagnose.ts` in Phase 2.

This tree is frozen — not type-checked by any tsconfig, not run by vitest. To
revive any module, copy the file into `.sandcastle/lib/` and fix imports
manually.

Do **not** delete without first confirming nothing in `.sandcastle/lib/` or
`.sandcastle/main.mts` has come to depend on it.
