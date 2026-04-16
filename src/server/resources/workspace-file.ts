import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

export const WORKSPACE_FILE_URI_TEMPLATE = "workspace://file/{path}";

/**
 * Resource handler for `workspace://file/{path}`.
 *
 * Extracts the file path from the URI, reads the file via WorkspaceManager,
 * and returns the content as a text resource.
 *
 * @param uri      - The fully resolved URI, e.g. `workspace://file/src/index.ts`
 * @param workspace - WorkspaceManager instance to read from
 */
export async function readWorkspaceFile(
  uri: URL,
  workspace: WorkspaceManager
): Promise<ReadResourceResult> {
  // URI format: workspace://file/<relative-path>
  // uri.pathname is "/<relative-path>", uri.host is "file"
  // We need to combine host + pathname to get the full path segment
  const rawPath = decodeURIComponent(uri.pathname.replace(/^\//, ""));

  if (!rawPath) {
    throw new Error(`Invalid workspace file URI: "${uri.toString()}" — missing file path`);
  }

  const content = await workspace.readFile(rawPath);

  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "text/plain",
        text: content,
      },
    ],
  };
}
