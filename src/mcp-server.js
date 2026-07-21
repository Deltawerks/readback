#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readState, writeState, updateProviderConfig, activeConfig } from './state.js';
import { listVoices, stripForSpeech, truncateForSpeech } from './tts.js';
import { stopPlayback } from './audio.js';
import { flushQueue } from './queue.js';
import { speak } from './speak.js';
import { PROVIDER_IDS } from './providers/index.js';
import { log } from './log.js';

const server = new McpServer({ name: 'readback', version: '0.3.0' });

function summarize(st) {
  const c = activeConfig(st);
  const tune =
    st.provider === 'inworld'
      ? `speed ${c.speed} · expression ${c.temperature}`
      : `speed ${c.speed} · stability ${c.stability} · style ${c.style}`;
  return `voice ${st.enabled ? 'ON' : 'off'} · ${st.provider} · ${c.voiceId || '(no voice)'} · ${c.modelId} · ${tune}`;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

server.registerTool(
  'voice_on',
  {
    title: 'Turn voice on',
    description:
      'Enable spoken voice output. After this, your replies are read aloud automatically (by the Stop hook) until voice_off is called.',
    inputSchema: {},
  },
  async () => text(`🔊 ${summarize(writeState({ enabled: true }))}`)
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
    // starts talking and "voice off" appears to do nothing.
    const st = writeState({ enabled: false });
    flushQueue();
    stopPlayback();
    return text(`🔇 ${summarize(st)}`);
  }
);

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
      'Speak the given text aloud once, right now, regardless of the on/off state. Useful for testing or a one-off announcement.',
    inputSchema: { text: z.string().describe('The text to speak aloud') },
  },
  async ({ text: input }) => {
    try {
      const st = readState();
      const clean = truncateForSpeech(stripForSpeech(input), st.maxChars);
      if (!clean || clean.length < 2) return text('(nothing speakable in that text)');
      await speak(clean, st, { wait: false });
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
    return text(`provider → ${writeState({ provider }).provider}`);
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
    return text(`voice → ${voiceId} (${st.provider})`);
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
    return text(`model → ${modelId} (${st.provider})`);
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
    updateProviderConfig(st.provider, { speed });
    return text(`speed → ${speed}x (${st.provider})`);
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
