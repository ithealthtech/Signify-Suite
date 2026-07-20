"use strict";

const { loadConfig } = require("../server/config.cjs");
const { createRecoveryManager } = require("../server/recovery.cjs");

createRecoveryManager(loadConfig())
  .drill()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
