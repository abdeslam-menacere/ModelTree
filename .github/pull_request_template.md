<!--
  Opened by `drydock land`? The gate receipt is already below and CI will verify it.
  Opening this by hand? CI will fail. Run the gates and use `drydock land <issue>`.

  Two checklists follow. Fill in the one that matches your change and delete the
  other -- a factual change and a code change are reviewed for different things,
  and one merged list makes both reviews worse. A change that is genuinely both
  keeps both.

  Contributing for the first time? CONTRIBUTING.md explains every field named
  here, and you do not need a pull request to report a correction.
-->

Closes #

## What changed


## Factual changes

<!-- Delete this section if the pull request touches no data. -->

- [ ] Every fact added or altered cites a **primary source** — the creator's own
      announcement, documentation, model card, or repository — through `sourceIds`
- [ ] Every record I touched carries a `verifiedAt` date on which I personally
      re-read that source
- [ ] Anything the source does not state is **left absent** rather than inferred,
      and a partial date stays partial
- [ ] Where sources disagree, the disagreement is recorded rather than resolved
      silently
- [ ] Creator, model, product, and serving platform stay separate records — none
      has been collapsed into another
- [ ] No overall score, rating, or ranking of models is introduced

## Code changes

<!-- Delete this section if the pull request touches no code. -->

- [ ] Behaviour that changed has a test that fails without the change
- [ ] Accessibility holds: keyboard operation and screen-reader labelling are
      unaffected or improved, and any new motion respects `prefers-reduced-motion`
- [ ] No new runtime data fetching — the site stays a static build over versioned
      JSON
- [ ] Asset budgets are unaffected or improved

## Verification

- [ ] `npm run validate` passes from `web/`, and its real output is quoted below

```
paste the output here
```

## Human reviewer checklist

- [ ] The gate receipt below matches this PR's head commit
- [ ] Diff scope matches the issue — nothing unrelated
- [ ] Assumptions in `DOCK.md` are recorded and acceptable
