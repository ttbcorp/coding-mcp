import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

export const WORKSPACE_TREE_URI = "workspace://tree";

/**
 * Resource handler for `workspace://tree`.
 *
 * Returns the full workspace file listing as a JSON text resource.
 */
export async function readWorkspaceTree(
  workspace: WorkspaceManager
): Promise<ReadResourceResult> {
  const entries = await workspace.listTree();
  const files = entries.map((e) => e.relativePath);

  const payload = JSON.stringify({ files, total: files.length }, null, 2);

  return {
    contents: [
      {
        uri: WORKSPACE_TREE_URI,
        mimeType: "application/json",
        text: payload,
      },
    ],
  };
}
