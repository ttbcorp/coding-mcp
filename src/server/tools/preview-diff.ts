import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PreviewDiffInputSchema } from "../../schemas/tools.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

/**
 * Counts added and removed lines in a unified diff string.
 */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  const lines = diff.split("\n");
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Handler for the `preview_diff` MCP tool.
 *
 * Validates input with PreviewDiffInputSchema, creates a scoped workspace
 * from project_root, delegates to WorkspaceManager.previewDiff(), and
 * returns a MCP CallToolResult.
 */
export async function handlePreviewDiff(
  args: unknown,
  createScopedWorkspace: (projectRoot: string) => WorkspaceManager
): Promise<CallToolResult> {
  const parsed = PreviewDiffInputSchema.safeParse(args);
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

  const { project_root, path, new_content } = parsed.data;
  const workspace = createScopedWorkspace(project_root);

  try {
    const preview = await workspace.previewDiff(path, new_content);
    const { additions, deletions } = countDiffLines(preview.unified);

    const result = {
      diff: preview.unified,
      additions,
      deletions,
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
