import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next matches these as literal package names (no glob support for "@mastra/*"),
  // so each Mastra package is listed explicitly.
  serverExternalPackages: [
    "@mastra/core",
    "@mastra/ai-sdk",
    "@mastra/mcp",
    "agentmail",
    "@onkernel/sdk",
    "exa-js",
    "@fly/sprites",
    "@modelcontextprotocol/sdk",
    "@aws-sdk/client-s3",
    "pg",
  ],
  devIndicators: false,
};

export default nextConfig;
