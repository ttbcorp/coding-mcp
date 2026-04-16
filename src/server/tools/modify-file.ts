import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ModifyFileInputSchema } from "../../schemas/tools.js";
import type { CodingTaskService } from "../../services/coding-task.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

/**
 * Handler for the `modify_file` MCP tool.
 *
 * Validates input with ModifyFileInputSchema, creates a scoped workspace
 * from project_root, delegates to CodingTaskService.modifyFile(), and
 * returns a MCP CallToolResult.
 */
export async function handleModifyFile(
  args: unknown,
  service: CodingTaskService,
  createScopedWorkspace: (projectRoot: string) => WorkspaceManager
): Promise<CallToolResult> {
  const parsed = ModifyFileInputSchema.safeParse(args);
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

  try {
    const workspace = createScopedWorkspace(parsed.data.project_root);
    const result = await service.modifyFile(parsed.data, workspace);
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
