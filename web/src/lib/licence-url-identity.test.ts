import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import {
  LICENCE_ABSTENTION_REASONS,
  LICENCE_VERDICTS,
  buildFinalUrlIndex,
  buildLicenceCoverage,
  buildLicenceIdentityReport,
  classifyLicenceIdentity,
  finalUrlKey,
  renderLicenceIdentityMarkdown,
  type LicenceAbstentionReason,
  type LicenceIdentityInput,
  type LicenceVerdict,
} from './licence-url-identity';

/**
 * The corpus that proves the classifier can reach every outcome it declares.
 *
 * #1057's first required property is that the classifier "must be able to emit
 * every outcome it defines -- agree, disagree, and each abstention reason -- and
 * you must prove it with tests". The proof is structural rather than anecdotal:
 * this array is reduced to the *set of outcomes actually observed*, and that set
 * is asserted equal to the declared sets. A declared value with no input that
 * produces it therefore fails the suite, and so does an input producing an
 * outcome nobody declared.
 */
const CORPUS: readonly { readonly name: string; readonly input: LicenceIdentityInput }[] = [
  {
    name: 'canonical Apache URL matching its spdxId',
    input: { spdxId: 'Apache-2.0', recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
  },
  {
    name: 'canonical OSI MIT URL matching its spdxId',
    input: { spdxId: 'MIT', recordedUrl: 'https://opensource.org/license/mit' },
  },
  {
    name: 'the historical shape: an Apache document cited by a record asserting MIT',
    input: { spdxId: 'MIT', recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
  },
  {
    name: 'a record with a URL and no spdxId',
    input: { recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
  },
  { name: 'a record with an spdxId and no URL', input: { spdxId: 'Apache-2.0' } },
  { name: 'a record asserting neither an spdxId nor a URL', input: {} },
  { name: 'a recorded URL that is not a URL', input: { spdxId: 'MIT', recordedUrl: 'not a url' } },
  {
    name: 'a supplied final URL that is not a URL',
    input: { spdxId: 'MIT', recordedUrl: 'https://opensource.org/license/mit', finalUrl: '::::' },
  },
  {
    name: 'a Hugging Face model landing page',
    input: { spdxId: 'MIT', recordedUrl: 'https://huggingface.co/XiaomiMiMo/MiMo-7B-RL-0530' },
  },
  {
    name: 'a file inside a repository',
    input: { spdxId: 'MIT', recordedUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/main/LICENSE' },
  },
  {
    name: 'a path the Apache Software Foundation does not publish a licence at',
    input: { spdxId: 'Apache-2.0', recordedUrl: 'https://www.apache.org/foundation/policies/conduct' },
  },
  {
    name: 'a host that is not in the identity table',
    input: { spdxId: 'Apache-2.0', recordedUrl: 'https://example.invalid/licence' },
  },
];

function observedOutcomes(): { verdicts: Set<LicenceVerdict>; reasons: Set<LicenceAbstentionReason> } {
  const verdicts = new Set<LicenceVerdict>();
  const reasons = new Set<LicenceAbstentionReason>();
  for (const entry of CORPUS) {
    const result = classifyLicenceIdentity(entry.input);
    verdicts.add(result.verdict);
    if (result.reason !== null) reasons.add(result.reason);
  }
  return { verdicts, reasons };
}

describe('classifyLicenceIdentity: every declared outcome is emittable', () => {
  it('reaches every declared verdict, disagreement included', () => {
    const { verdicts } = observedOutcomes();
    expect([...verdicts].sort()).toEqual([...LICENCE_VERDICTS].sort());
    // Named separately, because this is the one that matters. A comparator that
    // has never been shown to disagree is not a comparator, and a clean run over
    // the dataset is worth nothing unless the instrument has been demonstrated
    // to read the other way.
    expect(verdicts.has('disagrees')).toBe(true);
  });

  it('reaches every declared abstention reason', () => {
    const { reasons } = observedOutcomes();
    expect([...reasons].sort()).toEqual([...LICENCE_ABSTENTION_REASONS].sort());
  });

  it('declares no verdict or reason that no input can produce', () => {
    const { verdicts, reasons } = observedOutcomes();
    for (const verdict of LICENCE_VERDICTS) expect(verdicts.has(verdict)).toBe(true);
    for (const reason of LICENCE_ABSTENTION_REASONS) expect(reasons.has(reason)).toBe(true);
  });
});

describe('classifyLicenceIdentity: adjudication', () => {
  it('agrees when a canonical URL is the licence the record asserts', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0' }),
    ).toMatchObject({ verdict: 'agrees', reason: null, identifiedSpdxId: 'Apache-2.0', identifiedFrom: 'recorded-url' });
  });

  it('disagrees when a canonical URL is a different licence from the one asserted', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' }),
    ).toMatchObject({ verdict: 'disagrees', reason: null, identifiedSpdxId: 'Apache-2.0' });
  });

  it('disagrees on a versioned mismatch within one publisher', () => {
    // Apache-1.1 and Apache-2.0 are different licences, and the difference is a
    // path segment. A comparator that only separated publishers would miss this.
    expect(
      classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: 'https://www.apache.org/licenses/LICENSE-1.1' }),
    ).toMatchObject({ verdict: 'disagrees', identifiedSpdxId: 'Apache-1.1' });
  });

  it('treats SPDX ids case-insensitively rather than reporting a case difference as a disagreement', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'apache-2.0', recordedUrl: 'https://www.apache.org/licenses/LICENSE-2.0' })
        .verdict,
    ).toBe('agrees');
    expect(
      classifyLicenceIdentity({ spdxId: 'mit', recordedUrl: 'https://opensource.org/license/mit' }).verdict,
    ).toBe('agrees');
  });

  it('reads www. and a trailing slash as the same canonical URL', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: 'https://apache.org/licenses/LICENSE-2.0/' })
        .verdict,
    ).toBe('agrees');
  });

  it('accepts the legacy OSI /licenses/<id> path as well as the current slug', () => {
    expect(classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://opensource.org/licenses/MIT' })).toMatchObject(
      { verdict: 'agrees', identifiedSpdxId: 'MIT' },
    );
  });
});

describe('classifyLicenceIdentity: finalUrl is the sharper input', () => {
  const RECORDED = 'https://www.apache.org/licenses/LICENSE-2.0.txt';

  it('classifies the URL the request landed on, not the one the record cites', () => {
    // The failure this whole issue was filed about: the record still cites a
    // canonical Apache URL, and the server now serves the MIT licence from it.
    // A reachability sweep sees 200 and reports OK.
    const result = classifyLicenceIdentity({
      spdxId: 'Apache-2.0',
      recordedUrl: RECORDED,
      finalUrl: 'https://opensource.org/license/mit',
    });
    expect(result).toMatchObject({
      verdict: 'disagrees',
      identifiedSpdxId: 'MIT',
      identifiedFrom: 'final-url',
      redirected: true,
    });
  });

  it('agrees when the redirect lands on an equivalent canonical URL', () => {
    const result = classifyLicenceIdentity({
      spdxId: 'Apache-2.0',
      recordedUrl: RECORDED,
      finalUrl: 'https://www.apache.org/licenses/LICENSE-2.0.html',
    });
    expect(result).toMatchObject({ verdict: 'agrees', identifiedFrom: 'final-url', redirected: true });
  });

  it('reports no redirect when the request landed where it was aimed', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: RECORDED, finalUrl: RECORDED }),
    ).toMatchObject({ verdict: 'agrees', identifiedFrom: 'final-url', redirected: false });
  });

  it('fails toward cannot-determine, never toward correct, when the landing URL is unidentifiable', () => {
    // The recorded URL alone would adjudicate this `agrees`. It must not: a
    // fetch that succeeded but whose target cannot be classified is not
    // evidence of agreement.
    const result = classifyLicenceIdentity({
      spdxId: 'Apache-2.0',
      recordedUrl: RECORDED,
      finalUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM3-3B',
    });
    expect(result.verdict).toBe('cannot-determine');
    expect(result.reason).toBe('model-landing-page');
    expect(result.identifiedFrom).toBe('final-url');
    expect(result.redirected).toBe(true);
  });

  it('abstains rather than falling back when a supplied finalUrl is malformed', () => {
    const result = classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: RECORDED, finalUrl: 'http://' });
    expect(result).toMatchObject({ verdict: 'cannot-determine', reason: 'malformed-final-url' });
  });

  it('separates "no fetch was supplied" from "fetched and did not redirect"', () => {
    const unfetched = classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: RECORDED });
    const fetched = classifyLicenceIdentity({ spdxId: 'Apache-2.0', recordedUrl: RECORDED, finalUrl: RECORDED });
    expect(unfetched.verdict).toBe(fetched.verdict);
    // Same verdict, different provenance -- which is the whole point. ADR 0018:
    // not-looked and looked-and-found-nothing stay separately representable.
    expect(unfetched.identifiedFrom).toBe('recorded-url');
    expect(fetched.identifiedFrom).toBe('final-url');
  });
});

describe('classifyLicenceIdentity: abstention reasons name the structure, not the failure', () => {
  it('names a missing spdxId rather than the host, when there is nothing to contradict', () => {
    expect(classifyLicenceIdentity({ recordedUrl: 'https://example.invalid/licence' }).reason).toBe('no-spdx-id');
  });

  it('names a missing URL for the population the sweep never sees', () => {
    expect(classifyLicenceIdentity({ spdxId: 'Apache-2.0' }).reason).toBe('no-licence-url');
  });

  it('separates a record asserting neither field from one asserting an spdxId', () => {
    // Both abstain, and both once reported `no-licence-url` -- whose prose says
    // the record "asserts an `spdxId`", which is false of a record that asserts
    // nothing. Read both arms in the same run and require them to come back
    // DIFFERING: one arm returning the value somebody had in mind shows nothing,
    // and the conflation this replaces was pinned by an assertion that only ever
    // looked at one of the two populations at a time.
    const neither = classifyLicenceIdentity({}).reason;
    const spdxOnly = classifyLicenceIdentity({ spdxId: 'Apache-2.0' }).reason;
    expect(neither).toBe('no-licence-fields');
    expect(spdxOnly).toBe('no-licence-url');
    expect(neither).not.toBe(spdxOnly);
  });

  it('reads an empty string as an absent field, on both fields at once', () => {
    // The classifier tests `.length === 0` as well as `undefined`, so a record
    // carrying empty strings is the same population as one carrying nothing.
    expect(classifyLicenceIdentity({ spdxId: '', recordedUrl: '' }).reason).toBe('no-licence-fields');
  });

  it('separates a model landing page from a file inside a repository', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://huggingface.co/XiaomiMiMo/MiMo-7B-RL-0530' })
        .reason,
    ).toBe('model-landing-page');
    expect(
      classifyLicenceIdentity({
        spdxId: 'Apache-2.0',
        recordedUrl: 'https://github.com/01-ai/Yi/blob/main/LICENSE',
      }).reason,
    ).toBe('repository-hosted-document');
  });

  it('reads a raw-content host as a document even though its paths carry no /blob/ marker', () => {
    // Regression. A marker-only rule read `/MiniMax-AI/MiniMax-M1/main/LICENSE`
    // as a landing page, because `raw.githubusercontent.com` has no `/blob/` in
    // its paths -- and it has no landing pages at all, so that classification
    // could never be right. Two real records take this shape.
    expect(
      classifyLicenceIdentity({
        spdxId: 'Apache-2.0',
        recordedUrl: 'https://raw.githubusercontent.com/MiniMax-AI/MiniMax-M1/main/LICENSE',
      }).reason,
    ).toBe('repository-hosted-document');
    // CONTROL: two path segments on the same host is still a document, not a
    // landing page -- so the rule is keyed on the host's shape, not on depth.
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://raw.githubusercontent.com/owner/repo' }).reason,
    ).toBe('repository-hosted-document');
  });

  it('refuses to call an organisation page a model landing page', () => {
    // Shorter than `/{owner}/{repo}`. Naming it either a model or a document
    // would be a false classification rather than a coarse one.
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://huggingface.co/deepseek-ai' }).reason,
    ).toBe('unrecognised-path-on-known-host');
    // CONTROL: one segment deeper, on the same host, is a landing page.
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V3.2' })
        .reason,
    ).toBe('model-landing-page');
  });

  it('reads a deep repository path as a document even without a marker segment', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://github.com/owner/repo/releases/latest' }).reason,
    ).toBe('repository-hosted-document');
  });

  it('separates an unknown path on a canonical host from an unknown host', () => {
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://opensource.org/license/zzz-not-a-licence' })
        .reason,
    ).toBe('unrecognised-path-on-known-host');
    expect(
      classifyLicenceIdentity({ spdxId: 'MIT', recordedUrl: 'https://licences.invalid/mit' }).reason,
    ).toBe('unrecognised-host');
  });

  it('carries no identified licence on any abstention', () => {
    for (const entry of CORPUS) {
      const result = classifyLicenceIdentity(entry.input);
      if (result.verdict !== 'cannot-determine') continue;
      expect(result.identifiedSpdxId, entry.name).toBeNull();
      expect(result.reason, entry.name).not.toBeNull();
    }
  });

  it('carries no reason on any adjudicated verdict', () => {
    for (const entry of CORPUS) {
      const result = classifyLicenceIdentity(entry.input);
      if (result.verdict === 'cannot-determine') continue;
      expect(result.reason, entry.name).toBeNull();
      expect(result.identifiedSpdxId, entry.name).not.toBeNull();
    }
  });
});

describe('buildLicenceCoverage: derived, never declared', () => {
  const coverage = buildLicenceCoverage(dataset.releases);

  // Relations, not literals. #1006, #997 and #941 were all pinned figures that
  // went stale on the next release added; these hold for any dataset.
  it('splits the swept population exactly into checkable and not-checkable', () => {
    expect(coverage.checkable + coverage.urlWithoutSpdxId).toBe(coverage.withUrl);
  });

  it('splits the spdxId population exactly into checkable and never-swept', () => {
    expect(coverage.checkable + coverage.spdxIdWithoutUrl).toBe(coverage.withSpdxId);
  });

  it('counts no more licence blocks than there are releases', () => {
    expect(coverage.withLicence).toBeLessThanOrEqual(coverage.releases);
    expect(coverage.releases).toBe(dataset.releases.length);
  });

  it('reports a fourth population that is neither checked nor checkable-but-unchecked', () => {
    // The distinction ADR 0018 protects: a record the sweep cannot reach is not
    // a record the sweep looked at and cleared.
    expect(coverage.spdxIdWithoutUrl).toBeGreaterThan(0);
    expect(coverage.spdxIdWithoutUrl).not.toBe(coverage.urlWithoutSpdxId);
  });

  it('counts an empty dataset as empty rather than as clean', () => {
    expect(buildLicenceCoverage([])).toEqual({
      releases: 0,
      withLicence: 0,
      withUrl: 0,
      withSpdxId: 0,
      checkable: 0,
      urlWithoutSpdxId: 0,
      spdxIdWithoutUrl: 0,
    });
  });
});

describe('buildLicenceIdentityReport over the real dataset', () => {
  const report = buildLicenceIdentityReport(dataset.releases);

  it('adjudicates part of the checkable population and abstains on the rest with named reasons', () => {
    const adjudicated = report.tally.agrees + report.tally.disagrees;
    expect(adjudicated).toBeGreaterThan(0);
    expect(adjudicated).toBeLessThanOrEqual(report.coverage.checkable);
    for (const record of report.records) {
      if (record.verdict === 'cannot-determine') {
        expect(record.reason, record.releaseId).not.toBeNull();
        expect(LICENCE_ABSTENTION_REASONS as readonly string[]).toContain(record.reason);
      }
    }
  });

  it('finds no disagreement in the dataset as it stands, which is the expected result', () => {
    // A green run is what a working guard looks like on day one. The value of
    // this check is prospective; the control immediately below is what makes
    // this zero mean something.
    expect(report.tally.disagrees).toBe(0);
  });

  it('CONTROL: the same instrument reports a disagreement when one is planted in the dataset', () => {
    // The difference control. Without it, "0 disagreements" is indistinguishable
    // from an instrument that cannot report one at all -- run against real
    // records, in the same shape, through the same entry point.
    const planted = dataset.releases.map((release) => {
      if (release.license?.url !== 'https://www.apache.org/licenses/LICENSE-2.0.txt') return release;
      return { ...release, license: { ...release.license, spdxId: 'MIT' } };
    });
    const mutated = buildLicenceIdentityReport(planted);
    expect(mutated.tally.disagrees).toBeGreaterThan(0);
    expect(mutated.records.filter((record) => record.verdict === 'disagrees')[0]).toMatchObject({
      identifiedSpdxId: 'Apache-2.0',
      spdxId: 'MIT',
    });
    // And the arms differ, in the same run, which is what makes either readable.
    expect(mutated.tally.disagrees).not.toBe(report.tally.disagrees);
  });

  it('CONTROL: a planted repoint is caught only when finalUrl evidence is supplied', () => {
    const record = dataset.releases.find(
      (release) => release.license?.url === 'https://www.apache.org/licenses/LICENSE-2.0.txt',
    );
    expect(record).toBeDefined();
    const url = record!.license!.url!;

    const withoutFetch = buildLicenceIdentityReport(dataset.releases);
    const withFetch = buildLicenceIdentityReport(
      dataset.releases,
      buildFinalUrlIndex([{ url, finalUrl: 'https://opensource.org/license/mit' }]),
    );

    expect(withoutFetch.tally.disagrees).toBe(0);
    expect(withFetch.tally.disagrees).toBeGreaterThan(0);
    expect(withoutFetch.classifiedAgainstFinalUrl).toBe(0);
    expect(withFetch.classifiedAgainstFinalUrl).toBeGreaterThan(0);
    expect(withFetch.redirects).toBeGreaterThan(0);
  });

  it('accounts for every licence-carrying release exactly once', () => {
    const total = report.tally.agrees + report.tally.disagrees + report.tally['cannot-determine'];
    expect(total).toBe(report.records.length);
    expect(report.records.length).toBe(report.coverage.withLicence);
    expect(new Set(report.records.map((entry) => entry.releaseId)).size).toBe(report.records.length);
  });

  it('pins each no-field abstention bucket to the population its prose describes', () => {
    // The guard whose absence let the conflation ship. Both no-field populations
    // once returned one code, so that bucket counted 20 while its prose -- and the
    // coverage row it should match -- named 14, and nothing anywhere asserted the
    // two had to agree. Asserting the RELATION rather than either figure means a
    // future drift between a label and its measurement fails here instead of
    // being printed as a fact.
    expect(report.reasons['no-licence-url']).toBe(report.coverage.spdxIdWithoutUrl);
    expect(report.reasons['no-spdx-id']).toBe(report.coverage.urlWithoutSpdxId);

    // The neither-field population has no coverage row of its own. It is named
    // here as the remainder rather than by adding a field to a table that is
    // already arithmetically correct. With it, the no-field buckets and the
    // checkable population partition `withLicence` exactly.
    const neither =
      report.coverage.withLicence -
      report.coverage.checkable -
      report.coverage.urlWithoutSpdxId -
      report.coverage.spdxIdWithoutUrl;
    expect(report.reasons['no-licence-fields']).toBe(neither);
  });

  it('CONTROL: each no-field bucket holds only records with the structure its prose names', () => {
    // Without this, both relations above hold vacuously if every no-field record
    // lands in one bucket -- which is precisely the state being repaired, so the
    // relation alone would have passed against the defect.
    const withReason = (reason: string) => report.records.filter((record) => record.reason === reason);
    const urlMissing = withReason('no-licence-url');
    const bothMissing = withReason('no-licence-fields');

    expect(urlMissing.length).toBeGreaterThan(0);
    expect(bothMissing.length).toBeGreaterThan(0);

    // The arms come back differing in structure, which is the whole claim: the
    // prose for `no-licence-url` names an asserted `spdxId`, and every record in
    // the other bucket asserts none.
    for (const record of urlMissing) {
      expect(record.spdxId, record.releaseId).not.toBeNull();
      expect(record.recordedUrl, record.releaseId).toBeNull();
    }
    for (const record of bothMissing) {
      expect(record.spdxId, record.releaseId).toBeNull();
      expect(record.recordedUrl, record.releaseId).toBeNull();
    }
  });

  it('never adjudicates a record outside the checkable population', () => {
    for (const record of report.records) {
      if (record.verdict === 'cannot-determine') continue;
      expect(record.spdxId, record.releaseId).not.toBeNull();
      expect(record.recordedUrl, record.releaseId).not.toBeNull();
    }
  });
});

describe('finalUrl index keying', () => {
  it('matches a recorded URL to its fetched final URL across case and a trailing slash', () => {
    const index = buildFinalUrlIndex([
      { url: 'https://WWW.Apache.org/licenses/LICENSE-2.0.txt/', finalUrl: 'https://opensource.org/license/mit' },
    ]);
    expect(index.get(finalUrlKey('https://www.apache.org/licenses/license-2.0.txt'))).toBe(
      'https://opensource.org/license/mit',
    );
  });

  it('CONTROL: does not match a URL it was never given', () => {
    const index = buildFinalUrlIndex([
      { url: 'https://www.apache.org/licenses/LICENSE-2.0.txt', finalUrl: 'https://opensource.org/license/mit' },
    ]);
    expect(index.get(finalUrlKey('https://opensource.org/license/mit'))).toBeUndefined();
  });

  it('skips entries that are not a pair of non-empty strings', () => {
    const index = buildFinalUrlIndex([
      { url: '', finalUrl: 'https://opensource.org/license/mit' },
      { url: 'https://opensource.org/license/mit', finalUrl: '' },
    ] as { url: string; finalUrl: string }[]);
    expect(index.size).toBe(0);
  });
});

describe('renderLicenceIdentityMarkdown', () => {
  const report = buildLicenceIdentityReport(dataset.releases);
  const markdown = renderLicenceIdentityMarkdown(report);

  it('says that reachability is not correctness, where the result is reported', () => {
    expect(markdown).toContain('Reachability is not correctness');
  });

  it('says in as many words that a green first run is the expected result', () => {
    expect(markdown).toContain('A green run is the expected result here, not a null one');
    expect(markdown).toContain('prospective');
  });

  it('prints every population, including the one the sweep never sees', () => {
    expect(markdown).toContain(`| releases | ${report.coverage.releases} |`);
    expect(markdown).toContain('never swept, so not even reachability is known');
    expect(markdown).toContain(`${report.coverage.checkable} of ${report.coverage.withUrl}`);
  });

  it('states that no fetch evidence was supplied, rather than implying none was needed', () => {
    expect(report.classifiedAgainstFinalUrl).toBe(0);
    expect(markdown).toContain('No fetch evidence was supplied to this run');
  });

  it('reports fetch provenance instead when a final URL was supplied', () => {
    const fetched = buildLicenceIdentityReport(
      dataset.releases,
      buildFinalUrlIndex([
        {
          url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
          finalUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
        },
      ]),
    );
    const rendered = renderLicenceIdentityMarkdown(fetched);
    expect(rendered).not.toContain('No fetch evidence was supplied to this run');
    expect(rendered).toContain('classified against a fetched `finalUrl`');
  });

  it('CONTROL: renders a disagreement, and says it is reported rather than repaired', () => {
    const planted = dataset.releases.map((release) => {
      if (release.license?.url !== 'https://opensource.org/license/mit') return release;
      return { ...release, license: { ...release.license, spdxId: 'Apache-2.0' } };
    });
    const rendered = renderLicenceIdentityMarkdown(buildLicenceIdentityReport(planted));
    expect(rendered).toContain('### Disagreements');
    expect(rendered).toContain('**Reported, not repaired.**');
    // The two arms differ in the same run: the clean render carries the green
    // paragraph and no disagreement section, and this one the reverse.
    expect(rendered).not.toContain('### No disagreements');
    expect(markdown).not.toContain('### Disagreements');
  });

  it('names each abstention reason it counts, in prose rather than as a bare enum value', () => {
    for (const reason of LICENCE_ABSTENTION_REASONS) {
      if (report.reasons[reason] === 0) continue;
      expect(markdown).toContain(`**\`${reason}\`** × ${report.reasons[reason]}`);
    }
    expect(markdown).toContain('URL is a model landing page');
  });
});
