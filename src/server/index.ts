import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { OllamaClient } from "../ollama/client.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { CodingTaskService } from "../services/coding-task.js";

// Tool handlers
import { handleGenerateFile } from "./tools/generate-file.js";
import { handleModifyFile } from "./tools/modify-file.js";
import { handleApplyWorkspaceWrite } from "./tools/apply-workspace-write.js";
import { handlePreviewDiff } from "./tools/preview-diff.js";
import { handleListWorkspaceTree } from "./tools/list-workspace-tree.js";

// Resource handlers
import { readWorkspaceTree, WORKSPACE_TREE_URI } from "./resources/workspace-tree.js";
import { readWorkspaceFile } from "./resources/workspace-file.js";

/**
 * Creates and configures the MCP server instance.
 *
 * Environment variables:
 *   OLLAMA_BASE_URL   - Ollama daemon URL (default: http://localhost:11434)
 *   OLLAMA_MODEL      - Model to use (default: qwen2.5-coder:14b)
 *   WORKSPACE_ROOT    - Root directory for workspace (default: process.cwd())
 */
export function createServer(): McpServer {
  // WORKSPACE_ROOT is the security boundary — no project_root can escape above this.
  const workspaceBoundary = path.resolve(
    process.env["WORKSPACE_ROOT"] ?? process.cwd()
  );

  const ollama = new OllamaClient({
    baseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434",
    defaultModel: process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:14b",
  });

  const codingService = new CodingTaskService(ollama);

  /**
   * Creates a WorkspaceManager scoped to the given project root.
   * Throws if project_root escapes the WORKSPACE_ROOT boundary.
   */
  function createScopedWorkspace(projectRoot: string): WorkspaceManager {
    const resolved = path.resolve(projectRoot);
    const withinBoundary =
      resolved === workspaceBoundary ||
      resolved.startsWith(workspaceBoundary + path.sep);

    if (!withinBoundary) {
      throw new Error(
        `project_root "${resolved}" is outside the allowed boundary "${workspaceBoundary}". ` +
          `Set WORKSPACE_ROOT to a parent of your projects.`
      );
    }

    return new WorkspaceManager(resolved);
  }

  const server = new McpServer(
    { name: "coding-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ─── Tools ────────────────────────────────────────────────────────────────

  const projectRootSchema = z
    .string()
    .min(1)
    .describe(
      "Absolute path to the project root (e.g. /Users/me/projects/my-app). Must be within WORKSPACE_ROOT."
    );

  server.registerTool(
    "generate_file",
    {
      description: "Generate a new source file from a natural-language description using a local Ollama model",
      inputSchema: {
        project_root: projectRootSchema,
        path: z.string().min(1).describe("Destination path, relative to project_root"),
        description: z.string().min(1).describe("Natural-language description of what the file should contain"),
        language: z.enum(["typescript", "javascript", "python", "go", "rust", "java", "other"])
          .describe("Programming language of the target file"),
        style_hints: z.string().optional().describe("Optional style or API constraints"),
        overwrite: z.boolean().default(false).describe("When true, replace an existing file"),
      },
    },
    (args) => handleGenerateFile(args, codingService, createScopedWorkspace)
  );

  server.registerTool(
    "modify_file",
    {
      description: "Apply a natural-language modification instruction to an existing file",
      inputSchema: {
        project_root: projectRootSchema,
        path: z.string().min(1).describe("Path of the file to modify, relative to project_root"),
        instruction: z.string().min(1).describe("Natural-language description of the modification"),
        context_files: z.array(z.string().min(1)).optional()
          .describe("Optional list of additional files to include as context"),
      },
    },
    (args) => handleModifyFile(args, codingService, createScopedWorkspace)
  );

  server.registerTool(
    "apply_workspace_write",
    {
      description: "Write arbitrary content to a file in the workspace with optional backup",
      inputSchema: {
        project_root: projectRootSchema,
        path: z.string().min(1).describe("Destination path, relative to project_root"),
        content: z.string().describe("Content to write to the file"),
        overwrite: z.boolean().default(false).describe("When true, overwrite an existing file"),
        backup: z.boolean().default(true).describe("When true, create a .bak backup before overwriting"),
      },
    },
    (args) => handleApplyWorkspaceWrite(args, createScopedWorkspace)
  );

  server.registerTool(
    "preview_diff",
    {
      description: "Preview a unified diff between the current file content and proposed new content without writing",
      inputSchema: {
        project_root: projectRootSchema,
        path: z.string().min(1).describe("Path of the existing file to compare against"),
        new_content: z.string().describe("Proposed replacement content for the file"),
      },
    },
    (args) => handlePreviewDiff(args, createScopedWorkspace)
  );

  server.registerTool(
    "list_workspace_tree",
    {
      description: "List files in the workspace matching an optional glob pattern",
      inputSchema: {
        project_root: projectRootSchema,
        pattern: z.string().default("**/*").describe("Glob pattern to filter workspace files"),
      },
    },
    (args) => handleListWorkspaceTree(args, createScopedWorkspace)
  );

  // ─── Resources ───────────────────────────────────────────────────────────

  // Default workspace scoped to the boundary root (used by resources).
  // Individual tool calls use createScopedWorkspace(project_root) instead.
  const defaultWorkspace = new WorkspaceManager(workspaceBoundary);

  server.registerResource(
    "workspace-tree",
    WORKSPACE_TREE_URI,
    { mimeType: "application/json", description: "Full listing of all workspace files as JSON" },
    (_uri) => readWorkspaceTree(defaultWorkspace)
  );

  server.registerResource(
    "workspace-file",
    new ResourceTemplate("workspace://file/{path}", { list: undefined }),
    { mimeType: "text/plain", description: "Read a file from the workspace by path" },
    (uri, _variables) => readWorkspaceFile(uri, defaultWorkspace)
  );

  return server;
}
