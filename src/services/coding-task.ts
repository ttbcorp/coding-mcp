import type { OllamaClient } from "../ollama/client.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { TaskStatus } from "../schemas/common.js";
import type {
  GenerateFileInput,
  GenerateFileOutput,
  ModifyFileInput,
  ModifyFileOutput,
} from "../schemas/tools.js";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}

/**
 * Extracts raw code from a model response that may contain markdown fences.
 */
function extractCode(raw: string): string {
  // Try to extract from a code fence block
  const fenceMatch = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trimEnd();
  }
  return raw.trim();
}

/**
 * Counts added and removed lines in a unified diff.
 */
function countDiffLines(diff: string): number {
  const lines = diff.split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) count++;
    if (line.startsWith("-") && !line.startsWith("---")) count++;
  }
  return count;
}

/**
 * CodingTaskService orchestrates the coding pipeline:
 *
 *   plan -> collect context -> call Ollama -> validate output -> write files
 *
 * This layer owns business logic and must not import MCP SDK types.
 * It depends on OllamaClient and WorkspaceManager abstractions only.
 */
export class CodingTaskService {
  private readonly ollama: OllamaClient;

  constructor(ollama: OllamaClient) {
    this.ollama = ollama;
  }

  /**
   * Generates a new file based on a description and language.
   *
   * Steps:
   *  1. listTree() to understand project structure
   *  2. Build a structured prompt with context
   *  3. Call ollama.generate() (think:false forced by client)
   *  4. Extract code from response
   *  5. Write via workspace.writeFile() (Verified Write)
   */
  async generateFile(
    input: GenerateFileInput,
    workspace: WorkspaceManager
  ): Promise<GenerateFileOutput> {
    // 1. Get project structure for context
    const tree = await workspace.listTree();
    const structureSummary = tree
      .slice(0, 50)
      .map((e) => e.relativePath)
      .join("\n");

    const context =
      tree.length > 0
        ? `Project files (first 50):\n${structureSummary}`
        : "Empty project";

    // 2. Build structured prompt
    const prompt = this.ollama.buildStructuredPrompt({
      action: "Generate a new file",
      filePath: input.path,
      language: input.language,
      context,
      instructions: [
        input.description,
        input.style_hints ? `Style: ${input.style_hints}` : null,
        "Output ONLY the file content. No prose, no explanations.",
        "Use a markdown code fence if needed, but nothing else.",
      ]
        .filter(Boolean)
        .join("\n"),
      outputFormat: `Raw ${input.language} source code`,
    });

    // 3. Call Ollama (think:false is forced by OllamaClient)
    const response = await this.ollama.generate(prompt);

    // 4. Extract the code
    const content = extractCode(response.response);

    if (!content) {
      throw new Error("Ollama returned an empty response for generateFile");
    }

    // 5. Write to workspace (Verified Write)
    const writeResult = await workspace.writeFile(
      input.path,
      content,
      { overwrite: input.overwrite }
    );

    if (!writeResult.success) {
      throw new Error(
        `Failed to write file "${input.path}": ${writeResult.error ?? "unknown error"}`
      );
    }

    const lines_written = content.split("\n").length;

    return {
      path: writeResult.path,
      content,
      lines_written,
    };
  }

  /**
   * Modifies an existing file according to the given instruction.
   *
   * Steps:
   *  1. Read the existing file
   *  2. Optionally read context_files and compress them
   *  3. Build a chat conversation
   *  4. Call ollama.chat()
   *  5. Extract modified content and compute diff
   *  6. Write modified content back
   */
  async modifyFile(
    input: ModifyFileInput,
    workspace: WorkspaceManager
  ): Promise<ModifyFileOutput> {
    // 1. Read existing file
    const originalContent = await workspace.readFile(input.path);

    // 2. Read and compact context files
    let contextSection = "";
    if (input.context_files && input.context_files.length > 0) {
      const parts: string[] = [];
      for (const ctxPath of input.context_files) {
        try {
          const ctxContent = await workspace.readFile(ctxPath);
          const compacted = this.ollama.microCompact(ctxContent);
          parts.push(`### ${ctxPath}\n\`\`\`\n${compacted}\n\`\`\``);
        } catch {
          // Skip unreadable context files silently — not blocking
        }
      }
      if (parts.length > 0) {
        contextSection = `\n\n## Additional Context\n${parts.join("\n\n")}`;
      }
    }

    // 3. Build chat messages
    const systemMessage = [
      "You are an expert code editor.",
      "When given a file and an instruction, output ONLY the complete modified file content.",
      "Do not add prose, explanations, or commentary.",
      "Wrap the output in a single markdown code fence.",
    ].join(" ");

    const userMessage = [
      `## File: ${input.path}`,
      "```",
      this.ollama.microCompact(originalContent, 40, 20),
      "```",
      contextSection,
      `## Instruction\n${input.instruction}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // 4. Call Ollama chat (think:false is forced by OllamaClient)
    const response = await this.ollama.chat([
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ]);

    // 5. Extract modified content
    const modifiedContent = extractCode(response.message.content);

    if (!modifiedContent) {
      throw new Error("Ollama returned an empty response for modifyFile");
    }

    // 6. Compute diff before writing
    const diffPreview = await workspace.previewDiff(
      input.path,
      modifiedContent
    );

    // 7. Write modified content back (overwrite allowed since file exists)
    const writeResult = await workspace.writeFile(
      input.path,
      modifiedContent,
      { overwrite: true }
    );

    if (!writeResult.success) {
      throw new Error(
        `Failed to write modified file "${input.path}": ${writeResult.error ?? "unknown error"}`
      );
    }

    const lines_changed = countDiffLines(diffPreview.unified);

    return {
      path: writeResult.path,
      diff: diffPreview.unified,
      lines_changed,
    };
  }
}
