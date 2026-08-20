import { readFileSync } from 'node:fs';

/**
 * A deliberately small reader for the YAML subset that GitHub workflow files
 * use: nested mappings, sequences, sequences of mappings, quoted and plain
 * scalars, block scalars, and comments.
 *
 * It exists because `web/` declares no YAML dependency. `yaml` appears in
 * `package-lock.json` only as a transitive `devOptional` entry, and depending on
 * an undeclared transitive package is fragile; declaring it properly means
 * hand-editing the lockfile, and a lockfile that drifts out of sync breaks
 * `npm ci` in the very workflow these tests cover.
 *
 * Mapping keys are always kept as literal strings, so `on:` stays the key `'on'`
 * rather than becoming the boolean `true` the way a YAML 1.1 parser would have
 * it. Only the exact scalars `true`, `false` and `null` are converted, so `no`,
 * `yes` and `off` stay strings too.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;

export interface YamlMapping {
  [key: string]: YamlValue;
}

const KEY_AT_START = /^[^:\s#][^:]*:(\s|$)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function stripComment(value: string): string {
  const quote = value[0];

  if (quote === "'" || quote === '"') {
    const closing = value.indexOf(quote, 1);
    return closing === -1 ? value : value.slice(0, closing + 1);
  }

  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

function parseScalar(raw: string): YamlValue {
  const value = stripComment(raw.trim());

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }

  if (value === '' || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);

  return value;
}

class Reader {
  private cursor = 0;
  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  /** Advances past blank lines and whole-line comments. Returns false at EOF. */
  private seek(): boolean {
    while (this.cursor < this.lines.length && isSkippable(this.lines[this.cursor] ?? '')) {
      this.cursor += 1;
    }
    return this.cursor < this.lines.length;
  }

  private peek(): { indent: number; content: string } | null {
    if (!this.seek()) return null;
    const line = this.lines[this.cursor] ?? '';
    return { indent: indentOf(line), content: line.trim() };
  }

  /**
   * Consumes a `|` or `>` block scalar and returns it dedented. Folding is not
   * implemented: a `>` block is joined with newlines like a `|` block, which is
   * enough for workflow files, where every block scalar is a `run:` script.
   */
  private readBlockScalar(header: string, parentIndent: number): string {
    const chomped = header.includes('-');
    const body: string[] = [];
    let baseIndent: number | null = null;

    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor] ?? '';

      if (line.trim() === '') {
        body.push('');
        this.cursor += 1;
        continue;
      }

      const indent = indentOf(line);
      if (indent <= parentIndent) break;

      baseIndent ??= indent;
      body.push(line.slice(baseIndent));
      this.cursor += 1;
    }

    while (body.length > 0 && body.at(-1) === '') body.pop();

    const text = body.join('\n');
    return chomped || text === '' ? text : `${text}\n`;
  }

  /** Reads whatever nested block follows a `key:` or `-` carrying no value. */
  private readNested(parentIndent: number): YamlValue {
    const next = this.peek();
    if (next === null || next.indent <= parentIndent) return null;

    return next.content.startsWith('-')
      ? this.readSequence(next.indent)
      : this.readMapping(next.indent);
  }

  readMapping(indent: number): YamlMapping {
    const mapping: YamlMapping = {};

    for (;;) {
      const next = this.peek();
      if (next === null || next.indent < indent || next.content.startsWith('- ')) break;
      if (next.indent > indent) {
        throw new Error(`Unexpected indentation at: ${next.content}`);
      }

      const separator = next.content.indexOf(':');
      if (separator === -1) {
        throw new Error(`Expected a mapping key at: ${next.content}`);
      }

      const key = next.content.slice(0, separator).trim();
      const inline = next.content.slice(separator + 1).trim();
      this.cursor += 1;

      if (inline.startsWith('|') || inline.startsWith('>')) {
        mapping[key] = this.readBlockScalar(inline, indent);
      } else if (inline === '' || inline.startsWith('#')) {
        mapping[key] = this.readNested(indent);
      } else {
        mapping[key] = parseScalar(inline);
      }
    }

    return mapping;
  }

  readSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];

    for (;;) {
      const next = this.peek();
      if (next === null || next.indent < indent || !next.content.startsWith('-')) break;

      const inline = next.content.slice(1).trim();

      if (inline === '') {
        this.cursor += 1;
        items.push(this.readNested(indent));
        continue;
      }

      if (KEY_AT_START.test(inline)) {
        // A mapping whose first key shares the dash line. Rewriting the line as
        // an ordinary mapping entry lets the mapping reader take it and the
        // sibling keys below it in one pass.
        this.lines[this.cursor] = `${' '.repeat(indent + 2)}${inline}`;
        items.push(this.readMapping(indent + 2));
        continue;
      }

      this.cursor += 1;
      items.push(parseScalar(inline));
    }

    return items;
  }
}

export function parseYaml(source: string): YamlMapping {
  return new Reader(source.split(/\r?\n/)).readMapping(0);
}

export interface Workflow {
  /** The file exactly as committed, for assertions parsing cannot express. */
  source: string;
  document: YamlMapping;
}

export function readWorkflow(fileName: string): Workflow {
  const path = new URL(`../../../.github/workflows/${fileName}`, import.meta.url);
  const source = readFileSync(path, 'utf8');

  return { source, document: parseYaml(source) };
}
