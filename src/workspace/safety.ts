import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

/**
 * Result returned by all SafetyValidator checks.
 */
export interface SafetyCheckResult {
  readonly safe: boolean;
  readonly reason?: string;
  readonly normalizedPath: string;
}

/**
 * Magic byte signatures for common binary formats.
 * Checked against the first 8 bytes of a file.
 */
const BINARY_MAGIC_BYTES: ReadonlyArray<{ sig: number[]; label: string }> = [
  { sig: [0x89, 0x50, 0x4e, 0x47], label: "PNG" },
  { sig: [0xff, 0xd8, 0xff], label: "JPEG" },
  { sig: [0x47, 0x49, 0x46], label: "GIF" },
  { sig: [0x25, 0x50, 0x44, 0x46], label: "PDF" },
  { sig: [0x50, 0x4b, 0x03, 0x04], label: "ZIP/DOCX/XLSX" },
  { sig: [0x7f, 0x45, 0x4c, 0x46], label: "ELF" },
  { sig: [0xca, 0xfe, 0xba, 0xbe], label: "Mach-O" },
  { sig: [0x4d, 0x5a], label: "PE/EXE" },
  { sig: [0x1f, 0x8b], label: "GZIP" },
  { sig: [0x42, 0x5a, 0x68], label: "BZIP2" },
];

const DEFAULT_FILE_SIZE_LIMIT = 1_048_576; // 1 MB

/**
 * SafetyValidator enforces filesystem access policies.
 *
 * Prevents path traversal, symlink escapes, out-of-root writes, binary file
 * access, oversized files, and accidental overwrites with optional conflict
 * detection via content hashes.
 */
export class SafetyValidator {
  private readonly allowedRoot: string;

  constructor(allowedRoot: string) {
    this.allowedRoot = path.resolve(allowedRoot);
  }

  /**
   * Validates that a given input path resolves within the workspace root.
   *
   * Steps:
   *  1. Resolve the path (handles `../` traversal via path.resolve)
   *  2. Ensure the resolved path starts with allowedRoot
   *  3. Optionally resolve symlinks (fs.realpath) and re-check
   *
   * @returns SafetyCheckResult — safe=false if path escapes the root
   */
  async validatePath(
    inputPath: string,
    workspaceRoot?: string
  ): Promise<SafetyCheckResult> {
    const root = workspaceRoot
      ? path.resolve(workspaceRoot)
      : this.allowedRoot;

    const normalized = path.resolve(root, inputPath);

    if (!this.isWithinRoot(normalized, root)) {
      return {
        safe: false,
        reason: `Path traversal detected: "${inputPath}" resolves outside workspace root "${root}"`,
        normalizedPath: normalized,
      };
    }

    // Attempt symlink resolution; if the file doesn't exist yet that's fine.
    try {
      const real = await fs.realpath(normalized);
      // Also resolve the root to handle OS-level symlinks (e.g. /var -> /private/var on macOS)
      let realRoot = root;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        // Root itself not found — keep original
      }
      if (!this.isWithinRoot(real, realRoot)) {
        return {
          safe: false,
          reason: `Symlink escape detected: "${inputPath}" resolves to "${real}" which is outside "${realRoot}"`,
          normalizedPath: normalized,
        };
      }
    } catch {
      // File doesn't exist yet — no symlink to follow, path is fine.
    }

    return { safe: true, normalizedPath: normalized };
  }

  /**
   * Synchronous path validation (no symlink check).
   * Use when async is not available; prefer validatePath otherwise.
   */
  validatePathSync(
    inputPath: string,
    workspaceRoot?: string
  ): SafetyCheckResult {
    const root = workspaceRoot
      ? path.resolve(workspaceRoot)
      : this.allowedRoot;

    const normalized = path.resolve(root, inputPath);

    if (!this.isWithinRoot(normalized, root)) {
      return {
        safe: false,
        reason: `Path traversal detected: "${inputPath}" resolves outside workspace root "${root}"`,
        normalizedPath: normalized,
      };
    }

    return { safe: true, normalizedPath: normalized };
  }

  /**
   * Checks whether writing to targetPath is safe given overwrite options.
   *
   * - Blocks write when file exists and overwrite is not set
   * - When lastReadHash is provided, compares it against the current file
   *   hash to detect concurrent modifications (conflict detection)
   *
   * @param targetPath - Absolute path that has already been validated
   * @param opts.overwrite - Allow overwriting an existing file
   * @param opts.lastReadHash - SHA-256 hex of content when last read
   */
  async checkOverwrite(
    targetPath: string,
    opts: { overwrite?: boolean; lastReadHash?: string } = {}
  ): Promise<SafetyCheckResult> {
    let exists = false;

    try {
      await fs.access(targetPath);
      exists = true;
    } catch {
      // File does not exist — overwrite check passes.
    }

    if (!exists) {
      return { safe: true, normalizedPath: targetPath };
    }

    if (!opts.overwrite) {
      return {
        safe: false,
        reason: `File already exists and overwrite is not set: "${targetPath}"`,
        normalizedPath: targetPath,
      };
    }

    if (opts.lastReadHash !== undefined) {
      const currentContent = await fs.readFile(targetPath);
      const currentHash = this.computeHash(currentContent.toString("utf8"));

      if (currentHash !== opts.lastReadHash) {
        return {
          safe: false,
          reason: `Conflict detected: file "${targetPath}" was modified since last read (hash mismatch)`,
          normalizedPath: targetPath,
        };
      }
    }

    return { safe: true, normalizedPath: targetPath };
  }

  /**
   * Reads the first bytes of a file and compares against known binary magic
   * byte signatures. Returns true when the file appears to be binary.
   *
   * @param filePath - Absolute path to the file
   */
  async isBinaryFile(filePath: string): Promise<boolean> {
    let handle: fs.FileHandle | undefined;

    try {
      handle = await fs.open(filePath, "r");
      const buf = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buf, 0, 8, 0);

      if (bytesRead === 0) {
        return false;
      }

      const bytes = Array.from(buf.subarray(0, bytesRead));

      for (const { sig } of BINARY_MAGIC_BYTES) {
        if (sig.every((byte, i) => bytes[i] === byte)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Checks that a file does not exceed the given byte limit.
   * Returns a failed SafetyCheckResult when the limit is exceeded.
   *
   * @param filePath - Absolute path to the file
   * @param limitBytes - Maximum allowed size in bytes (default 1 MB)
   */
  async checkFileSize(
    filePath: string,
    limitBytes: number = DEFAULT_FILE_SIZE_LIMIT
  ): Promise<SafetyCheckResult> {
    try {
      const stat = await fs.stat(filePath);

      if (stat.size > limitBytes) {
        return {
          safe: false,
          reason: `File "${filePath}" exceeds size limit (${stat.size} bytes > ${limitBytes} bytes)`,
          normalizedPath: filePath,
        };
      }

      return { safe: true, normalizedPath: filePath };
    } catch {
      // File not found — no size to check.
      return { safe: true, normalizedPath: filePath };
    }
  }

  /**
   * Computes a SHA-256 hex digest of the given string content.
   *
   * @param content - UTF-8 string content
   * @returns Lowercase hex string
   */
  computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }

  // ---------------------------------------------------------------------------
  // Legacy synchronous API (kept for backward compatibility with existing callers)
  // ---------------------------------------------------------------------------

  /**
   * Resolves and validates that a target path stays within allowedRoot.
   * Throws if the resolved path escapes the root.
   *
   * @deprecated Prefer the async validatePath method for symlink safety.
   */
  validatePath_sync(targetPath: string): string {
    const normalized = path.resolve(this.allowedRoot, targetPath);

    if (!this.isWithinRoot(normalized, this.allowedRoot)) {
      throw new Error(
        `Path "${targetPath}" resolves outside workspace root "${this.allowedRoot}"`
      );
    }

    return normalized;
  }

  /**
   * Returns true when the path is within allowedRoot (non-throwing variant).
   */
  isAllowed(targetPath: string): boolean {
    try {
      this.validatePath_sync(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates a list of paths, returning only the allowed subset.
   */
  filterAllowed(paths: string[]): string[] {
    return paths.filter((p) => this.isAllowed(p));
  }

  get root(): string {
    return this.allowedRoot;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isWithinRoot(normalized: string, root: string): boolean {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return normalized === root || normalized.startsWith(rootWithSep);
  }
}
