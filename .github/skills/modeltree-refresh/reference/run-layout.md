# Run state layout

Everything a refresh writes that is **not** repository data lives under
`.modeltree-refresh/runs/<run-id>/`. That directory is git-ignored. Nothing in it
is ever committed, and no gate reads from it except by explicit `--claims` path.

Run id: `YYYY-MM-DD-<6 hex>` — sortable, and unique when a day has two runs.

```
.modeltree-refresh/runs/2026-08-25-a3f19c/
  bundle.json          the claim bundle: scout writes claims, review adds verdicts
  gate-evidence.json   --json output of the evidence gate
  gate-dataset.json    --json output of the dataset gate
  gate-scope.json      --json output of the scope gate
  validate.log         captured output of `npm run validate`
  pr-body.md           the pull request body, passed with --body-file
  issue-body.md        the summary issue body
  pages.json           the Pages deployment run, as reported by gh
```

## Why on disk rather than in context

A run touches many creators and many pages. Holding every quote and every verdict
in the conversation invites summarisation, and a summarised quote is no longer
evidence — the content hash stops matching the text beside it. Writing each stage
to a file and passing paths keeps the evidence byte-exact from fetch to pull
request.

It also makes a failed run inspectable. If a refresh stops at the scope gate, the
bundle and every verdict are still sitting there to read.

## Lifecycle

Directories are not cleaned up automatically. A run that finished successfully
can be deleted freely; its content is preserved in the pull request body and the
summary issue, which are the durable record. Keep failed runs until the reason
they failed has been dealt with.

The bundle format itself is specified in
[`../../modeltree-gates/reference/claim-bundle.md`](../../modeltree-gates/reference/claim-bundle.md).
