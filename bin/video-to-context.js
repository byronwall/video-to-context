#!/usr/bin/env node
import { run } from "../src/pipeline.js";

run(process.argv.slice(2)).catch((err) => {
  console.error(`\n\x1b[31mError:\x1b[0m ${err.message}`);
  if (process.env.V2C_DEBUG) console.error(err.stack);
  process.exit(1);
});
