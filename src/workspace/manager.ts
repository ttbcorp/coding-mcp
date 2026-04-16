import fs from "node:fs/promises";
import path from "node:path";
import { SafetyValidator } from "./safety.js";
import type { SafetyCheckResult } from "./safety.js";
import fg from "fast-glob";

export interface FileEntry {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: Date;
}

export interface WriteResult {
  path: string;
  success: boolean;
  backupPath?: string;
  error?: string;
}

export interface DiffPreview {
  path: string;
  before: string;
  after: string;
  unified: string;
}

export interface WriteOptions {
  /** Allow overwriting an existing file. Default: false */
  overwrite?: boolean;
  /** Create a `.bak` backup before overwriting. Default: false */
  backup?: boolean;
  /**
   * SHA-256 hex of the content when it was last read.
   * Enables conflict detection — write is blocked if file was modified.
   */
  lastReadHash?: string;
}

/**
 * WorkspaceManager handles all filesystem operations for the workspace.
 *
 * Responsibilities:
 * - Reading files and directory trees
 * - Writing files with Verified Write (write → read-back verification)
 * - Deleting files with path validation
 * - Generating unified diff previews
 * - Creating `.bak` backups
 * - Delegating all safety checks to SafetyValidator
 */
export class WorkspaceManager {
  private readonly safety: SafetyValidator;
  private readonly root: string;

  constructor(workspaceRoot: string, safety?: SafetyValidator) {
    this.root = path.resolve(workspaceRoot);
    this.safety = safety ?? new SafetyValidator(workspaceRoot);
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Reads a file within the workspace.
   * Throws if the path is outside the workspace root or the file is binary/oversized.
   *
   * @param filePath - Absolute or root-relative path
   * @returns UTF-8 file content
   */
  async readFile(filePath: string): Promise<string> {
    const pathResult = await this.safety.validatePath(filePath, this.root);
    this.assertSafe(pathResult);

    const sizeResult = await this.safety.checkFileSize(pathResult.normalizedPath);
    this.assertSafe(sizeResult);

    const binary = await this.safety.isBinaryFile(pathResult.normalizedPath);
    if (binary) {
      throw new Error(
        `Cannot read binary file: "${pathResult.normalizedPath}"`
      );
    }

    return fs.readFile(pathResult.normalizedPath, "utf8");
  }

  // ---------------------------------------------------------------------------
  // Write (Verified)
  // ---------------------------------------------------------------------------

  /**
   * Writes content to a file with Verified Write semantics.
   *
   * Process:
   *  1. Validate path
   *  2. Check overwrite / conflict rules
   *  3. Optionally create a `.bak` backup
   *  4. Write file (create parent directories as needed)
   *  5. Immediately read back and compare — retry once on mismatch
   *
   * @throws When write verification fails after one retry
   */
  async writeFile(
    filePath: string,
    content: string,
    opts: WriteOptions = {}
  ): Promise<WriteResult> {
    const pathResult = await this.safety.validatePath(filePath, this.root);

    if (!pathResult.safe) {
      return {
        path: filePath,
        success: false,
        error: pathResult.reason,
      };
    }

    const { normalizedPath } = pathResult;

    const overwriteResult = await this.safety.checkOverwrite(normalizedPath, {
      overwrite: opts.overwrite,
      lastReadHash: opts.lastReadHash,
    });

    if (!overwriteResult.safe) {
      return {
        path: normalizedPath,
        success: false,
        error: overwriteResult.reason,
      };
    }

    // Optional backup before overwrite
    let backupPath: string | undefined;
    if (opts.backup) {
      backupPath = await this.backup(normalizedPath);
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });

    // Write
    await fs.writeFile(normalizedPath, content, "utf8");

    // Verified read-back
    let readBack = await fs.readFile(normalizedPath, "utf8");

    if (readBack !== content) {
      // Retry once
      await fs.writeFile(normalizedPath, content, "utf8");
      readBack = await fs.readFile(normalizedPath, "utf8");

      if (readBack !== content) {
        throw new Error(
          `Verified write failed: content mismatch after retry for "${normalizedPath}"`
        );
      }
    }

    return { path: normalizedPath, success: true, backupPath };
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  /**
   * Deletes a file within the workspace.
   * Throws if the path escapes the workspace root.
   *
   * @param filePath - Absolute or root-relative path
   */
  async deleteFile(filePath: string): Promise<void> {
    const pathResult = await this.safety.validatePath(filePath, this.root);
    this.assertSafe(pathResult);

    await fs.unlink(pathResult.normalizedPath);
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /**
   * Lists files under the workspace root matching an optional glob pattern.
   * Defaults to `**\/*` (all files, no directories).
   *
   * @param pattern - fast-glob pattern relative to workspace root
   * @returns Sorted array of FileEntry objects
   */
  async listTree(pattern?: string): Promise<FileEntry[]> {
    const glob = pattern ?? "**/*";

    const matches = await fg(glob, {
      cwd: this.root,
      dot: true,
      onlyFiles: true,
      absolute: true,
    });

    const entries = await Promise.all(
      matches.map(async (absPath) => {
        const stat = await fs.stat(absPath);
        return {
          path: absPath,
          relativePath: path.relative(this.root, absPath),
          size: stat.size,
          modifiedAt: stat.mtime,
        } satisfies FileEntry;
      })
    );

    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * Lists all files under the workspace root matching the given glob pattern.
   * Alias for listTree for backward compatibility.
   */
  async listFiles(pattern?: string): Promise<FileEntry[]> {
    return this.listTree(pattern);
  }

  // ---------------------------------------------------------------------------
  // Diff
  // ---------------------------------------------------------------------------

  /**
   * Returns a unified diff string comparing the current file content to
   * newContent. If the file does not exist, the "before" is treated as empty.
   *
   * @param filePath - Absolute or root-relative path
   * @param newContent - Proposed new content
   */
  async diff(filePath: string, newContent: string): Promise<string> {
    const preview = await this.previewDiff(filePath, newContent);
    return preview.unified;
  }

  /**
   * Returns a full DiffPreview (before, after, unified diff).
   */
  async previewDiff(
    filePath: string,
    newContent: string
  ): Promise<DiffPreview> {
    const pathResult = await this.safety.validatePath(filePath, this.root);
    this.assertSafe(pathResult);

    let before = "";
    try {
      before = await fs.readFile(pathResult.normalizedPath, "utf8");
    } catch {
      // File doesn't exist — diff from empty
    }

    const unified = buildUnifiedDiff(
      before,
      newContent,
      path.relative(this.root, pathResult.normalizedPath)
    );

    return {
      path: pathResult.normalizedPath,
      before,
      after: newContent,
      unified,
    };
  }

  // ---------------------------------------------------------------------------
  // Backup
  // ---------------------------------------------------------------------------

  /**
   * Creates a `.bak` copy of the given file.
   * If the file does not exist, this is a no-op and returns undefined.
   *
   * @param filePath - Absolute path to the file
   * @returns Path to the backup file, or undefined if source did not exist
   */
  async backup(filePath: string): Promise<string | undefined> {
    const pathResult = await this.safety.validatePath(filePath, this.root);
    this.assertSafe(pathResult);

    const { normalizedPath } = pathResult;
    const bakPath = `${normalizedPath}.bak`;

    try {
      await fs.copyFile(normalizedPath, bakPath);
      return bakPath;
    } catch (err: unknown) {
      // Source file doesn't exist — nothing to back up
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Existence check
  // ---------------------------------------------------------------------------

  /**
   * Returns true when a file exists and is accessible within the workspace.
   */
  async exists(filePath: string): Promise<boolean> {
    const pathResult = await this.safety.validatePath(filePath, this.root);
    if (!pathResult.safe) return false;

    try {
      await fs.access(pathResult.normalizedPath);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get workspaceRoot(): string {
    return this.root;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertSafe(result: SafetyCheckResult): void {
    if (!result.safe) {
      throw new Error(result.reason ?? "Safety check failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Unified diff builder (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Builds a minimal unified diff string from two text contents.
 *
 * Format matches `diff -u` output:
 * ```
 * --- a/path
 * +++ b/path
 * @@ -L,N +L,N @@
 *  context
 * -removed
 * +added
 * ```
 */
function buildUnifiedDiff(
  before: string,
  after: string,
  filePath: string
): string {
  if (before === after) return "";

  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");

  const hunks = computeHunks(beforeLines, afterLines);

  if (hunks.length === 0) return "";

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ].join("\n");

  const body = hunks.map(renderHunk).join("\n");

  return `${header}\n${body}\n`;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

const CONTEXT_LINES = 3;

function computeHunks(before: string[], after: string[]): Hunk[] {
  // Myers-style LCS via simple DP edit distance tracking
  const edits = computeEdits(before, after);
  const hunks: Hunk[] = [];

  let i = 0;
  while (i < edits.length) {
    const edit = edits[i];

    // Skip context-only regions
    if (edit.type === "=") {
      i++;
      continue;
    }

    // Found a changed region — gather surrounding context and adjacent changes
    const start = Math.max(0, i - CONTEXT_LINES);
    let end = i;

    while (end < edits.length) {
      if (edits[end].type !== "=") {
        end++;
        continue;
      }
      // Check whether next change is within context range
      let nextChange = end + 1;
      while (nextChange < edits.length && edits[nextChange].type === "=") {
        nextChange++;
      }
      if (nextChange - end > CONTEXT_LINES * 2) break;
      end = nextChange;
    }

    end = Math.min(edits.length, end + CONTEXT_LINES);

    const hunkEdits = edits.slice(start, end);
    const lines: string[] = [];
    let beforeStart = -1;
    let beforeCount = 0;
    let afterStart = -1;
    let afterCount = 0;

    for (const e of hunkEdits) {
      if (beforeStart === -1 && (e.type === "=" || e.type === "-")) {
        beforeStart = e.beforeIdx ?? 0;
      }
      if (afterStart === -1 && (e.type === "=" || e.type === "+")) {
        afterStart = e.afterIdx ?? 0;
      }

      if (e.type === "=") {
        lines.push(` ${e.text}`);
        beforeCount++;
        afterCount++;
      } else if (e.type === "-") {
        lines.push(`-${e.text}`);
        beforeCount++;
      } else {
        lines.push(`+${e.text}`);
        afterCount++;
      }
    }

    hunks.push({
      beforeStart: beforeStart + 1,
      beforeCount,
      afterStart: afterStart + 1,
      afterCount,
      lines,
    });

    i = end;
  }

  return hunks;
}

interface Edit {
  type: "=" | "+" | "-";
  text: string;
  beforeIdx?: number;
  afterIdx?: number;
}

/**
 * Compute a line-level edit list using a simple LCS algorithm.
 */
function computeEdits(before: string[], after: string[]): Edit[] {
  const m = before.length;
  const n = after.length;

  // dp[i][j] = length of LCS(before[0..i-1], after[0..j-1])
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (before[i - 1] === after[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Trace back through DP table
  const edits: Edit[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      edits.unshift({
        type: "=",
        text: before[i - 1],
        beforeIdx: i - 1,
        afterIdx: j - 1,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ type: "+", text: after[j - 1], afterIdx: j - 1 });
      j--;
    } else {
      edits.unshift({ type: "-", text: before[i - 1], beforeIdx: i - 1 });
      i--;
    }
  }

  return edits;
}

function renderHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`;
  return [header, ...hunk.lines].join("\n");
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
