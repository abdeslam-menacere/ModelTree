# ADR 0004: SHA-1 Lockfile Integrity Is a Mirror Constraint, Not a Choice

- Status: Accepted
- Date: 2026-08-25
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It records a property of the build environment that
  `web-ci` depends on, and it neither narrows nor widens the invariant stated in
  `.github/copilot-instructions.md` §"The invariant". It does not modify ADR 0003;
  it describes a pre-existing condition of the required check that ADR 0003
  relies on.

## Context

Every dependency of the site build resolves through an Azure DevOps `1es-public`
mirror, and not one carries a SHA-512 integrity hash. Measured against
`web/package-lock.json` at `090f674`:

```
"resolved" entries                                493
  ... pointing at registry.npmjs.org                0
  ... pointing at *.pkgs.visualstudio.com          493
"integrity": "sha512-...                            0
"integrity": "sha1-...                            493
"libc" selectors (22 glibc, 12 musl)               34
```

The 493 are sharded across four hosts — `ms-feed-2`, `ms-feed-12`, `ms-feed-17`,
`ms-feed-25`, all `.pkgs.visualstudio.com/1es-public/_packaging/npm-public`.

This matters because `.github/workflows/web-ci.yml` runs `npm ci`, which verifies
each tarball against `integrity`; `web-ci` is the only required status check on
`main`; `allow_auto_merge` is on; and ADR 0003 permits a dataset refresh to reach
the public site through exactly that check. npm's default integrity has been
`sha512-` for years. Nothing in this repository stated that it is not, and
nothing checked.

### Why the lockfile points at the mirror

Nothing in the repository selects it. There is no `.npmrc` anywhere in the tree,
tracked or untracked; no workflow sets `registry-url` on `actions/setup-node`;
and no documentation mentions a registry. The mirror URLs were present in the
lockfile's **first** commit — `53c4270`, 2026-08-15, 445 of 445 entries already
on the mirror and already `sha1-` — and every revision since
(`aa86dcb` 447/447, `2738448` 493/493, `6ae84bc` 493/493). There was never a
`registry.npmjs.org` phase that something later migrated away from.

The mechanism is outside the repository. On a machine where these agents run,
`npm config get registry` returns `https://packagefeedproxy.microsoft.io/npm/`,
set by a machine-global `C:\Program Files\nodejs\etc\npmrc` — not by any file
under version control. That proxy returns tarball URLs on the `ms-feed-N`
`1es-public` hosts, which is precisely the URL shape recorded as `resolved`.

So the lockfile records **where `npm install` last ran**, not a decision this
repository made. That the *mechanism* is an artefact is established by the
evidence above. Whether the maintainer nonetheless *intends* to depend on the
mirror is not determinable from the repository, and they were unavailable to
confirm it. **Assumption, explicitly labelled and unverified:** the mirror is
incidental rather than a policy the maintainer requires. This ADR is written so
that it holds either way — it records the constraint and forbids silent change,
which is correct under both readings.

### Whether SHA-1 is forced by the mirror or is a client-side artefact

This was tested rather than reasoned about, because it decides whether the
lockfile can be improved at all.

npm derives `integrity` from the packument's `dist` object. The mirror's `dist`
contains **only `shasum` and `tarball`. There is no `integrity` field at all.**
Checked on all four feed hosts and on the proxy in front of them, for scoped and
unscoped packages, in both the full packument and the abbreviated
(`application/vnd.npm.install-v1+json`) form npm actually requests — the mirror
ignores that `Accept` header and answers with its own Azure DevOps document
either way:

```
ms-feed-17  @asamuzakjp/css-color@5.1.11  dist keys: [shasum,tarball]  integrity: <ABSENT>
ms-feed-2   astro@7.2.2                   dist keys: [shasum,tarball]  integrity: <ABSENT>
ms-feed-12  vitest@5.0.0-rc.2             dist keys: [shasum,tarball]  integrity: <ABSENT>
ms-feed-25  zod@4.4.3                     dist keys: [shasum,tarball]  integrity: <ABSENT>
```

When `dist.integrity` is absent and `dist.shasum` present, npm falls back to
`sha1-<base64 of the hex shasum>`. That fallback accounts for the lockfile
exactly, byte for byte:

```
mirror dist.shasum (hex) : 28a0aac8220a4cc19045ac3bd9a813d4060bd375
base64 of those bytes    : sha1-KKCqyCIKTMGQRaw72agT1AYL03U=
lockfile integrity       : sha1-KKCqyCIKTMGQRaw72agT1AYL03U=
```

**The answer to the question the issue said decides everything: SHA-1 is forced
by the mirror.** It is not a client-side artefact, not a stale-cache effect, and
not a symptom of old packages. No npm flag, cache clear, or lockfile
regeneration can produce `sha512-` from a feed that never publishes it.

What could not be measured from here: `registry.npmjs.org` is unreachable in this
environment — the TLS handshake is refused outright, by both PowerShell
(`Could not create SSL/TLS secure channel`) and `curl` (`schannel: ...
SEC_E_ILLEGAL_MESSAGE`, HTTP 000). So the upstream `sha512` values were **not**
retrieved and are not quoted anywhere in this ADR. That gap does not affect the
decision, which rests only on what the mirror serves.

### A second finding: the shard host is not stable

The `ms-feed-N` host is assigned per request, not per package. Asking the proxy
today for the exact versions the lockfile pins returns a different host for most
of them:

```
@asamuzakjp/css-color v5.1.11   lock=ms-feed-17  proxy=ms-feed-17  same
zod                   v4.4.3    lock=ms-feed-17  proxy=ms-feed-12  DIFFERS
astro                 v7.2.0    lock=ms-feed-17  proxy=ms-feed-2   DIFFERS
vitest                v4.1.10   lock=ms-feed-25  proxy=ms-feed-2   DIFFERS
yaml                  v2.9.0    lock=ms-feed-25  proxy=ms-feed-17  DIFFERS
nanoid                v3.3.18   lock=ms-feed-25  proxy=ms-feed-25  same
```

This explains the churn reported by the #98 dock, where adding one devDependency
produced a 107-line lockfile diff including a rewritten `resolved` URL. That was
not npm being capricious: a load balancer had moved the package. It also means a
lockfile regenerated in this environment is not reproducible even *within* this
environment — the URLs are non-deterministic by construction, which is the
strongest available evidence that embedding them was never a deliberate choice.

## Decision

**SHA-1 integrity in `web/package-lock.json` is a known and accepted consequence
of resolving through the `1es-public` mirror. It is recorded here rather than
fixed, because it cannot be fixed without changing registries.**

Concretely:

- The lockfile is **not** regenerated. A regeneration in a mirror-configured
  environment reproduces `sha1-` for all 493 entries — the mirror serves no
  `sha512` to record — while rewriting shard hosts and, on npm 11.9.0, stripping
  `libc` selectors. It is pure cost.
- Integrity values are **not** hand-computed from downloaded tarballs. This is
  the option that superficially looks like a fix, and it is worse than doing
  nothing. A SHA-512 computed from a tarball fetched *through the mirror*
  attests to what the mirror served, not to what the publisher published, so it
  provides no protection whatsoever against the threat that motivates wanting
  SHA-512 in the first place. It would also be unreproducible: the next
  `npm install` anyone runs against this feed reverts all 493 to `sha1-`.
- The registry is **not** changed. That is a larger decision with its own
  consequences, it was explicitly out of scope for the issue that produced this
  ADR, and it cannot even be validated from this environment, where
  `registry.npmjs.org` is unreachable.

The defect this ADR closes is the one that was actually closable: an
undocumented, unchosen, materially weaker configuration was load-bearing. It is
now documented and chosen. The weaker configuration remains.

## Consequences

### Positive

- The `sha1-` integrity is no longer a silent property that a future contributor
  must rediscover by reading 493 lockfile entries, and a future reviewer seeing
  it has a document to check it against.
- The next person who gets a large spurious lockfile diff has the explanation and
  the precedent for handling it, instead of concluding npm is broken.
- Nothing about the dependency tree changes, so the risk of this ADR to `web-ci`
  — the only required check on `main` — is zero. `npm ci` and `npm run validate`
  are unaffected because no input to them was touched.
- The non-reproducibility finding is recorded with evidence, which is what turns
  "npm rewrote a URL again" from a recurring mystery into a known constraint.

### Costs

- **Tamper detection for the whole dependency tree continues to rest on SHA-1**,
  and this ADR does not improve that by one bit. It makes the weakness official,
  which is better than unnoticed and is not the same as fixed.
- **The precise residual risk, stated honestly in both directions.** SHA-1's
  broken property is *collision* resistance (SHAttered, 2017): an attacker who
  controls what gets published can craft two artefacts with the same hash. Its
  *second-preimage* resistance — crafting a malicious tarball matching the hash
  of an already-published benign one — is not known to be broken, and that is the
  property the mirror-compromise scenario would actually need. So the realistic
  exposure is narrower than "SHA-1 is broken" suggests. It is also not zero, it
  is strictly worse than npm's own default, and the margin is the kind that
  erodes with cryptanalysis rather than improving. Neither overstate this nor
  wave it away.
- **`npm ci` verifying successfully proves less than it appears to.** It confirms
  each tarball matches the SHA-1 the mirror published for it. A mirror serving
  consistent bad data satisfies that check completely. The check is not
  independent of the party it is checking.
- **The lockfile remains specific to the environment that produced it.** A
  contributor on a default npm registry who runs `npm install` will get a
  full-tree diff, and a real change hides inside that noise. This ADR documents
  the trap; it does not remove it.
- **npm 11.9.0 strips `libc` selectors on rewrite**, and those 34 selectors (22
  `glibc`, 12 `musl`) drive binary selection on glibc versus musl runners. Any
  future lockfile operation has to be checked for this by hand, because nothing
  in CI asserts the selectors survive. That is a real, recurring maintenance tax
  this ADR accepts rather than solves.
- **The evidence here has a shelf life.** It describes a third-party feed's
  behaviour on 2026-08-25. If the mirror starts publishing `dist.integrity`, this
  ADR silently becomes wrong, and nothing will notice — no test asserts any of it,
  and adding one would mean a network call in CI against a feed whose
  availability is not this repository's to depend on.
- **This ADR is documentation, and documentation is not a control.** It changes
  no behaviour and no check. Its entire value is that the next person reads it.

## Alternatives Considered

- **Regenerate the lockfile so integrity becomes `sha512-`.** This was the
  issue's preferred outcome and it is not available. Tested, not assumed: the
  mirror publishes no `sha512` for any package on any of its four hosts, in
  either packument form, so a regeneration produces `sha1-` again. It would also
  churn shard hosts and risk the `libc` selectors. Rejected on evidence.
- **Compute SHA-512 from the tarballs and write the 493 entries by hand.**
  Rejected for the reason in the Decision: a hash computed from bytes the mirror
  served attests to the mirror, not to the publisher, so it buys no tamper
  detection against the only threat in question while producing a 493-entry
  hand-edited lockfile that the next `npm install` silently reverts. A fix that
  looks like security and provides none is worse than a documented gap, because
  it stops people asking.
- **Point the repository at `registry.npmjs.org` with a committed `.npmrc`.**
  The real fix, and out of scope here. It would restore `sha512-` and
  deterministic URLs, at the cost of a 493-entry lockfile diff and a dependency
  on egress that this environment does not have — `registry.npmjs.org` is TLS-
  blocked here, so the change could not be validated by whoever made it. It needs
  the maintainer's input on which registry their environment permits. Left as a
  follow-up rather than decided unilaterally.
- **Commit an `.npmrc` pinning the `1es-public` mirror**, making the artefact
  into policy. Rejected. It would freeze a load-balanced, non-deterministic host
  set into version control and make a Microsoft-internal feed a hard dependency of
  every contributor's checkout — a materially larger commitment than the accident
  it would be ratifying, and one only the maintainer can make.
- **Do nothing.** Rejected: an unstated, unchosen weakening of the default
  security posture of the only required check on `main` is exactly the class of
  defect this program exists to surface. The configuration is not the defect this
  issue could close; the silence was.

## Guardrails

- **Do not hand-write or hand-patch `integrity` values in
  `web/package-lock.json`.** Not to upgrade them to `sha512-`, not to "fix" a
  mismatch. An integrity value must be one npm recorded from a registry.
- **Do not regenerate the lockfile to try to obtain `sha512-` integrity.** Re-run
  the probe in this ADR's Context first. If the mirror still omits
  `dist.integrity`, regeneration cannot succeed and will cost shard churn and
  possibly the `libc` selectors.
- **Preserve the `libc` selectors.** After any command that rewrites the
  lockfile, diff for dropped `"libc": ["glibc"]` / `["musl"]` entries — npm
  11.9.0 removes them — and restore any that were lost. There are 34 today.
- **A lockfile change rides in its own commit, never alongside a dependency or
  feature change.** The noise is exactly where a real change hides.
- **Changing the registry is a maintainer decision and its own ADR**, not a
  side-effect of a dependency bump. Expect a full-tree diff and treat a
  registry-driven `resolved`/`integrity` rewrite as the entire content of that
  change.
- **Do not cite `npm ci` succeeding as evidence that dependencies are
  untampered.** It proves consistency with the mirror, which is the party being
  trusted, not an independent check on it.
- **Re-verify before relying on this ADR's measurements.** They are a third
  party's behaviour on a stated date, and nothing in CI will tell you when they
  stop being true.
