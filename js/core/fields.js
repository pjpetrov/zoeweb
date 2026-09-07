/*
 * ZoeWeb — a web clone of CanZE (https://github.com/fesch/CanZE)
 * Field engine: parses CanZE's CSV field databases and decodes raw frames.
 *
 * CSV columns (see CanZE Fields.java):
 *   0 SID (optional override), 1 frame ID (hex), 2 from bit, 3 to bit,
 *   4 resolution (multiplier), 5 offset (applied BEFORE resolution),
 *   6 decimals, 7 unit, 8 requestId (hex), 9 responseId (hex),
 *   10 options (hex), 11 name, 12 list (enum "0:Off;1:On")
 *
 * value = (raw - offset) * resolution
 *
 * Licensed under GPL-3.0, derived from CanZE (C) the CanZE team.
 */

export const OPT_TYPE_MASK = 0x700;
export const OPT_SIGNED = 0x100;
export const OPT_STRING = 0x200;
export const OPT_HEXSTRING = 0x400;

export class Field {
  constructor(cols) {
    this.frameIdHex = cols[1].toLowerCase();
    this.frameId = parseInt(cols[1], 16);
    this.from = parseInt(cols[2], 10) || 0;
    this.to = parseInt(cols[3], 10) || 0;
    this.resolution = parseFloat(cols[4]) || 1;
    this.offset = parseFloat(cols[5]) || 0;
    this.decimals = parseInt(cols[6], 10) || 0;
    this.unit = cols[7] || '';
    this.requestId = (cols[8] || '').toLowerCase();
    this.responseId = (cols[9] || '').toLowerCase();
    this.options = parseInt(cols[10] || 'ff', 16);
    this.name = cols[11] || '';
    this.list = (cols[12] || '').trim();

    this.isIsoTp = this.requestId !== '';
    this.sid = cols[0]
      ? cols[0].toLowerCase()
      : (this.isIsoTp
        ? `${this.frameIdHex}.${this.responseId}.${this.from}`
        : `${this.frameIdHex}.${this.from}`);

    this.value = NaN;          // scaled value (or string for string fields)
    this.rawValue = NaN;
    this.lastUpdated = 0;
    this.listeners = new Set();
  }

  get isSigned() { return (this.options & OPT_TYPE_MASK) === OPT_SIGNED; }
  get isString() { return (this.options & OPT_TYPE_MASK) === OPT_STRING; }
  get isHexString() { return (this.options & OPT_TYPE_MASK) === OPT_HEXSTRING; }

  /** Decode this field from the full response given as a binary string. */
  decodeFromBinaryString(binString) {
    if (binString.length < this.to + 1) return false;
    const bits = binString.substring(this.from, this.to + 1);
    if (this.isString) {
      let s = '';
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        s += String.fromCharCode(parseInt(bits.substring(i, i + 8), 2));
      }
      this.setValue(s);
    } else if (this.isHexString) {
      let s = '';
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        s += parseInt(bits.substring(i, i + 8), 2).toString(16).padStart(2, '0').toUpperCase();
      }
      this.setValue(s);
    } else if (bits.length <= 4 || bits.includes('0')) {
      let raw;
      if (this.isSigned && bits[0] === '1') {
        // two's complement
        raw = -(parseInt(bits.split('').map(b => b === '0' ? '1' : '0').join(''), 2) + 1);
      } else {
        raw = parseInt(bits, 2);
      }
      this.rawValue = raw;
      this.setValue((raw - this.offset) * this.resolution);
    } else {
      this.setValue(NaN); // all-ones wide field = "unavailable"
    }
    return true;
  }

  setValue(v) {
    this.value = v;
    this.lastUpdated = Date.now();
    for (const l of this.listeners) {
      try { l(this); } catch (e) { console.error('field listener', this.sid, e); }
    }
  }

  /** Formatted value with the field's declared decimals; resolves enum lists. */
  format() {
    const v = this.value;
    if (typeof v === 'string') return v;
    if (v === null || Number.isNaN(v)) return '—';
    if (this.list) {
      const entry = this.list.split(';').find(p => parseInt(p.split(':')[0], 10) === Math.round(v));
      if (entry) return entry.substring(entry.indexOf(':') + 1);
    }
    return v.toFixed(this.decimals);
  }

  /** Human-friendly label derived from the CanZE field name. */
  label() {
    return this.name
      .replace(/^[0-9a-fA-F]{2}_[0-9a-fA-F]{2}[_ ]?#?\d*[_ ]?/, '')
      .replace(/_/g, ' ')
      .trim() || this.name || this.sid;
  }
}

/** Parses a CanZE CSV file body into rows of columns (handles # comments). */
export function parseCsv(text) {
  const rows = [];
  for (let line of text.split('\n')) {
    line = line.replace('\r', '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    rows.push(line.split(','));
  }
  return rows;
}

export class FieldRegistry {
  constructor() {
    this.bySid = new Map();
    this.all = [];
    // frames: key = frameIdHex → { idHex, id, interval, ecu }
    this.freeFrames = new Map();
    // diag requests: key = frameIdHex + '.' + requestId → { frameIdHex, requestId, responseId, fields[] }
    this.diagRequests = new Map();
  }

  addFieldFromCols(cols) {
    if (cols.length < 11 || !cols[1]) return null;
    const f = new Field(cols);
    if (this.bySid.has(f.sid)) return this.bySid.get(f.sid); // first one wins, like CanZE
    this.bySid.set(f.sid, f);
    this.all.push(f);
    if (f.isIsoTp) {
      const key = `${f.frameIdHex}.${f.requestId}`;
      if (!this.diagRequests.has(key)) {
        this.diagRequests.set(key, {
          frameIdHex: f.frameIdHex, frameId: f.frameId,
          requestId: f.requestId, responseId: f.responseId, fields: [],
        });
      }
      this.diagRequests.get(key).fields.push(f);
    }
    return f;
  }

  loadFieldsCsv(text) {
    let n = 0;
    for (const cols of parseCsv(text)) {
      if (this.addFieldFromCols(cols)) n++;
    }
    return n;
  }

  loadFramesCsv(text) {
    for (const cols of parseCsv(text)) {
      const idHex = cols[0].toLowerCase();
      this.freeFrames.set(idHex, {
        idHex, id: parseInt(idHex, 16),
        interval: parseInt(cols[1], 10) || 100,
        ecu: (cols[3] || '').trim(),
      });
    }
  }

  getBySid(sid) { return this.bySid.get(sid.toLowerCase()); }

  /** All fields decoded by one diag response (same frame + responseId). */
  fieldsForResponse(frameIdHex, responseId) {
    return this.all.filter(f => f.frameIdHex === frameIdHex && f.responseId === responseId);
  }

  fieldsForFreeFrame(frameIdHex) {
    return this.all.filter(f => !f.isIsoTp && f.frameIdHex === frameIdHex);
  }

  clear() {
    this.bySid.clear();
    this.all.length = 0;
    this.freeFrames.clear();
    this.diagRequests.clear();
  }
}
