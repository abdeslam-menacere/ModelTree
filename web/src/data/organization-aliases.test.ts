import { describe, expect, it } from 'vitest';
import organizations from './organizations.json';

/**
 * What may be registered in `Organization.aliases`, and on what evidence.
 *
 * The field is the one place in this dataset that carries no `sourceIds` and no
 * `verifiedAt`. That exemption is deliberate and is argued in the schema comment
 * on `aliases`: an alias renders on no surface and is read only by the
 * build-time cross-creator guard in `lib/variant-positioning.ts`, so it is
 * machine input to a check rather than a published claim a reader can encounter
 * and is entitled to trace. Citing "this creator is commonly called X" would
 * dress a usage judgement as a sourced fact.
 *
 * An exemption argued only in a comment is an exemption nobody checks, which is
 * the shape of the defect #687 was filed on -- the guard read as though it
 * handled aliases while no creator registered one, and the hole sat in the
 * absence of data where nothing pointed at it. So the bound on the exemption is
 * here, as a test:
 *
 * - an alias differs from `name` and `shortName`, because the guard skips forms
 *   equal to either and a duplicate is therefore dead data that reads as reach
 *   it does not have; and
 * - an alias is attested in its own record's already-sourced prose, so it is a
 *   restatement of a form this record already uses -- covered by the `sourceIds`
 *   and `verifiedAt` that record already carries -- rather than a new claim
 *   entering the dataset uncited.
 *
 * The floor is honest about what it is not. It cannot judge whether a short form
 * is *contested*, and attestation alone is not a licence to register one:
 * `alibaba-cloud` is the standing counter-example, where bare "Alibaba" is
 * attested in quoted sources and stays unregistered because this dataset records
 * an unresolved conflict over whether the creator is Alibaba Cloud or Alibaba
 * Group and that bare form is exactly the ambiguity. That judgement is
 * editorial, and review is where it is made.
 */

type Organization = {
  id: string;
  name: string;
  shortName: string;
  aliases?: string[];
  description: string;
  website: string;
  releasePage: string;
};

const creators = organizations as Organization[];

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word containment, matching how the guard reads a term. */
function namesTerm(text: string, term: string) {
  const escaped = escapeForRegExp(term);
  const prefix = /^\w/.test(term) ? '\\b' : '';
  const suffix = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i').test(text);
}

/** The record's own already-sourced surfaces, which an alias must appear in. */
function attestation(creator: Organization) {
  return [creator.description, creator.website, creator.releasePage].join(' ');
}

const withAliases = creators.filter((creator) => (creator.aliases ?? []).length > 0);

describe('the aliases registered on creators', () => {
  /**
   * Positive control. Every assertion below quantifies over creators carrying an
   * alias, so on an empty field they all pass while asserting nothing -- which
   * is precisely the state #687 found and the state this file exists to keep the
   * repository out of.
   */
  it('is a field some creator actually populates', () => {
    expect(creators.length).toBeGreaterThan(0);
    expect(withAliases.length).toBeGreaterThan(0);
  });

  it('never repeats a form already registered as `name` or `shortName`', () => {
    for (const creator of withAliases) {
      for (const alias of creator.aliases ?? []) {
        expect(alias, `${creator.id} repeats its name as an alias`).not.toBe(creator.name);
        expect(alias, `${creator.id} repeats its shortName as an alias`).not.toBe(creator.shortName);
      }
    }
  });

  it('registers no empty or padded form, which would match everywhere or nowhere', () => {
    for (const creator of withAliases) {
      for (const alias of creator.aliases ?? []) {
        expect(alias.trim(), `${creator.id} registers a padded alias`).toBe(alias);
        expect(alias.length, `${creator.id} registers an empty alias`).toBeGreaterThan(0);
      }
    }
  });

  it('registers the same form only once per creator', () => {
    for (const creator of withAliases) {
      const aliases = creator.aliases ?? [];
      expect(new Set(aliases.map((alias) => alias.toLowerCase())).size).toBe(aliases.length);
    }
  });

  /**
   * The sourcing bound itself. An alias that appears nowhere in the record's own
   * sourced prose is an uncited usage claim, and this is what refuses it.
   */
  it('registers only forms its own sourced record already uses', () => {
    for (const creator of withAliases) {
      const evidence = attestation(creator);
      for (const alias of creator.aliases ?? []) {
        expect(
          namesTerm(evidence, alias),
          `${creator.id} registers "${alias}", which its own description, website and `
          + 'releasePage never use. An alias carries no source of its own, so it must be a '
          + 'form this record already states under the sources it already cites.',
        ).toBe(true);
      }
    }
  });

  /**
   * The check above must be capable of failing, or it is a green light wired to
   * nothing. A form no record uses has to be visible to it.
   */
  it('can see a form the record does not use', () => {
    const [creator] = withAliases;

    expect(namesTerm(attestation(creator), 'Kalyptomenon')).toBe(false);
  });

  /**
   * The dataset case #687 turns on, named rather than left to the sweep: the one
   * creator whose `name` and `shortName` are the same two-word form, so neither
   * recorded field contains the word readers actually use.
   */
  it('gives Google DeepMind the short forms its two identical recorded names hide', () => {
    const googleDeepMind = creators.find(({ id }) => id === 'google-deepmind');

    expect(googleDeepMind?.name).toBe('Google DeepMind');
    expect(googleDeepMind?.shortName).toBe('Google DeepMind');
    expect(googleDeepMind?.aliases).toEqual(['Google', 'DeepMind']);
  });
});
