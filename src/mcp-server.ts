import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApexBrowseMcpServer } from './mcp.js';

const server = createApexBrowseMcpServer();
await server.connect(new StdioServerTransport());
