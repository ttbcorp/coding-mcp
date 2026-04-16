import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApplyWorkspaceWriteInputSchema } from "../../schemas/tools.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

/**
 * Handler for the `apply_workspace_write` MCP tool.
 *
 * Validates input with ApplyWorkspaceWriteInputSchema, creates a scoped
 * workspace from project_root, delegates to WorkspaceManager.writeFile(),
 * and returns a MCP CallToolResult.
 */
export async function handleApplyWorkspaceWrite(
  args: unknown,
  createScopedWorkspace: (projectRoot: string) => WorkspaceManager
): Promise<CallToolResult> {
  const parsed = ApplyWorkspaceWriteInputSchema.safeParse(args);
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

  const { project_root, path, content, overwrite, backup } = parsed.data;
  const workspace = createScopedWorkspace(project_root);

  try {
    const writeResult = await workspace.writeFile(path, content, {
      overwrite,
      backup,
    });

    if (!writeResult.success) {
      return {
        content: [
          {
            type: "text",
            text: writeResult.error ?? "Write failed for unknown reason",
          },
        ],
        isError: true,
      };
    }

    const result = {
      path: writeResult.path,
      written: writeResult.success,
      backed_up: writeResult.backupPath,
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
