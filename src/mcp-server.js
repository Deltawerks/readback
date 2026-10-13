#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readAgentState, writeAgentState, writeState, activeConfig } from './state.js';
import { listVoices, stripForSpeech, truncateForSpeech } from './tts.js';
import { stopPlayback } from './audio.js';
import { flushQueue } from './queue.js';
import { speak } from './speak.js';
import { PROVIDER_IDS, getProvider, clampKnobs } from './providers/index.js';
import { log } from './log.js';

const SOURCE = process.env.READBACK_SOURCE === 'codex' ? 'codex' : 'claude';
const readState = () => readAgentState(SOURCE);
// Same cleaning as the panel's saves, so a model cannot store what a person
// using the panel could not.
const updateProviderConfig = (provider, patch) => writeAgentState(SOURCE, { [provider]: clampKnobs(provider, patch) });

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'readback', version });

function summarize(st) {
  const c = activeConfig(st);
  const tune =
    st.provider === 'inworld'
      ? `speed ${c.speed}${c.modelId === 'inworld-tts-2' ? ' · delivery ' + c.deliveryMode : ''}`
      : `speed ${c.speed} · stability ${c.stability} · style ${c.style}`;
  return `${SOURCE} voice ${st.enabled ? 'ON' : 'off'} (master ${st.masterEnabled ? 'on' : 'off'}, agent ${st.agentEnabled ? 'on' : 'off'}) · ${st.provider} · ${c.voiceId || '(no voice)'} · ${c.modelId} · ${tune}`;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

server.registerTool(
  'voice_on',
  {
    title: 'Turn voice on',
    description:
      'Enable the master speech switch for both agents. Each agent also has its own switch; use set_agent_enabled to change this agent’s switch.',
    inputSchema: {},
  },
  async () => {
    writeState({ enabled: true });
    return text(`🔊 ${summarize(readState())}`);
  }
);

server.registerTool(
  'voice_off',
  {
    title: 'Turn voice off',
    description:
      'Disable spoken voice output AND immediately stop any audio currently playing. Use when the user needs silence right now.',
    inputSchema: {},
  },
  async () => {
    // Record "off" first, then clear the queue, then kill audio. Stopping first
    // frees the line while voice still reads as on, so the next queued reply
    // starts talking and "voice off" appears to do nothing. The silencing runs
    // whether or not the save succeeds: an unsaved setting is something to
    // report, not a reason to keep talking.
    let saveError;
    try {
      writeState({ enabled: false });
    } catch (err) {
      saveError = err;
    } finally {
      flushQueue();
      stopPlayback();
    }
    if (saveError) {
      return fail(
        `🔇 stopped the audio, but the setting could not be saved (${saveError.message}), so the next reply may still speak. Try voice_off again.`
      );
    }
    return text(`🔇 ${summarize(readState())}`);
  }
);

server.registerTool('set_agent_enabled', {
  title: 'Enable or mute this agent',
  description: 'Enable or mute only this agent. Master mute still takes priority; muting stops only this agent’s speech.',
  inputSchema: { enabled: z.boolean() },
}, async ({enabled}) => {
  try { writeAgentState(SOURCE, {enabled}); }
  finally { if (!enabled) { flushQueue(SOURCE); stopPlayback(SOURCE); } }
  return text(summarize(readState()));
});

server.registerTool(
  'voice_status',
  {
    title: 'Voice status',
    description: 'Report whether voice is on, the active provider, voice, model, and tuning.',
    inputSchema: {},
  },
  async () => text(summarize(readState()))
);

server.registerTool(
  'stop',
  {
    title: 'Stop playback',
    description:
      'Stop the audio currently playing but keep voice armed, so your next reply still speaks. Use for "stop reading that".',
    inputSchema: {},
  },
  async () => {
    flushQueue(); // clear the queue first, so nothing can claim the freed line
    stopPlayback();
    return text('⏹ stopped playback and cleared the queue (voice stays armed)');
  }
);

server.registerTool(
  'say',
  {
    title: 'Say text now',
    description:
      'Speak the given text aloud once, right now. Respects both master mute and this agent’s mute.',
    inputSchema: {
      text: z.string().describe('The text to speak aloud'),
    },
  },
  async ({ text: input }) => {
    try {
      const st = readState();
      if (!st.enabled) {
        return text('🔇 voice is off, so nothing was spoken. Enable the master and this agent in ReadBack first.');
      }
      const clean = truncateForSpeech(stripForSpeech(input), st.maxChars);
      if (!clean || clean.length < 2) return text('(nothing speakable in that text)');
      const result = await speak(clean, st, { wait: false });
      if (result.aborted) return text('Speech was muted or stopped.');
      if (result.playerFailed !== undefined) return fail(`the audio player quit before it played anything (${result.playerFailed})`);
      return text(`🗣 speaking (${activeConfig(st).voiceId || st.provider})`);
    } catch (err) {
      log('say error', err.message);
      return fail(`voice error: ${err.message}`);
    }
  }
);

server.registerTool(
  'set_provider',
  {
    title: 'Set provider',
    description: 'Switch the TTS provider. Each provider has its own voice, model, and key.',
    inputSchema: { provider: z.enum(['inworld', 'elevenlabs']) },
  },
  async ({ provider }) => {
    if (!PROVIDER_IDS.includes(provider)) return fail(`unknown provider: ${provider}`);
    writeAgentState(SOURCE, { provider });
    return text(`provider → ${readState().provider}`);
  }
);

server.registerTool(
  'set_voice',
  {
    title: 'Set voice',
    description: 'Change the voice (for the active provider) by its voice id. See list_voices.',
    inputSchema: { voiceId: z.string().describe('Voice id for the active provider') },
  },
  async ({ voiceId }) => {
    const st = readState();
    updateProviderConfig(st.provider, { voiceId });
    return text(`voice → ${activeConfig(readState()).voiceId} (${st.provider})`);
  }
);

server.registerTool(
  'set_model',
  {
    title: 'Set model',
    description: 'Change the TTS model for the active provider.',
    inputSchema: { modelId: z.string().describe('Model id for the active provider') },
  },
  async ({ modelId }) => {
    const st = readState();
    updateProviderConfig(st.provider, { modelId });
    return text(`model → ${activeConfig(readState()).modelId} (${st.provider})`);
  }
);

server.registerTool(
  'set_speed',
  {
    title: 'Set speed',
    description: 'Set the speaking rate for the active provider (each provider clamps to its own range).',
    inputSchema: { speed: z.number().min(0.5).max(1.5).describe('Speaking rate multiplier') },
  },
  async ({ speed }) => {
    const st = readState();
    // Each provider has its own range (ElevenLabs stops at 1.2). Store what the
    // provider will actually use, and say so, rather than persisting a number
    // the panel then displays differently from what plays.
    const knob = (getProvider(st.provider).knobs || []).find((k) => k.key === 'speed');
    const clamped = knob ? Math.min(knob.max, Math.max(knob.min, speed)) : speed;
    updateProviderConfig(st.provider, { speed: clamped });
    const note = clamped !== speed ? ` (clamped to this provider's range ${knob.min} to ${knob.max})` : '';
    return text(`speed → ${clamped}x (${st.provider})${note}`);
  }
);

server.registerTool(
  'list_voices',
  {
    title: 'List voices',
    description: 'List available voices for the active provider (id, description, gender).',
    inputSchema: {
      filter: z.string().optional().describe('Optional Inworld AIP-160 filter (ignored by ElevenLabs)'),
    },
  },
  async ({ filter }) => {
    try {
      const voices = await listVoices(readState(), filter ? { filter } : undefined);
      if (!voices.length) return text('no voices returned');
      const lines = voices.map(
        (v) => `${v.voiceId}: ${v.description || v.displayName}${v.gender ? ` (${v.gender})` : ''}`
      );
      return text(lines.join('\n'));
    } catch (err) {
      log('list_voices error', err.message);
      return fail(`voice error: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('mcp-server connected');
