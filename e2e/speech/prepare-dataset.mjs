#!/usr/bin/env node
// Builds the real-speech evaluation set from the official LibriSpeech test sets.
//
//   node prepare-dataset.mjs [--out .cache/dataset] [--sources <dir>] [--per-speaker 3]
//
// Sources: LibriSpeech test-clean and test-other (OpenSLR SLR12, CC BY 4.0,
// read English speech from LibriVox public-domain recordings, many male and
// female speakers). Archives are pinned by MD5 (as published by OpenSLR) and
// SHA-256. A deterministic subset is chosen per speaker and expanded into
// real-world conditions: cafe babble, background noise, quiet far-field
// capture, and long recordings. Output is 16 kHz mono 16-bit PCM WAV with a
// manifest recording every file's SHA-256. Audio is never committed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { FLACDecoder } from '@wasm-audio-decoders/flac';

import {
  babble,
  concat,
  encodeWav,
  gain,
  mixAtSnr,
  pinkNoise,
  SAMPLE_RATE,
} from './lib/audio.mjs';
import { readTarGz } from './lib/tar.mjs';

export const SOURCES = {
  'test-clean': {
    url: 'https://www.openslr.org/resources/12/test-clean.tar.gz',
    md5: '32fa31d27d2e1cad72775fee3f4849a9',
    conditions: ['clean', 'babble10', 'babble5', 'pink20', 'quiet'],
  },
  'test-other': {
    url: 'https://www.openslr.org/resources/12/test-other.tar.gz',
    md5: 'fb5a50374b501bb3bac4815ee91d3135',
    conditions: ['clean', 'babble10'],
  },
};
export const LICENSE =
  'CC BY 4.0. LibriSpeech ASR corpus (Panayotov, Chen, Povey, Khudanpur, ICASSP 2015), OpenSLR SLR12; audio from LibriVox public-domain recordings.';

export const CONDITIONS = {
  clean: 'Clean read speech',
  babble10: 'Cafe babble (3 other talkers), 10 dB SNR',
  babble5: 'Cafe babble (3 other talkers), 5 dB SNR',
  pink20: 'Background noise (pink), 20 dB SNR',
  quiet: 'Quiet far-field capture, -24 dB',
  long3m: 'Long recording, ~3 min, mixed speakers',
  long10m: 'Long recording, ~10 min, mixed speakers',
};
const LONG_FORMS = [
  { id: 'long3m', seconds: 180 },
  { id: 'long10m', seconds: 600 },
];

const hash = (algorithm, data) =>
  crypto.createHash(algorithm).update(data).digest('hex');
const fileHash = (algorithm, file) =>
  new Promise((resolve, reject) => {
    const digest = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('data', chunk => digest.update(chunk))
      .on('end', () => resolve(digest.digest('hex')))
      .on('error', reject);
  });

/** Deterministic choice: per speaker, sorted IDs with 8-40 reference words. */
export function selectUtterances(transcripts, perSpeaker) {
  const bySpeaker = new Map();
  for (const [id, text] of [...transcripts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const words = text.split(/\s+/).length;
    if (words < 8 || words > 40) continue;
    const speaker = id.split('-')[0];
    const list = bySpeaker.get(speaker) ?? [];
    list.push(id);
    bySpeaker.set(speaker, list);
  }
  const chosen = [];
  for (const [, ids] of [...bySpeaker].sort(
    ([a], [b]) => Number(a) - Number(b),
  )) {
    // Spread picks across the speaker's chapters instead of taking neighbours.
    for (let k = 0; k < Math.min(perSpeaker, ids.length); k += 1) {
      chosen.push(ids[Math.floor((k * ids.length) / perSpeaker)]);
    }
  }
  return chosen;
}

async function loadSet(archive, perSpeaker) {
  const transcripts = new Map();
  const genders = new Map();
  await readTarGz(archive, {
    onEntry: name =>
      name.endsWith('.trans.txt') || name.endsWith('SPEAKERS.TXT'),
    onData: (name, data) => {
      const text = data.toString('utf8');
      if (name.endsWith('SPEAKERS.TXT')) {
        for (const line of text.split('\n')) {
          const match = /^\s*(\d+)\s*\|\s*([MF])\s*\|/.exec(line);
          if (match) genders.set(match[1], match[2]);
        }
        return;
      }
      for (const line of text.split('\n')) {
        const space = line.indexOf(' ');
        if (space > 0)
          transcripts.set(line.slice(0, space), line.slice(space + 1).trim());
      }
    },
  });
  const selected = new Set(selectUtterances(transcripts, perSpeaker));
  const audio = new Map();
  await readTarGz(archive, {
    onEntry: name =>
      name.endsWith('.flac') && selected.has(path.basename(name, '.flac')),
    onData: (name, data) => audio.set(path.basename(name, '.flac'), data),
  });
  const decoder = new FLACDecoder();
  await decoder.ready;
  const utterances = [];
  for (const id of [...selected].sort()) {
    const decoded = await decoder.decodeFile(new Uint8Array(audio.get(id)));
    if (decoded.sampleRate !== SAMPLE_RATE)
      throw new Error(`${id}: ${decoded.sampleRate} Hz`);
    const speakerId = id.split('-')[0];
    utterances.push({
      id,
      speakerId,
      gender: genders.get(speakerId) ?? '?',
      reference: transcripts.get(id),
      samples: decoded.channelData[0],
    });
  }
  decoder.free();
  return utterances;
}

async function main() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(here, '.cache/dataset') },
      sources: { type: 'string', default: path.join(here, '.cache/sources') },
      'per-speaker': { type: 'string', default: '3' },
    },
  });
  const perSpeaker = Number(args['per-speaker']);
  fs.mkdirSync(args.sources, { recursive: true });
  const items = [];
  const sourceRecords = {};
  const write = (relative, samples, meta) => {
    const wav = encodeWav(samples);
    fs.mkdirSync(path.dirname(path.join(args.out, relative)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(args.out, relative), wav);
    items.push({
      file: relative,
      sha256: hash('sha256', wav),
      durationSec: Math.round((samples.length / SAMPLE_RATE) * 1000) / 1000,
      ...meta,
    });
  };

  let longPool = [];
  for (const [set, source] of Object.entries(SOURCES)) {
    const archive = path.join(args.sources, `${set}.tar.gz`);
    if (!fs.existsSync(archive)) {
      console.log(`downloading ${source.url}`);
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
    const md5 = await fileHash('md5', archive);
    if (md5 !== source.md5) throw new Error(`${set} MD5 mismatch: ${md5}`);
    sourceRecords[set] = {
      url: source.url,
      md5,
      sha256: await fileHash('sha256', archive),
    };
    const utterances = await loadSet(archive, perSpeaker);
    console.log(
      `${set}: ${utterances.length} utterances from ${
        new Set(utterances.map(u => u.speakerId)).size
      } speakers`,
    );
    if (set === 'test-clean') longPool = utterances;
    for (const [index, utterance] of utterances.entries()) {
      const others = utterances.filter(
        other => other.speakerId !== utterance.speakerId,
      );
      const talkers = [0, 1, 2].map(
        k => others[(index * 7 + k * 11) % others.length].samples,
      );
      const base = {
        set,
        utteranceIds: [utterance.id],
        speakerId: utterance.speakerId,
        gender: utterance.gender,
        reference: utterance.reference,
      };
      for (const condition of source.conditions) {
        const samples =
          condition === 'clean'
            ? utterance.samples
            : condition === 'babble10'
            ? mixAtSnr(
                utterance.samples,
                babble(talkers, utterance.samples.length),
                10,
              )
            : condition === 'babble5'
            ? mixAtSnr(
                utterance.samples,
                babble(talkers, utterance.samples.length),
                5,
              )
            : condition === 'pink20'
            ? mixAtSnr(
                utterance.samples,
                pinkNoise(utterance.samples.length, index + 1),
                20,
              )
            : gain(utterance.samples, -24);
        write(`${set}/${condition}/${utterance.id}.wav`, samples, {
          condition,
          ...base,
        });
      }
    }
  }

  for (const long of LONG_FORMS) {
    const parts = [];
    let seconds = 0;
    // Interleave speakers so the recording changes voice like a real diary.
    for (let index = 0; seconds < long.seconds; index += 1) {
      const utterance = longPool[(index * 3) % longPool.length];
      parts.push(utterance);
      seconds += utterance.samples.length / SAMPLE_RATE + 0.8;
    }
    write(
      `long/${long.id}.wav`,
      concat(
        parts.map(part => part.samples),
        0.8,
      ),
      {
        set: 'test-clean',
        condition: long.id,
        utteranceIds: parts.map(part => part.id),
        speakerId: 'mixed',
        gender: 'mixed',
        reference: parts.map(part => part.reference).join(' '),
      },
    );
  }

  const manifest = {
    license: LICENSE,
    sources: sourceRecords,
    perSpeaker,
    conditions: CONDITIONS,
    items,
  };
  fs.writeFileSync(
    path.join(args.out, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  const minutes = items.reduce((sum, item) => sum + item.durationSec, 0) / 60;
  console.log(
    `${items.length} files, ${minutes.toFixed(1)} min of audio in ${args.out}`,
  );
}

await main();
