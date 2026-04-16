import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ListWorkspaceTreeInputSchema } from "../../schemas/tools.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

/**
 * Handler for the `list_workspace_tree` MCP tool.
 *
 * Validates input with ListWorkspaceTreeInputSchema, creates a scoped
 * workspace from project_root, delegates to WorkspaceManager.listTree(),
 * and returns a MCP CallToolResult.
 */
export async function handleListWorkspaceTree(
  args: unknown,
  createScopedWorkspace: (projectRoot: string) => WorkspaceManager
): Promise<CallToolResult> {
  const parsed = ListWorkspaceTreeInputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid input: ${parsed.error.message}`,
        },
      ],
      isError: true,
    };
  }

  const { project_root, pattern } = parsed.data;
  const workspace = createScopedWorkspace(project_root);

  try {
    const entries = await workspace.listTree(pattern);
    const files = entries.map((e) => e.relativePath);

    const result = {
      files,
      total: files.length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}
