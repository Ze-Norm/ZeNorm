import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  ClauseReference,
  ClauseReliance,
  CodeSurvey,
  SpecRevisionContent,
} from "@zenorm/contracts";

/** How many lines either side of a reference's line its excerpt shows. */
export const REFERENCE_EXCERPT_RADIUS = 8;

/** A name FACTS defines: an identifier, or a lifecycle's state or record, at its cited line. */
interface FactsName {
  readonly path: string;
  readonly line: number;
  readonly meaning: string;
}

/**
 * The names a map's survey defines, by exact name: its identifiers, then each lifecycle's
 * record and states (a state at the line of its terminal entry, else of the first transition into
 * it). The first definition of a name wins.
 */
function factsNames(survey: CodeSurvey | null): Map<string, FactsName> {
  const names = new Map<string, FactsName>();
  if (survey === null) {
    return names;
  }
  const add = (name: string, fact: FactsName) => {
    if (!names.has(name)) names.set(name, fact);
  };
  for (const identifier of survey.identifiers) {
    add(identifier.name, identifier);
  }
  if (survey.lifecycles === undefined) {
    // A survey written before lifecycles has none.
    return names;
  }
  for (const lifecycle of survey.lifecycles) {
    for (const terminal of lifecycle.terminal) {
      add(terminal.state, {
        path: terminal.path,
        line: terminal.line,
        meaning: `A ${lifecycle.record} state; it ends there: ${terminal.exits}`,
      });
    }
    for (const transition of lifecycle.transitions) {
      const fact = {
        path: transition.path,
        line: transition.line,
        meaning: `A ${lifecycle.record} state, entered from ${transition.from} by ${transition.by}`,
      };
      add(transition.to, fact);
      add(lifecycle.record, {
        ...fact,
        meaning: `A record with states ${lifecycle.states.join(", ")}`,
      });
    }
  }
  return names;
}

/** The lines of a file of the project, or null when it is no file. */
function fileLines(folder: string, path: string): string[] | null {
  const full = join(folder, path);
  if (statSync(full, { throwIfNoEntry: false })?.isFile() !== true) {
    return null;
  }
  return readFileSync(full, "utf8").split("\n");
}

/**
 * Whether `path` is documentation, which never shows what the code does: a name is not searched
 * for there. A file the spec names by its path still resolves, since a Markdown file can be what
 * the product reads (an agent's skill or prompt).
 */
function isDocumentation(path: string): boolean {
  return /\.(md|mdx|txt)$/i.test(path);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A tracked file's lines, as `findInSource` searches them when it is not documentation. */
interface SourceFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly documentation: boolean;
}

/**
 * How a source file ranks in a search, lower first: product source, then test files, then files
 * under a dot-directory (scratch notes, tooling), so a name resolves where the product defines it.
 */
function rank(path: string): number {
  if (path.split("/").some((part) => part.startsWith("."))) return 2;
  return /(^|\/)(e2e|tests?|__tests__|fixtures?)\/|\.(test|spec|fixture)\.[^/]+$/.test(path)
    ? 1
    : 0;
}

/**
 * The project's tracked files (`git ls-files`), read once on first use and ranked by `rank`, then
 * path.
 */
function projectSource(folder: string): () => readonly SourceFile[] {
  let files: SourceFile[] | null = null;
  return () => {
    files ??= execFileSync("git", ["ls-files", "-z"], {
      cwd: folder,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path !== "")
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .flatMap((path) => {
        const lines = fileLines(folder, path);
        return lines === null ? [] : [{ path, lines, documentation: isDocumentation(path) }];
      });
    return files;
  };
}

/**
 * Where the project's source defines `name`, when FACTS does not name it: in ranked order, first
 * a line that defines it (a declaration, an object key, a quoted value), else the first line that
 * uses it as a whole word. A dotted name (`planningRun.tryAgain`) is found by its last segment as a
 * definition, in a file that also has its first segment. Null when no source file has it.
 */
function findInSource(
  files: readonly SourceFile[],
  name: string,
): { path: string; line: number } | null {
  const segments = name.split(".");
  const last = segments.at(-1);
  const first = segments[0];
  if (last === undefined || first === undefined || last === "") {
    return null;
  }
  const word = escaped(last);
  const definition = new RegExp(
    `(?:\\b(?:function|const|let|var|class|interface|type|enum)\\s+${word}\\b|(?:^|[\\s{,(])${word}\\s*[:=]|["'\`]${word}["'\`])`,
  );
  const use = new RegExp(`(?<![\\w$])${word}(?![\\w$])`);
  let used: { path: string; line: number } | null = null;
  for (const { path, lines, documentation } of files) {
    if (documentation) {
      continue;
    }
    if (segments.length > 1 && !lines.some((line) => line.includes(first))) {
      continue;
    }
    const defined = lines.findIndex((line) => definition.test(line));
    if (defined !== -1) {
      return { path, line: defined + 1 };
    }
    if (used === null && segments.length === 1) {
      const at = lines.findIndex((line) => use.test(line));
      if (at !== -1) used = { path, line: at + 1 };
    }
  }
  return used;
}

/** Where a reliance resolves: its file and line and the FACTS meaning, or why it does not. */
type Resolution =
  | {
      readonly ok: true;
      readonly path: string;
      readonly line: number;
      readonly meaning: string | null;
    }
  | { readonly ok: false; readonly problem: string };

function resolve(
  folder: string,
  facts: ReadonlyMap<string, FactsName>,
  source: () => readonly SourceFile[],
  reliance: ClauseReliance,
): Resolution {
  const fact = facts.get(reliance.name);
  if (reliance.path === null) {
    if (fact !== undefined) {
      return { ok: true, path: fact.path, line: fact.line, meaning: fact.meaning };
    }
    // A file is a reliance by its path (`src/cli.js`, `skills/pr/SKILL.md`): it resolves to its
    // first line.
    const file = source().find(({ path }) => path === reliance.name);
    if (file !== undefined) {
      return { ok: true, path: file.path, line: 1, meaning: null };
    }
    const found = findInSource(source(), reliance.name);
    return found === null
      ? {
          ok: false,
          problem:
            "is neither a FACTS name nor found in the project's source: rely on what exists, or add it as new",
        }
      : { ok: true, ...found, meaning: null };
  }
  const lines = fileLines(folder, reliance.path);
  if (lines === null) {
    return {
      ok: false,
      problem: `names ${reliance.path}, which is not a file of the project`,
    };
  }
  const index = lines.findIndex((line) => line.includes(reliance.name));
  if (index === -1) {
    return { ok: false, problem: `does not occur in ${reliance.path}` };
  }
  return {
    ok: true,
    path: reliance.path,
    line: index + 1,
    meaning: fact === undefined ? null : fact.meaning,
  };
}

/**
 * Every problem of a written revision's clause declarations, joined into one message, or
 * null. Each clause declares `reliesOn` and `adds`, at least one non-empty; each reliance resolves
 * (a FACTS name, the path of a tracked file of the project at `folder`, or a name its source
 * defines, in the named file when a path is given); and no
 * addition is a name FACTS already defines. Names the text only mentions in passing are not
 * checked: requiring each to be declared refuses sound specs.
 */
export function referencesProblem(
  content: SpecRevisionContent,
  survey: CodeSurvey | null,
  folder: string,
): string | null {
  const facts = factsNames(survey);
  const source = projectSource(folder);
  const problems: string[] = [];
  for (const clause of content.clauses) {
    const { reliesOn, adds } = clause;
    if (reliesOn === undefined || adds === undefined) {
      problems.push(`Clause ${clause.id} lacks its reliesOn or adds list: write both`);
      continue;
    }
    if (reliesOn.length === 0 && adds.length === 0) {
      problems.push(
        `Clause ${clause.id} relies on nothing and adds nothing: name the existing behaviour it depends on in reliesOn, or the names it introduces in adds`,
      );
    }
    for (const reliance of reliesOn) {
      const resolved = resolve(folder, facts, source, reliance);
      if (!resolved.ok) {
        problems.push(
          `Clause ${clause.id} relies on "${reliance.name}", which ${resolved.problem}`,
        );
      }
    }
    for (const name of adds) {
      const fact = facts.get(name);
      if (fact !== undefined) {
        problems.push(
          `Clause ${clause.id} adds "${name}", which FACTS already defines (${fact.path}:${String(fact.line)}): rely on it instead, or, when the clause adds a different thing that shares the name, add it with its kind, like "JSON key ${name}" or "state ${name}"`,
        );
      }
    }
  }
  return problems.length === 0 ? null : problems.join(". ");
}

/**
 * Each clause's reliances with the code around them, as the repair and the review read
 * them: the file and line, the FACTS meaning when FACTS names it, and the lines either side. A
 * reliance that no longer resolves (the code moved since the revision was written) has no line
 * or excerpt. A clause written before clauses declared reliances has none.
 */
export function clauseReferences(
  content: SpecRevisionContent,
  survey: CodeSurvey | null,
  folder: string,
): ClauseReference[] {
  const facts = factsNames(survey);
  const source = projectSource(folder);
  return content.clauses.flatMap((clause) => {
    if (clause.reliesOn === undefined) {
      return [];
    }
    return clause.reliesOn.map((reliance) => {
      const resolved = resolve(folder, facts, source, reliance);
      if (!resolved.ok) {
        return {
          clauseId: clause.id,
          name: reliance.name,
          path: reliance.path,
          line: null,
          meaning: null,
          excerpt: null,
        };
      }
      const lines = fileLines(folder, resolved.path);
      const first = Math.max(1, resolved.line - REFERENCE_EXCERPT_RADIUS);
      const excerpt =
        lines === null
          ? null
          : lines
              .slice(first - 1, resolved.line + REFERENCE_EXCERPT_RADIUS)
              .map((line, index) => `${String(first + index)}: ${line}`)
              .join("\n");
      return {
        clauseId: clause.id,
        name: reliance.name,
        path: resolved.path,
        line: resolved.line,
        meaning: resolved.meaning,
        excerpt,
      };
    });
  });
}
