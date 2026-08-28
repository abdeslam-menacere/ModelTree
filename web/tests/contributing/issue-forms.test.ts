import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { correctionHref } from '../../src/lib/passport';
import { methodologyReferences } from '../../src/lib/methodology';
import { validateDataset } from '../../src/data/validate';
import { accessType, lifecycleStatus, modelCategory, datePrecision, datasetSchema } from '../../src/data/schema';

/**
 * Issue #27 adds contributor-facing documents that live outside `web/`, and the
 * facts they state belong to code inside it. That split is the whole risk: a
 * prose file cannot import, so every statement it makes about the dataset is a
 * copy that can go stale silently.
 *
 * So no fact about the dataset is restated here. Each assertion reads the
 * authority -- the schema's enums and its declared collections, `package.json`'s
 * scripts, `gate-scope.mjs`'s allowed set, `passport.ts`'s own URL builder -- and
 * compares the document against it. A file that drifts from the code it describes
 * fails the suite rather than misleading a contributor.
 *
 * The load-bearing one is `blank_issues_enabled`. Every Model Passport page
 * carries a correction link built by `correctionHref`, and that link prefills the
 * *blank* issue form through the query string. Turning blank issues off makes
 * GitHub redirect to the template chooser and drop the query string, so the links
 * keep working while silently ceasing to name the record they are about. There is
 * no signal from the repository side, which is why it is pinned here.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;

interface YamlMapping {
  [key: string]: YamlValue;
}

function mapping(value: YamlValue, label: string): YamlMapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a mapping, found ${JSON.stringify(value)}`);
  }

  return value;
}

function sequence(value: YamlValue, label: string): YamlValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a sequence, found ${JSON.stringify(value)}`);
  }

  return value;
}

function text(value: YamlValue, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string, found ${JSON.stringify(value)}`);
  }

  return value;
}

const repoFile = (relative: string) =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
const CORRECTION_FORM = `${TEMPLATE_DIR}/data-correction.yml`;
const SUBMISSION_FORM = `${TEMPLATE_DIR}/submit-release.yml`;

const chooserConfig = mapping(parse(repoFile(`${TEMPLATE_DIR}/config.yml`)), 'config.yml');
const correctionForm = mapping(parse(repoFile(CORRECTION_FORM)), 'data-correction.yml');
const submissionForm = mapping(parse(repoFile(SUBMISSION_FORM)), 'submit-release.yml');
const featureForm = mapping(parse(repoFile(`${TEMPLATE_DIR}/feature.yml`)), 'feature.yml');

const contributing = repoFile('CONTRIBUTING.md');
const codeowners = repoFile('.github/CODEOWNERS');
const pullRequestTemplate = repoFile('.github/pull_request_template.md');
const gateScope = repoFile('.github/skills/modeltree-gates/scripts/gate-scope.mjs');
const webPackage = JSON.parse(repoFile('web/package.json')) as { scripts: Record<string, string> };

/** Every element of an issue form's `body:`, as parsed mappings. */
function formBody(form: YamlMapping, label: string): YamlMapping[] {
  return sequence(form.body, `${label}.body`).map((element, index) =>
    mapping(element, `${label}.body[${index}]`),
  );
}

/** The one element carrying a given id, which is how GitHub addresses a field. */
function field(form: YamlMapping, label: string, id: string): YamlMapping {
  const found = formBody(form, label).filter((element) => element.id === id);

  if (found.length !== 1) {
    throw new Error(`Expected exactly one field with id "${id}" in ${label}, found ${found.length}`);
  }

  return found[0];
}

function dropdownOptions(form: YamlMapping, label: string, id: string): string[] {
  const element = field(form, label, id);
  const attributes = mapping(element.attributes, `${label}.${id}.attributes`);

  return sequence(attributes.options, `${label}.${id}.options`).map((option, index) =>
    text(option, `${label}.${id}.options[${index}]`),
  );
}

// ---------------------------------------------------------------------------
// The forms parse, and are forms rather than markdown templates
// ---------------------------------------------------------------------------

describe('the issue forms are valid GitHub issue forms', () => {
  const forms: [string, YamlMapping][] = [
    [CORRECTION_FORM, correctionForm],
    [SUBMISSION_FORM, submissionForm],
    [`${TEMPLATE_DIR}/feature.yml`, featureForm],
  ];

  // GitHub renders exactly these element types. An unknown `type:` is not a
  // warning on the chooser -- the form fails to render at all.
  const RENDERABLE_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']);

  it.each(forms)('%s carries the top-level keys the chooser needs', (label, form) => {
    expect(text(form.name, `${label}.name`).length).toBeGreaterThan(0);
    expect(text(form.description, `${label}.description`).length).toBeGreaterThan(0);
    expect(formBody(form, label).length).toBeGreaterThan(0);
  });

  it.each(forms)('%s uses only element types GitHub renders', (label, form) => {
    for (const [index, element] of formBody(form, label).entries()) {
      expect(
        RENDERABLE_TYPES.has(text(element.type, `${label}.body[${index}].type`)),
        `${label}.body[${index}] has type "${String(element.type)}"`,
      ).toBe(true);
    }
  });

  it.each(forms)('%s gives every input a unique id, which is what makes it prefillable', (label, form) => {
    const ids = formBody(form, label)
      .filter((element) => element.type !== 'markdown')
      .map((element, index) => text(element.id, `${label}.body[${index}].id`));

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(forms)('%s asks for something on every field it renders', (label, form) => {
    for (const [index, element] of formBody(form, label).entries()) {
      const attributes = mapping(element.attributes, `${label}.body[${index}].attributes`);
      const hasPrompt = typeof attributes.label === 'string' || typeof attributes.value === 'string';
      expect(hasPrompt, `${label}.body[${index}] renders no label or content`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The shipped correction link, which is the half of this that already exists
// ---------------------------------------------------------------------------

describe('the correction form is compatible with the link the site already ships', () => {
  const passportLink = new URL(correctionHref({
    slug: 'gpt-5',
    canonicalName: 'GPT-5',
    verifiedAt: '2026-08-26',
  }));

  it('leaves blank issues enabled, because the passport link prefills through them', () => {
    // `/issues/new?title=...&body=...` is the blank issue form. With
    // `blank_issues_enabled: false` GitHub redirects it to the chooser and
    // discards the query, so every passport correction link would arrive naming
    // no record. Stated explicitly rather than left to GitHub's default, so that
    // turning it off is a visible edit that fails here.
    expect(chooserConfig.blank_issues_enabled).toBe(true);
  });

  it('is reached by a path the chooser cannot intercept', () => {
    expect(passportLink.pathname.endsWith('/issues/new')).toBe(true);
    expect(passportLink.pathname).not.toContain('/choose');
    expect([...passportLink.searchParams.keys()].sort()).toEqual(['body', 'title']);
  });

  it('shares its title prefix with the link, so both routes read alike in the issue list', () => {
    const formTitle = text(correctionForm.title, 'data-correction.yml.title');
    const linkTitle = passportLink.searchParams.get('title') ?? '';

    // Derived from the builder's own output rather than written out here: the
    // form's default title must be the constant part of what `correctionHref`
    // produces, so changing either side without the other fails.
    expect(linkTitle.startsWith(formTitle)).toBe(true);
    expect(formTitle.trim().length).toBeGreaterThan(0);
  });

  it('offers a field for the slug the link carries, under a prefillable id', () => {
    const body = passportLink.searchParams.get('body') ?? '';
    const slugLine = body.split('\n')[0];

    expect(slugLine).toContain('gpt-5');

    // The id is a public interface: `?template=data-correction.yml&record-slug=gpt-5`
    // prefills this field. A rename silently breaks any such link.
    const slugField = field(correctionForm, CORRECTION_FORM, 'record-slug');
    expect(mapping(slugField.attributes, 'record-slug.attributes').placeholder).toBeTruthy();
    expect(mapping(slugField.validations ?? {}, 'record-slug.validations').required).toBe(true);
  });

  it('is what the methodology page sends readers of the chooser to find', () => {
    // /methodology/ links to the chooser, so a chooser without a correction form
    // sends a would-be corrector to the internal Drydock feature form instead.
    expect(methodologyReferences.correctionPath.endsWith('/issues/new/choose')).toBe(true);
    expect(text(correctionForm.name, 'data-correction.yml.name').toLowerCase())
      .toContain('incorrect data');
  });

  it('requires a URL, a slug, an observed problem, and a verification date', () => {
    const required = formBody(correctionForm, CORRECTION_FORM)
      .filter((element) => mapping(element.validations ?? {}, 'validations').required === true)
      .map((element) => String(element.id));

    for (const id of ['record-slug', 'field', 'observed', 'primary-source', 'quote', 'checked-on']) {
      expect(required, `${id} must be required`).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// The submission form, held to the schema rather than to prose
// ---------------------------------------------------------------------------

describe('the submission form offers exactly the vocabulary the schema accepts', () => {
  it.each([
    ['access-type', accessType.options],
    ['status', lifecycleStatus.options],
    ['categories', modelCategory.options],
    ['date-precision', datePrecision.options],
  ])('%s offers every schema member and invents none', (id, expected) => {
    expect(expected.length).toBeGreaterThan(0);
    expect(dropdownOptions(submissionForm, SUBMISSION_FORM, id).sort())
      .toEqual([...expected].sort());
  });

  it('asks for a source and a checked date before it asks for anything optional', () => {
    const ids = formBody(submissionForm, SUBMISSION_FORM).map((element) => String(element.id));
    const sourceAt = ids.indexOf('primary-source');
    const optionalAt = ids.indexOf('optional-facts');

    expect(sourceAt).toBeGreaterThanOrEqual(0);
    expect(optionalAt).toBeGreaterThan(sourceAt);
    expect(ids).toContain('checked-on');
    expect(ids).toContain('unknowns');
  });
});

// ---------------------------------------------------------------------------
// The worked example, run through the real validator
// ---------------------------------------------------------------------------

describe('the minimal example is a dataset this repository would accept', () => {
  const example = JSON.parse(repoFile('docs/contributing/minimal-dataset-example.json')) as
    Record<string, unknown[]>;

  it('passes the same validator the site loads its own data through', () => {
    expect(() => validateDataset(example)).not.toThrow();
  });

  it('carries one canonical record for every collection the dataset schema declares', () => {
    // Derived rather than restated. A collection added to `datasetSchema` fails
    // here until the example demonstrates it, so the worked example cannot
    // quietly fall behind the schema the way a hand-kept list would.
    const collections = Object.keys(datasetSchema.shape);
    expect(collections.length, 'datasetSchema declared no collections').toBeGreaterThan(0);

    for (const entity of collections) {
      expect(example[entity]?.length, `${entity} has no example record`).toBeGreaterThan(0);
    }
  });

  it('keeps the creator and the serving platform as separate organizations', () => {
    // The example is documentation, so modelling the collapse this repository
    // forbids would teach it. The platform is operated by an organization that
    // is not the model's creator, which is the distinction being demonstrated.
    const data = validateDataset(example);
    const release = data.releases[0];
    const deployment = data.deployments[0];
    const platform = data.servingPlatforms.find((entry) => entry.id === deployment.platformId);

    expect(deployment.releaseId).toBe(release.id);
    expect(platform?.organizationId).not.toBe(release.organizationId);
  });

  it('cites only reserved example.com URLs, so no record reads as a real claim', () => {
    const data = validateDataset(example);
    expect(data.sources.length).toBeGreaterThan(0);

    for (const source of data.sources) {
      expect(new URL(source.url).hostname, `${source.id} cites a live-looking host`)
        .toBe('example.com');
    }
  });
});

// ---------------------------------------------------------------------------
// The guide, and the ownership it describes
// ---------------------------------------------------------------------------

describe('the contribution guide agrees with the repository it describes', () => {
  it('names a validation command web/package.json actually defines', () => {
    // The guide tells a contributor to run one command. If that script is
    // renamed, the guide becomes a dead end, which is the failure this repo
    // treats as worse than no documentation.
    const named = [...contributing.matchAll(/npm run ([a-z-]+)/g)].map((match) => match[1]);

    expect(named.length).toBeGreaterThan(0);
    for (const script of new Set(named)) {
      expect(Object.keys(webPackage.scripts), `npm run ${script} is not a script`).toContain(script);
    }
  });

  it('links the published methodology instead of restating it', () => {
    expect(contributing).toContain('/methodology');
  });

  it('points at both issue forms by their real filenames', () => {
    expect(contributing).toContain('data-correction.yml');
    expect(contributing).toContain('submit-release.yml');
  });
});

describe('CODEOWNERS does not quietly repeal the auto-merge ADR', () => {
  /**
   * `ALLOWED_PATHS` in gate-scope.mjs is the enforced definition of the
   * qualifying class, so it is parsed rather than restated. An empty parse is
   * treated as a broken probe, not as agreement.
   */
  const allowedPaths = (() => {
    const block = gateScope.match(/const ALLOWED_PATHS = new Set\(\[([\s\S]*?)\]\)/);
    if (!block) throw new Error('ALLOWED_PATHS not found in gate-scope.mjs');

    return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  })();

  /**
   * Lines carrying a pattern and no owner, which is how ownership is cleared.
   *
   * Split on `\r?\n` and stripped with an unanchored `#.*`: this repository sets
   * `core.autocrlf`, so a `$`-anchored strip silently matches nothing once a
   * `\r` sits between the comment and the end of the line, and every comment
   * would then read as a pattern.
   */
  const ownerless = codeowners
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes('@'))
    .map((line) => line.replace(/^\//, ''));

  it('reads a non-empty allowed set out of the gate', () => {
    expect(allowedPaths.length).toBeGreaterThan(0);
    expect(allowedPaths.every((path) => path.startsWith('web/src/data/'))).toBe(true);
  });

  it('clears ownership on exactly the documents a refresh may auto-merge', () => {
    // Broader would strand human-owned files; narrower would put a code-owner
    // review on an automated refresh that ADR 0003 says may merge without one.
    expect([...ownerless].sort()).toEqual([...allowedPaths].sort());
  });

  it('still owns everything else, including the schemas beside those documents', () => {
    const owning = codeowners
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line.includes('@'));

    expect(owning.some((line) => line.startsWith('*'))).toBe(true);
    expect(ownerless).not.toContain('web/src/data/schema.ts');
    expect(ownerless).not.toContain('web/src/data/validate.ts');
  });
});

describe('the pull request template separates factual from code review', () => {
  it('asks the questions a factual change needs and a code change does not', () => {
    for (const cue of ['## Factual changes', '## Code changes']) {
      expect(pullRequestTemplate).toContain(cue);
    }
  });

  it('asks for the evidence rules and the policies this repository actually enforces', () => {
    const flattened = pullRequestTemplate.replace(/\s+/g, ' ').toLowerCase();

    // The first four cover the questions a reviewer must ask; the last three are
    // this repository's own named policies -- unknowns stay explicit, nothing is
    // ranked overall, and motion respects the reduced-motion preference.
    for (const cue of [
      'primary source', 'verifiedat', 'accessib', 'npm run validate', 'scope',
      'left absent', 'no overall score', 'prefers-reduced-motion',
    ]) {
      expect(flattened, `the template never mentions ${cue}`).toContain(cue);
    }
  });
});
