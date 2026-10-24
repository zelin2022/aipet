'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {dataDirectory,eventDirectories}=require('../src/core/data.cjs');
test('own profile data stays outside virtualized LocalAppData and tests never inspect real inboxes',()=>{
  const env={USERPROFILE:'C:\\Users\\example',LOCALAPPDATA:'C:\\Users\\example\\AppData\\Local'};
  const data=dataDirectory(env);assert.equal(data,path.join(env.USERPROFILE,'.aipet'));
  assert.deepEqual(eventDirectories(data,env,true),[path.join(data,'events')]);
  const dirs=eventDirectories(data,env,false);
  assert.equal(dirs.length,5);assert.ok(dirs.every(dir=>dir.endsWith(path.join('Aipet','events'))||dir.endsWith(path.join('.aipet','events'))));
  assert.ok(dirs.some(dir=>dir.includes('Claude_pzs8sxrjxfjjc')));
  assert.ok(dirs.some(dir=>dir.includes('OpenAI.Codex_2p2nqsd0c76g0')));
  assert.deepEqual(eventDirectories(data,{},false),[path.join(data,'events')]);
});
