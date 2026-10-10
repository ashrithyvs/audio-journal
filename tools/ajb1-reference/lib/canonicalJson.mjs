// AJ canonical JSON, version 1 (AJB1 §9.4): an RFC 8785 (JCS) profile.
// - Values: objects, arrays, strings, booleans, and integers in 0..2^53-1.
//   null, fractions, exponents, and negative numbers are not allowed.
// - Object members are sorted by UTF-16 code units; no insignificant spaces.
// - Strings are well-formed Unicode; content is never normalized.
// - Strict decoding: no duplicate keys at any depth, and the input must equal
//   the canonical serialization of what it decodes to, byte for byte.

export class CanonicalJsonError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CanonicalJsonError';
    this.reason = reason;
  }
}

const fail = reason => {
  throw new CanonicalJsonError(reason);
};

function isWellFormed(text) {
  return typeof text.isWellFormed === 'function'
    ? text.isWellFormed()
    : !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
        text,
      );
}

/** Canonical serialization; throws on values outside the profile. */
export function canonicalize(value) {
  if (typeof value === 'string') {
    if (!isWellFormed(value)) {
      fail('LONE_SURROGATE');
    }
    // ECMAScript JSON string quoting is exactly the JCS string form.
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      fail('NUMBER_OUT_OF_PROFILE');
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(key => {
        if (value[key] === undefined) {
          fail('UNDEFINED_VALUE');
        }
        return `${canonicalize(key)}:${canonicalize(value[key])}`;
      })
      .join(',')}}`;
  }
  return fail(value === null ? 'NULL_NOT_ALLOWED' : 'UNSUPPORTED_TYPE');
}

/**
 * Strict decoder. A small recursive-descent parser (JSON.parse silently keeps
 * the last duplicate key), followed by the canonical round-trip check.
 */
export function parseCanonical(text, { maxDepth = 8 } = {}) {
  let at = 0;
  const peek = () => text[at];
  const expect = char => {
    if (text[at] !== char) {
      fail('SYNTAX');
    }
    at += 1;
  };

  function parseString() {
    expect('"');
    let out = '';
    for (;;) {
      const char = text[at];
      if (char === undefined) {
        fail('SYNTAX');
      }
      if (char === '"') {
        at += 1;
        return out;
      }
      if (char === '\\') {
        const next = text[at + 1];
        const simple = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (next in simple) {
          out += simple[next];
          at += 2;
        } else if (
          next === 'u' &&
          /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))
        ) {
          out += String.fromCharCode(parseInt(text.slice(at + 2, at + 6), 16));
          at += 6;
        } else {
          fail('SYNTAX');
        }
      } else if (char < ' ') {
        fail('UNESCAPED_CONTROL');
      } else {
        out += char;
        at += 1;
      }
    }
  }

  function parseValue(depth) {
    if (depth > maxDepth) {
      fail('TOO_DEEP');
    }
    const char = peek();
    if (char === '{') {
      at += 1;
      const object = {};
      const seen = new Set();
      if (peek() === '}') {
        at += 1;
        return object;
      }
      for (;;) {
        const key = parseString();
        if (seen.has(key)) {
          fail('DUPLICATE_KEY');
        }
        seen.add(key);
        expect(':');
        Object.defineProperty(object, key, {
          value: parseValue(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (peek() === ',') {
          at += 1;
        } else {
          expect('}');
          return object;
        }
      }
    }
    if (char === '[') {
      at += 1;
      const array = [];
      if (peek() === ']') {
        at += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue(depth + 1));
        if (peek() === ',') {
          at += 1;
        } else {
          expect(']');
          return array;
        }
      }
    }
    if (char === '"') {
      return parseString();
    }
    if (text.startsWith('true', at)) {
      at += 4;
      return true;
    }
    if (text.startsWith('false', at)) {
      at += 5;
      return false;
    }
    if (text.startsWith('null', at)) {
      fail('NULL_NOT_ALLOWED');
    }
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
      text.slice(at, at + 400),
    );
    if (number) {
      if (number[0].startsWith('-') || number[2] || number[3]) {
        fail('NUMBER_OUT_OF_PROFILE');
      }
      at += number[0].length;
      return Number(number[0]);
    }
    return fail('SYNTAX');
  }

  const value = parseValue(0);
  if (at !== text.length) {
    fail('TRAILING_DATA');
  }
  if (canonicalize(value) !== text) {
    fail('NON_CANONICAL');
  }
  return value;
}

/** NDJSON: canonical objects, each followed by exactly one LF; no CR, no blanks. */
export function serializeNdjson(objects) {
  return objects.map(object => `${canonicalize(object)}\n`).join('');
}

export function* parseNdjson(text, { maxLineBytes }) {
  if (text.length === 0) {
    return;
  }
  if (!text.endsWith('\n')) {
    fail('MISSING_FINAL_LF');
  }
  let start = 0;
  let lineNumber = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end);
    lineNumber += 1;
    if (line.length === 0) {
      fail('EMPTY_LINE');
    }
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      fail('LINE_TOO_LONG');
    }
    const value = parseCanonical(line);
    if (Array.isArray(value) || typeof value !== 'object') {
      fail('RECORD_NOT_OBJECT');
    }
    yield { lineNumber, value };
    start = end + 1;
  }
}
