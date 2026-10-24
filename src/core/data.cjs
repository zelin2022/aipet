'use strict';
const path = require('node:path');
const { homedir } = require('node:os');
// These are only our metadata subdirectories, never provider databases or logs.
const STORE_FAMILIES = Object.freeze(['Claude_pzs8sxrjxfjjc','OpenAI.Codex_2p2nqsd0c76g0','OpenAI.CodexPrimaryRuntime.v26-1007-641-0_3k8sg7r9htsxt']);
function dataDirectory(env = process.env) { return path.join(env.USERPROFILE || homedir(),'.aipet'); }
function eventDirectories(data, env = process.env, test = false) {
  const roots = [path.join(data,'events')];
  if(!test && env.LOCALAPPDATA) {
    roots.push(path.join(env.LOCALAPPDATA,'Aipet','events'));
    for(const family of STORE_FAMILIES) roots.push(path.join(env.LOCALAPPDATA,'Packages',family,'LocalCache','Local','Aipet','events'));
  }
  return [...new Set(roots)];
}
module.exports = { dataDirectory, eventDirectories, STORE_FAMILIES };
