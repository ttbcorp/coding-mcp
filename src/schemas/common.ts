import { z } from "zod";

/**
 * Common Zod schemas and TypeScript types shared across tool and resource definitions.
 */

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/**
 * Workspace-relative or absolute file path.
 * Must be a non-empty string.
 */
export const FilePathSchema = z
  .string()
  .min(1, "File path must not be empty")
  .describe("Path to the target file");

/**
 * Supported programming languages for code generation.
 * Use 'other' when the language is not explicitly listed.
 */
export const LanguageSchema = z
  .enum([
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "other",
  ])
  .describe(
    "Programming language of the target file. Use 'other' for unlisted languages."
  );

export type Language = z.infer<typeof LanguageSchema>;

// ---------------------------------------------------------------------------
// Task status
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for an asynchronous coding task.
 *
 * queued             → input received, not yet started
 * collecting_context → reading workspace files
 * calling_model      → Ollama request in flight
 * validating_output  → parsing and validating model response
 * writing_files      → applying changes to the filesystem
 * completed          → all changes applied successfully
 * failed             → terminal failure
 */
export const TaskStatusSchema = z
  .enum([
    "queued",
    "collecting_context",
    "calling_model",
    "validating_output",
    "writing_files",
    "completed",
    "failed",
  ])
  .describe("Current lifecycle state of a coding task");

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// ---------------------------------------------------------------------------
// API response envelopes
// ---------------------------------------------------------------------------

/**
 * Successful API response wrapping an arbitrary data payload.
 *
 * @template T - Shape of the data field
 */
export type SuccessResponse<T> = {
  readonly success: true;
  readonly data: T;
};

/**
 * Failed API response with a human-readable error message and optional code.
 */
export type ErrorResponse = {
  readonly success: false;
  readonly error: string;
  readonly code?: string;
};

/**
 * Discriminated union of {@link SuccessResponse} and {@link ErrorResponse}.
 *
 * @template T - Shape of the data field on the success branch
 */
export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// ---------------------------------------------------------------------------
// Zod schema constructors for response envelopes
// ---------------------------------------------------------------------------

/**
 * Builds a Zod schema for {@link SuccessResponse} around a given data schema.
 *
 * @param dataSchema - Zod schema describing the `data` payload
 * @returns Zod object schema with `success: true` and `data: T`
 */
export const SuccessResponseSchema = <T extends z.ZodTypeAny>(
  dataSchema: T
) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

/**
 * Zod schema for {@link ErrorResponse}.
 */
export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().describe("Human-readable error description"),
  code: z.string().optional().describe("Machine-readable error code"),
});

// ---------------------------------------------------------------------------
// MCP inputSchema conversion utility
// ---------------------------------------------------------------------------

/**
 * Converts a Zod object schema into the JSON Schema object expected by the
 * MCP `inputSchema` field.
 *
 * The MCP SDK expects a plain JSON Schema document (not a Zod instance).
 * This utility uses `zod`'s built-in `_def` introspection to produce a
 * compatible representation.  It handles the most common Zod types used in
 * tool schemas:
 *   - ZodObject  → `{ type: "object", properties, required }`
 *   - ZodString  → `{ type: "string" }`
 *   - ZodNumber  → `{ type: "number" }`
 *   - ZodBoolean → `{ type: "boolean" }`
 *   - ZodEnum    → `{ type: "string", enum: [...] }`
 *   - ZodArray   → `{ type: "array", items }`
 *   - ZodOptional / ZodDefault → unwraps and delegates to inner type
 *   - ZodLiteral → `{ const: value }`
 *
 * @param zodSchema - Any Zod schema (typically `z.ZodObject`)
 * @returns A plain JSON Schema object suitable for MCP `inputSchema`
 */
export function toMcpInputSchema(zodSchema: z.ZodTypeAny): Record<string, unknown> {
  return convertZodToJsonSchema(zodSchema);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Recursively converts a single Zod node to a JSON Schema fragment. */
function convertZodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as z.ZodTypeDef & {
    typeName: string;
    description?: string;
  };

  const description: Record<string, unknown> =
    def.description ? { description: def.description } : {};

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string", ...description };

    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number", ...description };

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean", ...description };

    case z.ZodFirstPartyTypeKind.ZodEnum: {
      const enumDef = def as unknown as { values: string[] };
      return { type: "string", enum: enumDef.values, ...description };
    }

    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const litDef = def as unknown as { value: unknown };
      return { const: litDef.value, ...description };
    }

    case z.ZodFirstPartyTypeKind.ZodArray: {
      const arrDef = def as unknown as { type: z.ZodTypeAny };
      return {
        type: "array",
        items: convertZodToJsonSchema(arrDef.type),
        ...description,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodOptional: {
      const optDef = def as unknown as { innerType: z.ZodTypeAny };
      return convertZodToJsonSchema(optDef.innerType);
    }

    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const dfltDef = def as unknown as {
        innerType: z.ZodTypeAny;
        defaultValue: () => unknown;
      };
      const inner = convertZodToJsonSchema(dfltDef.innerType);
      return { ...inner, default: dfltDef.defaultValue() };
    }

    case z.ZodFirstPartyTypeKind.ZodObject: {
      const objDef = def as unknown as {
        shape: () => Record<string, z.ZodTypeAny>;
      };
      const shape = objDef.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodToJsonSchema(value);

        const innerDef = value._def as { typeName: string };
        const isOptional =
          innerDef.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
          innerDef.typeName === z.ZodFirstPartyTypeKind.ZodDefault;

        if (!isOptional) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...description,
      };
    }

    default:
      // Fall back to an opaque schema for unsupported types
      return { type: "string", ...description };
  }
}
