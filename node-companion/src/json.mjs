// Strict JSON for everything the companion receives (SDK ADR-021 parsing
// rules; contract §8): UTF-8 only, no duplicate keys, no trailing data, a
// depth limit, and objects without a prototype, so keys such as "__proto__"
// are plain data and can never reach Object.prototype.

const decoder = new TextDecoder('utf-8', { fatal: true });

export class JsonError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Parses bytes or text; throws JsonError. */
export function parseStrict(
  input,
  { maxDepth = 32, integersOnly = false } = {},
) {
  let text;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = decoder.decode(input);
    } catch {
      throw new JsonError('utf8');
    }
  }
  let i = 0;
  const fail = reason => {
    throw new JsonError(reason);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };
  const value = depth => {
    ws();
    const c = text[i];
    if (c === '{') return object(depth + 1);
    if (c === '[') return array(depth + 1);
    if (c === '"') return string();
    if (c === 't' && text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (c === 'f' && text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (c === 'n' && text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return number();
  };
  const object = depth => {
    if (depth > maxDepth) fail('depth');
    i += 1;
    const out = Object.create(null);
    ws();
    if (text[i] === '}') {
      i += 1;
      return out;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('syntax');
      const key = string();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail('duplicate key');
      ws();
      if (text[i] !== ':') fail('syntax');
      i += 1;
      out[key] = value(depth);
      ws();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return out;
      }
      fail('syntax');
    }
  };
  const array = depth => {
    if (depth > maxDepth) fail('depth');
    i += 1;
    const out = [];
    ws();
    if (text[i] === ']') {
      i += 1;
      return out;
    }
    for (;;) {
      out.push(value(depth));
      ws();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return out;
      }
      fail('syntax');
    }
  };
  const string = () => {
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('syntax');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return out;
      }
      if (c < 0x20) fail('control in string');
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        if (e === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          const map = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (!(e in map)) fail('escape');
          out += map[e];
        }
        continue;
      }
      out += text[i];
      i += 1;
    }
  };
  const number = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
      text.slice(i),
    );
    if (!m) fail('syntax');
    if (integersOnly && (m[2] || m[3])) fail('integer lexemes only');
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('number');
    return n;
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail('trailing data');
  return result;
}

/** Contract §8 canonical JSON: sorted keys (UTF-16 order), compact. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const byteLength = value => Buffer.byteLength(canonical(value), 'utf8');

export function depthOf(value) {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === 'object') {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

export const own = (object, key) =>
  object !== null &&
  typeof object === 'object' &&
  Object.prototype.hasOwnProperty.call(object, key);
