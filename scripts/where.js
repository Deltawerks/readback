#!/usr/bin/env node
// Prints every directory and file ReadBack resolved, and the panel's port, as JSON.
//
// Every ReadBack process (the panel, the MCP server, each hook worker) resolves
// these independently from the environment it was launched with. If two of them
// disagree, the toggle stops controlling anything and audio cannot be stopped.
// Run this from the panel's environment and from a Claude Code hook to compare.
import { STATE_DIR, CACHE_DIR, STATE_FILE, RUNTIME_FILE, LOG_FILE, SECRET_FILE, PORT } from '../src/config.js';

process.stdout.write(
  JSON.stringify({ STATE_DIR, CACHE_DIR, STATE_FILE, RUNTIME_FILE, LOG_FILE, SECRET_FILE, PORT }, null, 2)
);
