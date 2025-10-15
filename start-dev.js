#!/usr/bin/env node

/**
 * Development startup script with optimized memory settings
 * This script starts the Shopify app with increased memory limits and garbage collection enabled
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Node.js flags for better memory management and performance
const nodeFlags = [
  "--max-old-space-size=4096", // Increase memory to 4GB
  "--expose-gc", // Enable manual garbage collection
  "--optimize-for-size", // Optimize for memory usage
  "--max-semi-space-size=128", // Increase semi-space size
];

// Environment variables for better performance
const env = {
  ...process.env,
  NODE_OPTIONS: nodeFlags.join(" "),
  UV_THREADPOOL_SIZE: "16", // Increase thread pool size
  NODE_ENV: process.env.NODE_ENV || "development",
};

console.log("🚀 Starting Shopify app with optimized memory settings...");
console.log("📊 Memory limit: 4GB");
console.log("🧹 Garbage collection: Enabled");
console.log("🔧 Thread pool size: 16");

// Start the development server
const child = spawn("npm", ["run", "dev"], {
  env,
  stdio: "inherit",
  cwd: __dirname,
  shell: true,
});

// Handle process termination
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down development server...");
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down development server...");
  child.kill("SIGTERM");
});

child.on("exit", (code) => {
  console.log(`\n✅ Development server exited with code ${code}`);
  process.exit(code);
});

child.on("error", (error) => {
  console.error("❌ Failed to start development server:", error);
  process.exit(1);
});

