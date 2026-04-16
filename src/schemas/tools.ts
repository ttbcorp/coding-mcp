import { z } from "zod";
import { FilePathSchema, LanguageSchema } from "./common.js";

/**
 * Zod input/output schemas for each MCP tool exposed by this server.
 *
 * Naming convention:
 *   <ToolName>InputSchema  — validated before execution
 *   <ToolName>OutputSchema — validated before returning to the client
 *
 * Inferred TypeScript types are exported alongside each schema pair.
 */

// ---------------------------------------------------------------------------
// 1. generate_file
// ---------------------------------------------------------------------------

/**
 * Input schema for the `generate_file` tool.
 * Instructs the server to create a new file at `path` with the specified
 * language and intent.
 */
export const GenerateFileInputSchema = z
  .object({
    project_root: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the project root (e.g. /Users/me/projects/my-app). Must be within WORKSPACE_ROOT."
      ),
    path: FilePathSchema.describe("Destination path for the generated file, relative to project_root"),
    description: z
      .string()
      .min(1)
      .describe("Natural-language description of what the file should contain"),
    language: LanguageSchema,
    style_hints: z
      .string()
      .optional()
      .describe(
        "Optional style or API constraints (e.g. 'use functional components', 'no default exports')"
      ),
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        "When true, an existing file at the target path will be replaced"
      ),
  })
  .describe("Parameters for the generate_file tool");

export type GenerateFileInput = z.infer<typeof GenerateFileInputSchema>;

/**
 * Output schema for the `generate_file` tool.
 */
export const GenerateFileOutputSchema = z
  .object({
    path: FilePathSchema.describe("Absolute or workspace-relative path where the file was written"),
    content: z.string().describe("Full content that was written to the file"),
    lines_written: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of lines written to the file"),
  })
  .describe("Result returned by the generate_file tool");

export type GenerateFileOutput = z.infer<typeof GenerateFileOutputSchema>;

// ---------------------------------------------------------------------------
// 2. modify_file
// ---------------------------------------------------------------------------

/**
 * Input schema for the `modify_file` tool.
 * Applies a natural-language instruction to an existing file.
 */
export const ModifyFileInputSchema = z
  .object({
    project_root: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the project root. Must be within WORKSPACE_ROOT."
      ),
    path: FilePathSchema.describe("Path of the file to modify, relative to project_root"),
    instruction: z
      .string()
      .min(1)
      .describe(
        "Natural-language description of the modification to apply (e.g. 'add error handling to the fetchUser function')"
      ),
    context_files: z
      .array(FilePathSchema)
      .optional()
      .describe(
        "Optional list of additional files to include as context when generating the modification"
      ),
  })
  .describe("Parameters for the modify_file tool");

export type ModifyFileInput = z.infer<typeof ModifyFileInputSchema>;

/**
 * Output schema for the `modify_file` tool.
 */
export const ModifyFileOutputSchema = z
  .object({
    path: FilePathSchema.describe("Path of the file that was modified"),
    diff: z
      .string()
      .describe("Unified diff showing the changes applied to the file"),
    lines_changed: z
      .number()
      .int()
      .nonnegative()
      .describe("Total number of lines added plus lines removed"),
  })
  .describe("Result returned by the modify_file tool");

export type ModifyFileOutput = z.infer<typeof ModifyFileOutputSchema>;

// ---------------------------------------------------------------------------
// 3. apply_workspace_write
// ---------------------------------------------------------------------------

/**
 * Input schema for the `apply_workspace_write` tool.
 * Writes arbitrary content to a file in the workspace.
 */
export const ApplyWorkspaceWriteInputSchema = z
  .object({
    project_root: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the project root. Must be within WORKSPACE_ROOT."
      ),
    path: FilePathSchema.describe("Destination path for the file write, relative to project_root"),
    content: z.string().describe("Content to write to the file"),
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        "When true, an existing file at the path will be overwritten; when false the operation fails if the file exists"
      ),
    backup: z
      .boolean()
      .default(true)
      .describe(
        "When true, a .bak copy of the existing file is created before overwriting"
      ),
  })
  .describe("Parameters for the apply_workspace_write tool");

export type ApplyWorkspaceWriteInput = z.infer<typeof ApplyWorkspaceWriteInputSchema>;

/**
 * Output schema for the `apply_workspace_write` tool.
 */
export const ApplyWorkspaceWriteOutputSchema = z
  .object({
    path: FilePathSchema.describe("Path where the content was written"),
    written: z
      .boolean()
      .describe("True when the file was successfully written to disk"),
    backed_up: z
      .string()
      .optional()
      .describe("Path to the backup file that was created, if any"),
  })
  .describe("Result returned by the apply_workspace_write tool");

export type ApplyWorkspaceWriteOutput = z.infer<typeof ApplyWorkspaceWriteOutputSchema>;

// ---------------------------------------------------------------------------
// 4. preview_diff
// ---------------------------------------------------------------------------

/**
 * Input schema for the `preview_diff` tool.
 * Produces a diff between the current file content and the proposed new content
 * without writing any changes to disk.
 */
export const PreviewDiffInputSchema = z
  .object({
    project_root: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the project root. Must be within WORKSPACE_ROOT."
      ),
    path: FilePathSchema.describe(
      "Path of the existing file to compare against, relative to project_root"
    ),
    new_content: z
      .string()
      .describe("Proposed replacement content for the file"),
  })
  .describe("Parameters for the preview_diff tool");

export type PreviewDiffInput = z.infer<typeof PreviewDiffInputSchema>;

/**
 * Output schema for the `preview_diff` tool.
 */
export const PreviewDiffOutputSchema = z
  .object({
    diff: z
      .string()
      .describe("Unified diff between the current file and new_content"),
    additions: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of lines added in the diff"),
    deletions: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of lines removed in the diff"),
  })
  .describe("Result returned by the preview_diff tool");

export type PreviewDiffOutput = z.infer<typeof PreviewDiffOutputSchema>;

// ---------------------------------------------------------------------------
// 5. list_workspace_tree
// ---------------------------------------------------------------------------

/**
 * Input schema for the `list_workspace_tree` tool.
 * Lists files in the workspace matching an optional glob pattern.
 */
export const ListWorkspaceTreeInputSchema = z
  .object({
    project_root: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the project root to list files from. Must be within WORKSPACE_ROOT."
      ),
    pattern: z
      .string()
      .default("**/*")
      .describe(
        "Glob pattern used to filter workspace files (default: '**/*' to list everything)"
      ),
    max_depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum directory depth to traverse; omit for unlimited depth"
      ),
  })
  .describe("Parameters for the list_workspace_tree tool");

export type ListWorkspaceTreeInput = z.infer<typeof ListWorkspaceTreeInputSchema>;

/**
 * Output schema for the `list_workspace_tree` tool.
 */
export const ListWorkspaceTreeOutputSchema = z
  .object({
    files: z
      .array(z.string().describe("Workspace-relative file path"))
      .describe("Sorted list of file paths matching the requested pattern"),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe("Total number of files returned in the listing"),
  })
  .describe("Result returned by the list_workspace_tree tool");

export type ListWorkspaceTreeOutput = z.infer<typeof ListWorkspaceTreeOutputSchema>;
