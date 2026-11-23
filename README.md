# site-generator-speed-01-entry

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/pattrap-motor/site-generator-speed-01-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/pattrap-motor/site-generator-speed-01-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, entered in [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the output tree makefun-site 1.0.0's `build` returns for the same input — its
front matter, template dialect, Markdown subset, slug rule and report, byte
for byte — only faster. It is written from scratch against makefun-site's
README; `main.ts` is the driver the harness runs, reading every case from
`/input/cases.json` and writing the answers to `/output/answers.json`.

## How it is faster

- Markdown is lexed and rendered in a single fused pass over each body's
  lines, instead of a token list followed by a render pass.
- Inline markup is rendered by one chunk-based scan: runs of plain text are
  copied whole, never escaped character by character.
- `slugify` takes an ASCII fast path (NFKD is the identity on ASCII) and its
  results are memoised per run; tag names and titles repeat constantly.
- Templates are parsed once into compact array nodes and rendered into a
  shared parts array, with null-prototype scope frames so a lookup is a
  direct property read.
- A post's card is built once and reused by its own page render.

Nothing is cached from one case to the next: every `run(input)` starts fresh,
and two executions of the same input are byte-identical.

## Licence

MIT — see [LICENSE](LICENSE).
