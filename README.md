# Build a static site faster — site-generator-speed-01-run-20261122

[![make.fun — site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Rahullpc/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Rahullpc/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster drop-in for makefun-site 1.0.0, the reference static site generator.

## What it is

`solve.js` is a self-contained, dependency-free ES module that exports `run(input)` and returns the same output tree — byte for byte — as makefun-site 1.0.0, but faster. `main.ts` is the harness program: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`. `package.json` marks the root as an ES module.

## How it is faster

- Markdown is rendered in a single fused pass (no token array): lines are split once and blocks are rendered as they are scanned.
- Inline markup is rendered by one scanner that batches literal runs and escapes each run with a single native replace, instead of escaping character by character.
- Word counting is a manual scan (no match array) with an ASCII fast path; slugs are memoised within one run and take an ASCII fast path; each page's card is built once and reused by the index, the tag pages and the page itself.
- Templates are parsed once per case and interpreted with one frame per `for` execution, rewritten in place across iterations instead of allocating a scope per item.
- Front matter is located with `indexOf` (no full split of the body) and parsed from the small front-matter region only.
- Nothing is cached from one case to the next: every case is answered alone, as the rules require.

## Results

Byte-exact on all 3 practice cases, and on 6 further cases drawn from two different generator seeds (a generalisation check — the final set is drawn from a different drand round, so the implementation is general, not fitted to the practice set).

CPU time, median of 11 repetitions per case (Node 24, this machine):

| case | mine | baseline (makefun-site 1.0.0) | speedup |
| --- | --- | --- | --- |
| g-0001 | 51.1 ms | 148.1 ms | 2.90x |
| g-0002 | 64.4 ms | 238.7 ms | 3.71x |
| g-0003 | 68.9 ms | 286.9 ms | 4.16x |
| **total** | **184.4 ms** | **673.7 ms** | **3.65x** |

## Run

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

Node 22+, no dependencies, no install step, no network.
