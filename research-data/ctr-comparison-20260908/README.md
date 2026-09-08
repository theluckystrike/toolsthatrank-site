# CTR comparison source snapshot

Fetched 2026-09-08T03:29:08.279Z from authenticated Google Search Analytics.
The equal consecutive windows are 2026-07-12 through 2026-08-08 and
2026-08-09 through 2026-09-05, inclusive in Pacific Time. Requests use Web
search, final data and byProperty aggregation.

- `data.json` and `data.csv`: 36 properties with impressions in both periods.
- `gsc-harvest.json`: recorded period and daily responses for 38 queried selections.
- `audit.json`: independent integer and exact-rational recomputation of those responses.
- `verification.json`: compact verification summary.
- `sprint-fields.mjs`: measurement adapter; only the local file paths were made portable.

The two zero-count selections are excluded from the displayed cohort. The
zero-count tg.zovo.one prefix overlaps zovo.one; the positive cohort does not
duplicate that coverage. The largest property is selected by combined-period
impressions and removed identically from both periods for a sensitivity check.

These properties belong to one operator. They are not a representative sample
or industry benchmark. Flat and daily routes use the same provider; agreement
checks consistency, not external accuracy. Readers can recompute this snapshot
but cannot authenticate its private source readings without Search Console
access. This repository contains counts, dates and public property identifiers;
it contains no authorization tokens, private keys, query strings or user records.

The original harvest SHA-256 appears in both dataset and audit. `audit.json`
omits only the original machine's absolute rawPath. The adapter rejects data
older than 24 hours for fresh pipeline generation; this published snapshot
remains a historical record. To inspect its fields within that freshness window:

```sh
node --input-type=module -e 'import {fields} from "./sprint-fields.mjs"; for (const f of await fields()) console.log(f.id, await f.primaryFetch())'
```

CTR is computed from summed clicks divided by summed impressions. Display
percentages are rounded; the calculator uses the raw counts. Neither the
exclusion check nor the symmetric click decomposition establishes causation,
statistical significance or a typical property's experience.

## Calculator source snapshot

`calculator-source.js` records the working browser calculator after the claim
review. Its measured presets were filled from the validated field counts in
this dataset. Formatting changes only whitespace and quote style for reading.
It runs in the matching calculator markup, rather than as a standalone Node
program. The page calculates inline and does not fetch this file to run.

The calculator accepts digit-only whole counts up to 1,000,000,000,000 per field.
It rejects strings longer than 64 digits before numeric conversion, including
excessive leading zeros, and never silently truncates a submitted count. These
are locally defined tool limits, not thresholds supplied by Google. The source
shows both checks in `calculate()`. Invalid inputs clear calculated output.

Comparison results use unrounded ratios and display rounded results. The code
also states whether clicks, impressions and CTR rose, fell or stayed unchanged.
The components are descriptive arithmetic, not a causal or significance test.
