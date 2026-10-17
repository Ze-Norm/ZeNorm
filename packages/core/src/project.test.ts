import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateProjectInput, Project } from "@zenorm/contracts";
import { MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { validate, version } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createProject,
  getProject,
  inspectProject,
  listProjects,
  saveProjectSettings,
} from "./project.ts";
import { testContextOf } from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let root: string;
let db: ZeNormDatabase;
let context: TestContext;

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A repository on `main` with one commit, at `root/<name>` (`name` may hold slashes). */
async function makeRepo(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  git(path, ["commit", "--allow-empty", "-m", "init"]);
  return path;
}

/** A repository with no commit, its unborn branch named `branch`. */
async function makeEmptyRepo(name: string, branch: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  git(path, ["init", "-b", branch]);
  return path;
}

function input(folderPath: string, baseBranch: string): CreateProjectInput {
  return { folderPath, baseBranch };
}

async function added(folderPath: string, baseBranch: string): Promise<Project> {
  const result = await createProject(context.user, db, input(folderPath, baseBranch));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-core-"));
  const opened = openDatabase(join(root, "zenorm.sqlite"));
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  db = opened.value;
  const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  context = testContextOf(root, db);
});

afterEach(async () => {
  db.$client.close();
  await rm(root, { recursive: true, force: true });
});

describe("inspectProject", () => {
  test("returns the realpath, the folder's name, the branch HEAD names and hasCommit", async () => {
    const repo = await makeRepo("My Repo");
    const link = join(root, "link");
    await symlink(repo, link);

    expect(await inspectProject(db, `${link}/`)).toEqual({
      ok: true,
      value: {
        folderPath: await realpath(repo),
        name: "My Repo",
        detectedBaseBranch: "main",
        hasCommit: true,
      },
    });
    expect(await listProjects(db)).toEqual([]);
  });

  test("detects the unborn branch of a repository with no commit", async () => {
    const repo = await makeEmptyRepo("empty", "trunk");
    const result = await inspectProject(db, repo);
    expect(result.ok && result.value).toMatchObject({
      detectedBaseBranch: "trunk",
      hasCommit: false,
    });
  });

  test("a detached HEAD detects no branch", async () => {
    const repo = await makeRepo("repo");
    git(repo, ["checkout", "--detach"]);
    const result = await inspectProject(db, repo);
    expect(result.ok && result.value).toMatchObject({ detectedBaseBranch: null, hasCommit: true });
  });

  test("project_folder_missing for a path that does not exist, and for a file", async () => {
    const missing = join(root, "nowhere");
    expect(await inspectProject(db, missing)).toMatchObject({
      ok: false,
      error: { code: "project_folder_missing", data: { folderPath: missing } },
    });
    const file = join(root, "file.txt");
    await writeFile(file, "x");
    const result = await inspectProject(db, file);
    expect(result.ok || result.error.code).toBe("project_folder_missing");
  });

  test("project_already_added for a symlink and a trailing-slash spelling", async () => {
    const repo = await makeRepo("repo");
    await added(repo, "main");
    const link = join(root, "link");
    await symlink(repo, link);

    for (const spelling of [link, `${repo}/`]) {
      expect(await inspectProject(db, spelling)).toMatchObject({
        ok: false,
        error: { code: "project_already_added", data: { folderPath: await realpath(repo) } },
      });
    }
  });

  test("project_inside_project for a subfolder of a project's repository", async () => {
    const outer = await added(await makeRepo("outer"), "main");
    const plain = join(outer.folderPath, "src");
    await mkdir(plain);

    expect(await inspectProject(db, plain)).toMatchObject({
      ok: false,
      error: {
        code: "project_inside_project",
        data: {
          folderPath: await realpath(plain),
          projectId: outer.id,
          projectFolderPath: outer.folderPath,
        },
      },
    });
  });

  test("a nested repository and a submodule inside a project are projects of their own", async () => {
    await added(await makeRepo("outer"), "main");
    const nested = await makeRepo("outer/vendor/inner");
    const source = await makeRepo("source");
    git(join(root, "outer"), [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      "sub",
    ]);

    for (const folder of [nested, join(root, "outer/sub")]) {
      expect(await inspectProject(db, folder)).toMatchObject({
        ok: true,
        value: { folderPath: await realpath(folder) },
      });
    }
  });

  test("a repository holding a project is a project of its own", async () => {
    const outerRepo = await makeRepo("outer");
    await added(await makeRepo("outer/inner"), "main");

    expect(await inspectProject(db, outerRepo)).toMatchObject({
      ok: true,
      value: { folderPath: await realpath(outerRepo) },
    });
  });

  test("project_inside_project for a subfolder of a nested repository's project, not the outer one", async () => {
    await added(await makeRepo("outer"), "main");
    const inner = await added(await makeRepo("outer/inner"), "main");
    const sub = join(inner.folderPath, "src");
    await mkdir(sub);

    expect(await inspectProject(db, sub)).toMatchObject({
      ok: false,
      error: { code: "project_inside_project", data: { projectId: inner.id } },
    });
  });

  test("a sibling whose name extends a project's is neither inside nor containing it", async () => {
    await added(await makeRepo("repo"), "main");
    const sibling = await makeRepo("repo2");
    const result = await inspectProject(db, sibling);
    expect(result.ok).toBe(true);
  });

  test("project_not_git for a folder in no repository", async () => {
    const folder = join(root, "plain");
    await mkdir(folder);
    expect(await inspectProject(db, folder)).toMatchObject({
      ok: false,
      error: { code: "project_not_git", data: { folderPath: folder, repositoryTopLevel: null } },
    });
  });

  test("project_not_git with the top level for a subfolder of an unregistered repository", async () => {
    const repo = await makeRepo("repo");
    const sub = join(repo, "sub");
    await mkdir(sub);
    expect(await inspectProject(db, sub)).toMatchObject({
      ok: false,
      error: {
        code: "project_not_git",
        data: { folderPath: sub, repositoryTopLevel: await realpath(repo) },
      },
    });
  });

  test("a git failure other than not-a-repository is thrown, not project_not_git", async () => {
    const folder = join(root, "broken");
    await mkdir(folder);
    await writeFile(join(folder, ".git"), "not a gitdir pointer\n");
    await expect(inspectProject(db, folder)).rejects.toThrow(/invalid gitfile format/);
  });
});

describe("createProject", () => {
  test("stores and returns the project with its realpath and derived fields", async () => {
    const repo = await makeRepo("repo");
    const before = Date.now();

    const result = await createProject(context.user, db, input(repo, "main"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = result.value;
    expect(validate(project.id) && version(project.id)).toBe(7);
    expect(project).toMatchObject({
      name: "repo",
      folderPath: await realpath(repo),
      baseBranch: "main",
      requiredChecks: [],
      repairLimit: null,
      fixCommands: [],
      folder: "present",
      startDeliveryBlockers: ["project_checks_missing", "project_repair_limit_missing"],
      activeRun: null,
    });
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(project.createdAt)).toBeGreaterThanOrEqual(before);
    expect(await listProjects(db)).toEqual([project]);
  });

  test("re-runs the inspection: each of its refusals writes nothing", async () => {
    const outer = await added(await makeRepo("outer"), "main");
    const listed = await listProjects(db);
    const sub = join(outer.folderPath, "sub");
    await mkdir(sub);
    const afterOuter = await listProjects(db);
    const plain = join(root, "plain");
    await mkdir(plain);

    const cases = [
      [join(root, "nowhere"), "project_folder_missing"],
      [outer.folderPath, "project_already_added"],
      [sub, "project_inside_project"],
      [plain, "project_not_git"],
    ] as const;
    for (const [folder, code] of cases) {
      const result = await createProject(context.user, db, input(folder, "main"));
      expect(result.ok || result.error.code).toBe(code);
    }
    expect(listed).toHaveLength(1);
    expect(await listProjects(db)).toEqual(afterOuter);
  });

  test("concurrent adds of one folder store only one", async () => {
    const repo = await makeRepo("repo");

    const results = await Promise.all([
      createProject(context.user, db, input(repo, "main")),
      createProject(context.user, db, input(repo, "main")),
    ]);

    const codes = results.map((result) => (result.ok ? "ok" : result.error.code)).sort();
    expect(codes).toEqual(["ok", "project_already_added"]);
    expect(await listProjects(db)).toHaveLength(1);
  });

  test.each(["main~1", "main^", "main@{0}", "@{-1}", "-x"])(
    "project_branch_invalid for %s, which is not a branch name",
    async (baseBranch) => {
      const repo = await makeRepo("repo");
      git(repo, ["commit", "--allow-empty", "-m", "second"]);

      const result = await createProject(context.user, db, input(repo, baseBranch));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "project_branch_invalid", data: { baseBranch } });
      expect(await listProjects(db)).toEqual([]);
    },
  );

  test("project_branch_missing for a branch the repository with a commit lacks", async () => {
    const repo = await makeRepo("repo");
    const result = await createProject(context.user, db, input(repo, "develop"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "project_branch_missing",
      data: { baseBranch: "develop" },
    });
    expect(await listProjects(db)).toEqual([]);
  });

  test("a detached repository is added with a typed existing branch", async () => {
    const repo = await makeRepo("repo");
    git(repo, ["checkout", "--detach"]);
    const project = await added(repo, "main");
    expect(project.startDeliveryBlockers).toEqual([
      "project_checks_missing",
      "project_repair_limit_missing",
    ]);
  });

  test.each(["main", "develop"])(
    "a repository with no commit accepts the valid name %s, blocked from delivery",
    async (baseBranch) => {
      const repo = await makeEmptyRepo("empty", "main");

      const project = await added(repo, baseBranch);

      expect(project).toMatchObject({
        name: "empty",
        baseBranch,
        folder: "present",
        startDeliveryBlockers: [
          "project_branch_missing",
          "project_checks_missing",
          "project_repair_limit_missing",
        ],
      });
      expect(await listProjects(db)).toEqual([project]);
    },
  );

  test("a repository with no commit still refuses an invalid name", async () => {
    const repo = await makeEmptyRepo("empty", "main");
    const result = await createProject(context.user, db, input(repo, "main~1"));
    expect(result.ok || result.error.code).toBe("project_branch_invalid");
    expect(await listProjects(db)).toEqual([]);
  });
});

describe("project reads", () => {
  test("listProjects is empty before any project is added", async () => {
    expect(await listProjects(db)).toEqual([]);
  });

  test("listProjects returns every project, oldest first", async () => {
    const created = [];
    for (const name of ["Alpha", "Bravo", "Charlie"]) {
      created.push(await added(await makeRepo(name), "main"));
    }
    expect(await listProjects(db)).toEqual(created);
    expect(created.map((project) => project.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("a removed folder reads folder missing with its blocker, keeping its name", async () => {
    const project = await added(await makeRepo("repo"), "main");
    await rm(project.folderPath, { recursive: true, force: true });

    const missing = {
      ...project,
      folder: "missing",
      startDeliveryBlockers: ["project_folder_missing"],
    };
    expect(await listProjects(db)).toEqual([missing]);
    expect(await getProject(db, project.id)).toEqual({ ok: true, value: missing });
  });

  test("a base branch that lost its commit reads project_branch_missing", async () => {
    const repo = await makeRepo("repo");
    git(repo, ["checkout", "-b", "other"]);
    const project = await added(repo, "main");
    git(repo, ["branch", "-D", "main"]);

    const result = await getProject(db, project.id);
    expect(result.ok && result.value).toMatchObject({
      folder: "present",
      startDeliveryBlockers: [
        "project_branch_missing",
        "project_checks_missing",
        "project_repair_limit_missing",
      ],
    });
  });
});

describe("saveProjectSettings", () => {
  const CHECKS = ["pnpm test", "pnpm lint"];
  const FIXES = ["pnpm format", "pnpm lint --fix"];
  /** The repair settings every save below carries unless it says otherwise. */
  const REPAIR = { repairLimit: 2, fixCommands: FIXES };

  function storedRow(projectId: string): unknown {
    return db.$client
      .prepare(
        "select base_branch, required_checks, repair_limit, fix_commands from projects where id = ?",
      )
      .get(projectId);
  }

  test("stores the branch, checks, repair limit and fix commands; then the project has no blocker", async () => {
    const repo = await makeRepo("repo");
    git(repo, ["branch", "develop"]);
    const project = await added(repo, "main");

    const saved = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "develop",
      requiredChecks: CHECKS,
      ...REPAIR,
    });

    expect(saved).toEqual({
      ok: true,
      value: {
        ...project,
        baseBranch: "develop",
        requiredChecks: CHECKS,
        repairLimit: 2,
        fixCommands: FIXES,
        startDeliveryBlockers: [],
      },
    });
    expect(storedRow(project.id)).toEqual({
      base_branch: "develop",
      required_checks: JSON.stringify(CHECKS),
      repair_limit: 2,
      fix_commands: JSON.stringify(FIXES),
    });
    expect(await getProject(db, project.id)).toEqual(saved);
  });

  test("a new project has no repair limit and no fix commands; saving 0 lifts project_repair_limit_missing", async () => {
    const project = await added(await makeRepo("repo"), "main");
    expect(project).toMatchObject({ repairLimit: null, fixCommands: [] });
    expect(project.startDeliveryBlockers).toContain("project_repair_limit_missing");

    const saved = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: CHECKS,
      repairLimit: 0,
      fixCommands: [],
    });

    expect(saved.ok && saved.value).toMatchObject({
      repairLimit: 0,
      fixCommands: [],
      startDeliveryBlockers: [],
    });
  });

  test("an empty checks list is saved and blocks delivery with project_checks_missing", async () => {
    const project = await added(await makeRepo("repo"), "main");
    await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: CHECKS,
      ...REPAIR,
    });
    const saved = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: [],
      ...REPAIR,
    });
    expect(saved.ok && saved.value).toMatchObject({
      requiredChecks: [],
      startDeliveryBlockers: ["project_checks_missing"],
    });
  });

  test.each(["pnpm format && pnpm lint", "prettier --write 'src/**'", "pnpm format > out.txt"])(
    "the fix command %j needs a shell: project_fix_command_invalid, and nothing is written",
    async (command) => {
      const repo = await makeRepo("repo");
      git(repo, ["branch", "develop"]);
      const project = await added(repo, "main");
      await saveProjectSettings(context.user, db, {
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: CHECKS,
        ...REPAIR,
      });
      const before = storedRow(project.id);

      const saved = await saveProjectSettings(context.user, db, {
        projectId: project.id,
        baseBranch: "develop",
        requiredChecks: ["pnpm typecheck"],
        repairLimit: 5,
        fixCommands: ["pnpm format", command],
      });

      expect(saved).toMatchObject({
        ok: false,
        error: { code: "project_fix_command_invalid", data: { command } },
      });
      expect(storedRow(project.id)).toEqual(before);
    },
  );

  test.each(["main~1", "@{-1}", "has space", "-leading"])(
    "the branch %j is project_branch_invalid and writes nothing",
    async (baseBranch) => {
      const project = await added(await makeRepo("repo"), "main");
      const before = storedRow(project.id);
      const saved = await saveProjectSettings(context.user, db, {
        projectId: project.id,
        baseBranch,
        requiredChecks: CHECKS,
        ...REPAIR,
      });
      expect(saved).toMatchObject({
        ok: false,
        error: { code: "project_branch_invalid", data: { baseBranch } },
      });
      expect(storedRow(project.id)).toEqual(before);
    },
  );

  test.each([
    'node -e "setTimeout(() => {}, 7000)"',
    "pnpm lint && pnpm test",
    "npm test | tee log",
    "make; make test",
    "echo $HOME",
    "pnpm test > out.txt",
    "cat < in.txt",
    "echo `date`",
    "echo it\\'s",
    "pnpm test &",
  ])(
    "the check %j needs a shell: project_check_invalid, and nothing is written",
    async (command) => {
      const project = await added(await makeRepo("repo"), "main");
      const before = storedRow(project.id);
      const saved = await saveProjectSettings(context.user, db, {
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: ["pnpm typecheck", command],
        ...REPAIR,
      });
      expect(saved).toMatchObject({
        ok: false,
        error: { code: "project_check_invalid", data: { command } },
      });
      expect(storedRow(project.id)).toEqual(before);
    },
  );

  test("a missing folder does not refuse a save; it still refuses an invalid branch", async () => {
    const project = await added(await makeRepo("repo"), "main");
    await rm(project.folderPath, { recursive: true, force: true });
    const saved = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "trunk",
      requiredChecks: CHECKS,
      ...REPAIR,
    });
    expect(saved.ok && saved.value).toMatchObject({
      baseBranch: "trunk",
      requiredChecks: CHECKS,
      folder: "missing",
      startDeliveryBlockers: ["project_folder_missing"],
    });
    const invalid = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "a..b",
      requiredChecks: CHECKS,
      ...REPAIR,
    });
    expect(invalid.ok || invalid.error.code).toBe("project_branch_invalid");
  });

  test("a branch without commits does not refuse a save; it blocks delivery", async () => {
    const project = await added(await makeRepo("repo"), "main");
    const saved = await saveProjectSettings(context.user, db, {
      projectId: project.id,
      baseBranch: "not-yet",
      requiredChecks: CHECKS,
      ...REPAIR,
    });
    expect(saved.ok && saved.value).toMatchObject({
      baseBranch: "not-yet",
      startDeliveryBlockers: ["project_branch_missing"],
    });
  });

  test("project_not_found for an unknown project", async () => {
    const saved = await saveProjectSettings(context.user, db, {
      projectId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      baseBranch: "main",
      requiredChecks: [],
      ...REPAIR,
    });
    expect(saved.ok || saved.error.code).toBe("project_not_found");
  });
});
