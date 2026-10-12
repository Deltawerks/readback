import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, writeSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexTurnEligibility } from '../src/codex.js';

const header = (id = 'main-session') => JSON.stringify({type:'session_meta',payload:{id,source:'vscode',thread_source:'user'}}) + '\n';
const turn = (id, trigger = 'composer', extra = {}) => JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:id,turn_attribution:{turn_trigger:trigger},...extra}});
const payload = (file, id = 'current-turn') => ({transcript_path:file,session_id:'main-session',turn_id:id});

test('current turns beyond the old 128 MB cutoff are eligible, while later predictions stay silent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-large-transcript-'));
  const file = path.join(dir, 'history.jsonl');
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, Buffer.from(header()), 0, Buffer.byteLength(header()), 0);
    // Leave a large irrelevant history gap. Only the header and newest records
    // need reading; the old forward reader would exhaust its byte budget.
    const tail = Buffer.from('\n' + turn('current-turn') + '\n' + turn('prediction', 'composer_predictions') + '\n{"partial":');
    writeSync(fd, tail, 0, tail.length, 160 * 1024 * 1024);
  } finally { closeSync(fd); }
  try {
    assert.equal((await codexTurnEligibility(payload(file))).allowed, true);
    assert.equal((await codexTurnEligibility(payload(file, 'prediction'))).allowed, false);
    assert.equal((await codexTurnEligibility({...payload(file),session_id:'wrong-session'})).allowed, false);
  } finally { unlinkSync(file); }
});

test('reverse scan crosses UTF-8 record boundaries and skips giant tool records after the turn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'readback-boundaries-'));
  const file = path.join(dir, 'history.jsonl');
  const record = turn('current-turn', 'composer', {note:'é'.repeat(200)});
  // Position the nearest backwards block boundary inside a multibyte sequence
  // in the task_started record, then put an oversized JSON line after it.
  const recordBytes = Buffer.from(record);
  const split = recordBytes.indexOf(Buffer.from('é')) + 1;
  const block = 256 * 1024;
  const trailingLength = 3 * 1024 * 1024 + ((block - ((recordBytes.length - split) % block)) % block);
  const wrapper = '\n' + JSON.stringify({type:'response_item',payload:{type:'tool_result',text:''}}) + '\n';
  const giant = '\n' + JSON.stringify({type:'response_item',payload:{type:'tool_result',text:'x'.repeat(trailingLength - Buffer.byteLength(wrapper))}}) + '\n';
  writeFileSync(file, header() + record + giant);
  try {
    assert.equal((await codexTurnEligibility(payload(file))).allowed, true);
    assert.equal((await codexTurnEligibility(payload(file, 'missing-turn'))).allowed, false);
    writeFileSync(file, header() + turn('current-turn', 'composer_predictions') + giant);
    assert.equal((await codexTurnEligibility(payload(file))).allowed, false);
  } finally { unlinkSync(file); }
});
