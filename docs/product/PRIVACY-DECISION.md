# ModelTree Privacy Decision

**Decision:** ModelTree collects nothing about its visitors.
**Recorded:** 2026-09-02.
**Owner:** [@abdeslam-menacere](https://github.com/abdeslam-menacere).

This document formalises a posture that has been in place since the site
launched but was previously only implicit — recorded as a single sentence in
[`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md), *"Until privacy-conscious analytics
are approved, success is assessed through release readiness"*, and enforced by
the fact that no measurement code was ever added. The launch-readiness issue
requires a privacy decision before any analytics; this file is that decision,
with a date, and it is the record any future proposal has to move.

## What is not collected

The published site at `https://abdeslam-menacere.github.io/ModelTree/`
carries:

- **No analytics.** No Google Analytics, no Plausible, no Fathom, no
  self-hosted counter, no server-side page-view aggregation. There is nothing
  to collect page views on.
- **No cookies.** No first-party cookies, no third-party cookies, no
  `localStorage` or `sessionStorage` writes for measurement. URL state
  (filters, selected model, comparison set) lives in the address bar, not in
  storage.
- **No tracking pixels, beacons, or fingerprinting.** No 1×1 images, no
  `navigator.sendBeacon`, no canvas or font probing.
- **No third-party scripts loaded for measurement.** The only third-party
  requests the site makes are for the static assets it builds against
  (fonts, and only the ones self-hosted via `@fontsource-variable/*`, which
  ship with the site rather than being loaded from a CDN).
- **No client-side error reporting service.** The browser console is the
  channel.
- **No user accounts, no login, no session.**

This is not an accident of the current implementation. It is the intended
posture, and it is what the tests below hold.

## What GitHub Pages still sees

We do not operate the origin. GitHub serves `github.io`, and GitHub's own
privacy policy governs what its infrastructure records (typically an HTTP
access log with an IP address, a User-Agent string, and a request path,
retained per their policy). That is outside the reach of this document and
outside our control, and it is worth naming because a visitor might otherwise
read *"ModelTree collects nothing"* as *"no one collects anything about my
visit"*. The second is not a claim we can make.

If avoiding server-side access logs matters, a client that does not identify
itself (for example, a shared exit IP, or a general-purpose proxy) is the
mitigation available to a visitor. We cannot add one on the origin.

## Why this posture

Three reasons, each independent:

1. **The audience.** ModelTree is a reference for people who are already
   sceptical about how AI products handle data. A site that measures its
   visitors' behaviour to improve itself would be modelling the wrong thing.
2. **The architecture.** The site is a static build with no server the
   project operates. Adding measurement would introduce a runtime data flow
   that
   [ADR 0001 — Static-first architecture](../adr/0001-static-first-architecture.md)
   deliberately excludes. Reversing that exclusion is more expensive than
   most measurement proposals are worth.
3. **The alternative is cheap.** Success signals ModelTree actually cares
   about — source coverage, data freshness, accessibility, performance
   budgets, accepted corrections — are counted from the repository itself,
   not from visitor behaviour. Those are the signals
   [`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md) already names.

## What would have to change to reverse this

This decision is not permanent, but it is not casual either. Reversing it
requires *all* of the following, in order, and each is separately blocking:

1. **Explicit owner approval**, recorded in the same pull request that
   proposes the change, on the issue that proposes it. The owner is the sole
   party who can approve this; a reviewer verdict cannot substitute.
2. **A new ADR under [`docs/adr/`](../adr/)** that states the concrete
   measurement (which tool, which events, which retention, which processor,
   what the alternative to it would be) and its consequences, and that
   explicitly supersedes or amends the relevant lines of
   [ADR 0001](../adr/0001-static-first-architecture.md) if a runtime data
   flow is being introduced. Naming the tool matters: "we might add
   analytics" is not a decision worth landing an ADR for.
3. **A visible disclosure on the site itself** — a `/privacy` page or its
   equivalent — before any measurement code ships. Not after.
4. **A revision to this document** recording the reversal date, the ADR
   number, the pull request, and what specifically is now collected. This
   file remains the canonical record.
5. **Cookie consent, only if cookies are actually set.** No consent banner
   for a site that sets no cookies; the banner is not a virtue on its own,
   and adding one where it is not required is measurement of consent that
   was itself unmeasured.

A measurement proposal that would meet all five is welcome. One that would
not is a data problem, not a privacy problem, and should be reframed —
usually as a repository-side signal instead.

## What holds this document honest

The rule that keeps this document honest is not a test. It is the site's
architecture, recorded in
[ADR 0001](../adr/0001-static-first-architecture.md): the build declares
`output: 'static'` in [`web/astro.config.mjs`](../../web/astro.config.mjs),
every route under [`web/src/pages/`](../../web/src/pages/) exports
`prerender = true`, and the build emits HTML, CSS, JS islands, and a small
set of prerendered text and XML artefacts. There is no origin the site
operates, no session for a cookie to belong to, and no build hook that
would inject a measurement script.

`npm run validate` does **not** search the code for a runtime fetch, an
analytics import, or a `document.cookie` write. If a change introduced any
of those, the signal would be an ADR that had to change to accommodate it,
or a review comment; not a red test. If that architectural posture stops
holding — if a route stops being prerendered, or the build gains a runtime
data flow — this document is wrong until it is updated.

## History

| Date | Change |
|---|---|
| 2026-09-02 | First recorded, formalising the sentence in `PRODUCT-BRIEF.md`. No behaviour changed. |
