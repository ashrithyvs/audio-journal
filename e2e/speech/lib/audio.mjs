// Deterministic 16 kHz mono PCM utilities for speech evaluation fixtures.

export const SAMPLE_RATE = 16_000;

/** Mulberry32: small, seeded, reproducible PRNG. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function rms(samples) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / Math.max(samples.length, 1));
}

/** Pink noise (Paul Kellet's refined filter over seeded white noise). */
export function pinkNoise(length, seed) {
  const random = prng(seed);
  const out = new Float32Array(length);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let index = 0; index < length; index += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[index] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
  }
  return out;
}

/** Babble: several other talkers summed and looped to the target length. */
export function babble(talkers, length) {
  const out = new Float32Array(length);
  for (const [talkerIndex, talker] of talkers.entries()) {
    const offset = Math.floor((talker.length / talkers.length) * talkerIndex);
    for (let index = 0; index < length; index += 1) {
      out[index] += talker[(index + offset) % talker.length];
    }
  }
  return out;
}

/** Adds noise scaled to the requested speech-to-noise ratio (dB). */
export function mixAtSnr(speech, noise, snrDb) {
  const speechRms = rms(speech);
  const noiseRms = rms(noise) || 1;
  const scale = speechRms / (noiseRms * 10 ** (snrDb / 20));
  const out = new Float32Array(speech.length);
  for (let index = 0; index < speech.length; index += 1) {
    out[index] = speech[index] + noise[index % noise.length] * scale;
  }
  return limit(out);
}

export function gain(samples, db) {
  const factor = 10 ** (db / 20);
  return limit(samples.map(value => value * factor));
}

/** Prevents clipping by scaling down only when the peak exceeds full scale. */
function limit(samples) {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak <= 0.99) return samples;
  const factor = 0.99 / peak;
  return samples.map(value => value * factor);
}

export function concat(parts, gapSeconds) {
  const gap = Math.round(gapSeconds * SAMPLE_RATE);
  const total =
    parts.reduce((sum, part) => sum + part.length, 0) +
    gap * (parts.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  for (const [index, part] of parts.entries()) {
    out.set(part, at);
    at += part.length + (index < parts.length - 1 ? gap : 0);
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    data.writeInt16LE(Math.round(clamped * 32_767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
