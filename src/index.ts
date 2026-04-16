import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/index.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`Received ${signal}, shutting down...\n`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
