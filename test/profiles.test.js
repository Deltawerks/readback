import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const dir = mkdtempSync(path.join(tmpdir(), 'readback-profiles-'));
process.env.READBACK_STATE_DIR = dir;
process.env.READBACK_CACHE_DIR = dir;
const file = path.join(dir, 'state.json');
const { readState, readAgentState, writeState, writeAgentState, updateProviderConfig } = await import('../src/state.js');
const { currentEpoch, flushQueue } = await import('../src/queue.js');
const { speakCodexReply } = await import('../src/codex-speech.js');
const seed = () => writeFileSync(file, JSON.stringify({enabled:false, provider:'inworld',inworld:{voiceId:'Vinny',modelId:'inworld-tts-1.5-mini',speed:1.3,temperature:1.3}}));

test('legacy profiles retain voice and speed, migrate to Flash, and never turn master on', () => {
  seed();
  for (const a of ['claude','codex']) {
    const st=readAgentState(a);
    assert.equal(st.enabled,false);
    assert.equal(st.agentEnabled,true);
    assert.equal(st.inworld.voiceId,'Vinny');
    assert.equal(st.inworld.speed,1.3);
    assert.equal(st.inworld.modelId,'inworld-tts-2-flash');
    assert.equal(st.inworld.temperature,undefined);
  }
  writeAgentState('claude',{inworld:{voiceId:'Luna'}});
  assert.equal(readAgentState('codex').inworld.voiceId,'Vinny');
  updateProviderConfig('inworld',{speed:1.1});
  assert.equal(readAgentState('claude').inworld.speed,1.1);
  assert.equal(readAgentState('codex').inworld.speed,1.3);
  assert.equal(readState().enabled,false);
});

test('agent mutes and model choices survive a new process independently', () => {
  seed(); writeState({enabled:true});
  writeAgentState('codex',{enabled:false,inworld:{modelId:'inworld-tts-2',deliveryMode:'CREATIVE'}});
  writeAgentState('claude',{inworld:{voiceId:'Dennis'}});
  const script=`import {readAgentState} from ${JSON.stringify(new URL('../src/state.js',import.meta.url).href)}; console.log(JSON.stringify(['claude','codex'].map(a=>readAgentState(a))));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:process.env,encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);
  const [claude,codex]=JSON.parse(r.stdout);
  assert.equal(claude.enabled,true); assert.equal(codex.enabled,false);
  assert.equal(claude.inworld.voiceId,'Dennis'); assert.equal(codex.inworld.voiceId,'Vinny');
  assert.equal(codex.inworld.deliveryMode,'CREATIVE');
  writeState({enabled:false}); writeAgentState('codex',{enabled:true});
  assert.equal(readAgentState('codex').enabled,false);
});

test('concurrent leaf edits cannot resurrect either mute or overwrite the other agent', async () => {
  seed(); writeState({enabled:false}); writeAgentState('codex',{enabled:false});
  const run=(agent,key,value)=>new Promise((resolve,reject)=>{
    const script=`import {writeAgentState} from ${JSON.stringify(new URL('../src/state.js',import.meta.url).href)}; for(let i=0;i<50;i++)writeAgentState(${JSON.stringify(agent)},{inworld:{${key}:${JSON.stringify(value)}}});`;
    const c=spawn(process.execPath,['--input-type=module','-e',script],{env:process.env,stdio:'ignore',windowsHide:true});c.on('error',reject);c.on('close',code=>code?reject(Error('child failed')):resolve());
  });
  await Promise.all([run('claude','voiceId','Dennis'),run('codex','voiceId','Ashley'),run('codex','speed',1.1)]);
  const s=readState(); assert.equal(s.enabled,false); assert.equal(s.agents.codex.enabled,false);
  assert.equal(s.agents.claude.inworld.voiceId,'Dennis'); assert.equal(s.agents.codex.inworld.voiceId,'Ashley'); assert.equal(s.agents.codex.inworld.speed,1.1);
});

test('source cancellation does not invalidate the other source or global queue', () => {
  const g=currentEpoch(), c=currentEpoch('claude'), x=currentEpoch('codex');
  flushQueue('codex'); assert.notEqual(currentEpoch('codex'),x); assert.equal(currentEpoch('claude'),c); assert.equal(currentEpoch(),g);
});

test('Codex source mute prevents automatic speech even with master enabled', async () => {
  seed();writeState({enabled:true});writeAgentState('codex',{enabled:false});
  const result=await speakCodexReply({hook_event_name:'Stop',session_id:'muted',turn_id:'1',last_assistant_message:'Should stay silent.'},()=>assert.fail('muted source invoked provider'));
  assert.equal(result.skipped,'voice off'); assert.equal(readAgentState('claude').enabled,true);
});
