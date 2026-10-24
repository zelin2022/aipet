"use strict";
const path = require("node:path");
function launchSpec({ packaged, executable, appDirectory }) {
  if (!path.isAbsolute(executable) || !path.isAbsolute(appDirectory))
    throw new Error("Absolute trusted launch paths required");
  return { executable, args: packaged ? [] : [appDirectory] };
}
module.exports = { launchSpec };
