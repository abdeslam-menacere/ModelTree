# Getting help with ModelTree

ModelTree is a small, source-backed project. There is no support desk, no
service-level promise, and no private channel: everything happens on the
public issue tracker, and a well-described issue is usually the fastest way to
a fix.

## Choose the shortest path

| You want to … | Use |
|---|---|
| Report a wrong or out-of-date fact on the site | [Report incorrect data](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=data-correction.yml) |
| Submit a missing model or release | [Submit a model or release](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=submit-release.yml) |
| Ask "why does the site say X?" | Read the [published methodology](https://abdeslam-menacere.github.io/ModelTree/methodology/); if it does not answer, open a data-correction issue and say so |
| Propose a new feature | [Feature request](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=feature.yml) |
| Report a broken page, keyboard trap, or accessibility problem | The data-correction form is fine — say plainly it is not a factual error |
| Report a security vulnerability | See [SECURITY.md](SECURITY.md) — use private vulnerability reporting, not this tracker |

The correction form on a Model Passport page prefills the record it came
from, which is the fastest way to report a specific fact.

## Before you ask "is this a bug?"

Two things ModelTree does on purpose look like bugs at first:

1. **Blank fields.** A field left blank means *nobody has sourced this yet* —
   deliberately, because a plausible value that no source states is worse
   than an absence. That is the second habit in
   [`CONTRIBUTING.md`](CONTRIBUTING.md#three-habits-that-get-a-contribution-accepted).
2. **Two sources that disagree, both cited.** ModelTree records the
   disagreement rather than averaging or quietly preferring one. See the same
   section of `CONTRIBUTING.md`.

If the answer surprises you and is *not* one of those two, an issue is
welcome.

## What we do not do here

- No overall score, rating, or universal ranking of models. Requests to add
  one are declined on principle, not on quality — the reasoning is in
  [`CONTRIBUTING.md`](CONTRIBUTING.md#two-things-modeltree-will-not-accept).
- No live API monitoring, no benchmark reruns, no user accounts.
- No email, Slack, or Discord support channel — the tracker is the record.

## Response cadence

Best effort. Reports that cite a primary source and quote the sentence that
supports the change are the fastest to act on, because there is nothing left
to research. A report that sits for a while has not been rejected.

## License

Contributions are covered by the repository's [MIT LICENSE](LICENSE).
