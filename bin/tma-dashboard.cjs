#!/usr/bin/env node
"use strict";

require("../installer/index.cjs").main(process.argv.slice(2)).catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
