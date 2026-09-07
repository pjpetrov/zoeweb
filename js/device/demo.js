/*
 * ZoeWeb — demo transport: emulates an ELM327 dongle attached to a virtual
 * Renault Zoe. Responses are synthesized from the loaded field database, so
 * every screen shows plausible live data without a car.
 */

export class DemoTransport {
  constructor() {
    this.onData = null;
    this.db = null;            // VehicleDb, set by the app after loading
    this._header = '';         // atsh value (request id)
    this._filter = '';         // atcra value (response id)
    this._monitoring = false;
    this._multi = null;        // pending multiframe request assembly
    this._t0 = Date.now();
    this._clearedDtcs = new Set(); // ecus whose DTCs were "cleared"
    this._written = new Map();     // frame.did → data written via 2E
  }

  static get available() { return true; }
  get info() { return 'Demo (simulated Zoe)'; }
  async connect() {}
  async disconnect() {}

  _emit(s) { if (this.onData) setTimeout(() => this.onData?.(s), 4); }

  async write(str) {
    for (const raw of str.split('\r')) {
      const cmd = raw.trim().toLowerCase();
      if (!cmd) {
        if (this._monitoring) { this._monitoring = false; this._emit('STOPPED\r>'); }
        continue;
      }
      this._handle(cmd);
    }
  }

  _handle(cmd) {
    if (this._monitoring) { this._monitoring = false; this._emit('STOPPED\r'); }

    if (cmd.startsWith('at')) {
      const at = cmd.substring(2);
      if (at === 'z' || at === 'ws' || at === 'd') { this._emit('ELM327 v1.5 (ZoeWeb demo)\r>'); return; }
      if (at.startsWith('sh')) this._header = at.substring(2);
      else if (at.startsWith('cra')) this._filter = at.substring(3);
      else if (at === 'ar') this._filter = '';
      else if (at === 'ma') { this._monitoring = true; this._emitFreeFrame(); return; }
      this._emit('OK\r>');
      return;
    }

    // hex payload = manually framed ISO-TP request (ATCAF0 mode)
    if (!/^[0-9a-f]+$/.test(cmd)) { this._emit('?\r>'); return; }
    const type = cmd[0];
    if (type === '0') {                       // single frame
      const len = parseInt(cmd[1], 16);
      this._respondTo(cmd.substring(2, 2 + len * 2));
    } else if (type === '1') {                // first frame of a long request
      this._multi = { len: parseInt(cmd.substring(1, 4), 16), data: cmd.substring(4) };
      this._emit('30\r');                     // flow control: send the rest
    } else if (type === '2' && this._multi) { // consecutive frame
      this._multi.data += cmd.substring(2);
      if (this._multi.data.length >= this._multi.len * 2) {
        const req = this._multi.data.substring(0, this._multi.len * 2);
        this._multi = null;
        this._respondTo(req);
      } else {
        this._emit('30\r');
      }
    } else {
      this._emit('?\r>');
    }
  }

  /** Wrap a response payload in ISO-TP frame lines, the way an ELM327 prints them. */
  _sendIsoTp(payload) {
    const len = payload.length / 2;
    let out;
    if (len <= 7) {
      out = '0' + len.toString(16) + payload;
      out = out.padEnd(16, 'a') + '\r>';
    } else {
      out = '1' + len.toString(16).padStart(3, '0') + payload.substring(0, 12) + '\r';
      let i = 12, seq = 1;
      while (i < payload.length) {
        out += '2' + (seq & 0xf).toString(16) + payload.substring(i, i + 14).padEnd(14, 'a') + '\r';
        i += 14; seq++;
      }
      out += '>';
    }
    this._emit(out);
  }

  // ---- response synthesis ----------------------------------------------

  _respondTo(requestId) {
    const svc = requestId.substring(0, 2);
    const frameIdHex = this._filter;

    if (svc === '3e') { this._sendIsoTp('7e00'); return; }               // tester present
    if (svc === '10') { this._sendIsoTp('50' + requestId.substring(2)); return; } // session
    if (svc === '14') {                                                   // clear DTCs
      this._clearedDtcs.add(frameIdHex);
      this._sendIsoTp('54');
      return;
    }
    if (svc === '19') { this._sendDtcs(frameIdHex, requestId); return; }  // read DTCs
    if (svc === '2e') {
      this._written.set(frameIdHex + '.' + requestId.substring(2, 6), requestId.substring(6));
      this._sendIsoTp('6e' + requestId.substring(2, 6));
      return;
    }
    if (svc === '31') { this._sendIsoTp('71' + requestId.substring(2)); return; }

    // a previously written DID reads back what was written
    if (svc === '22') {
      const w = this._written.get(frameIdHex + '.' + requestId.substring(2, 6));
      if (w !== undefined) { this._sendIsoTp('62' + requestId.substring(2, 6) + w); return; }
    }

    // data requests (21 xx / 22 xxxx): synthesize from the field database
    const entry = this.db?.registry.diagRequests.get(`${frameIdHex}.${requestId}`);
    if (entry) { this._sendIsoTp(this._synthesize(entry.responseId, entry.fields)); return; }

    // unknown but well-formed 21/22 → echo positive response with zero payload
    if (svc === '21' || svc === '22') {
      const rid = (parseInt(svc, 16) + 0x40).toString(16) + requestId.substring(2);
      this._sendIsoTp(rid + '0000000000');
      return;
    }
    this._sendIsoTp('7f' + svc + '31'); // requestOutOfRange
  }

  _sendDtcs(frameIdHex, requestId) {
    const rid = '59' + requestId.substring(2, 4) + (requestId.substring(4, 6) || 'ff');
    if (this._clearedDtcs.has(frameIdHex)) { this._sendIsoTp(rid); return; }
    const ecu = this.db?.ecuByFromId(frameIdHex);
    const codes = ecu ? [...ecu.dtcs.keys()].slice(0, 2) : [];
    let payload = rid;
    codes.forEach((code, i) => { payload += code + '01' + (i === 0 ? '2f' : '24'); });
    this._sendIsoTp(payload);
  }

  /** Build a positive response for a set of fields sharing one responseId. */
  _synthesize(responseId, fields) {
    const maxTo = Math.max(...fields.map(f => f.to), responseId.length * 4 - 1);
    const bits = new Array(Math.ceil((maxTo + 1) / 8) * 8).fill(0);
    const writeBits = (from, to, value) => {
      for (let i = to; i >= from; i--) { bits[i] = value & 1; value = Math.floor(value / 2); }
    };
    // response id bytes occupy the head of the bit stream
    for (let i = 0; i < responseId.length; i++) {
      writeBits(i * 4, i * 4 + 3, parseInt(responseId[i], 16));
    }
    // strings/hex blobs first, numeric fields after, so specific values win overlaps
    const ordered = [...fields].sort((a, b) => (a.isString || a.isHexString ? 0 : 1) - (b.isString || b.isHexString ? 0 : 1));
    for (const f of ordered) {
      if (f.from < responseId.length * 4) continue;
      const width = f.to - f.from + 1;
      if (f.isString) {
        const s = 'ZOEWEB DEMO DATA'.repeat(4);
        for (let i = 0; i < Math.floor(width / 8); i++) {
          writeBits(f.from + i * 8, f.from + i * 8 + 7, s.charCodeAt(i % s.length));
        }
        continue;
      }
      if (f.isHexString) {
        for (let i = 0; i < Math.floor(width / 8); i++) {
          writeBits(f.from + i * 8, f.from + i * 8 + 7, (0x42 + i) & 0xff);
        }
        continue;
      }
      let raw = Math.round(this._valueFor(f) / f.resolution + f.offset);
      const ceil = Math.pow(2, width) - (width > 4 ? 2 : 1); // avoid all-ones "unavailable"
      if (raw < 0 && !f.isSigned) raw = 0;
      if (raw < 0) raw = Math.pow(2, width) + raw; // two's complement
      writeBits(f.from, f.to, Math.min(Math.max(raw, 0), ceil));
    }
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return hex;
  }

  /** Plausible scaled value for a field, with a slowly evolving driving sim. */
  _valueFor(f) {
    const t = (Date.now() - this._t0) / 1000;
    const speed = 45 + 40 * Math.sin(t / 19) + 5 * Math.sin(t / 3.1);
    const power = 8 + 14 * Math.sin(t / 19 + 0.7);
    const soc = 78.4 - t / 240;
    const n = f.name.toLowerCase();
    const u = f.unit.toLowerCase();

    if (f.list) return 1;
    if (/usoc|user.?soc|_soc|soc\b|state of charge/.test(n)) return soc;
    if (/soh|state of health/.test(n)) return 96.2;
    if (/cell.?volt|volt.*cell/.test(n) || (u === 'v' && /cell/.test(n))) {
      return 3.895 + 0.02 * Math.sin(f.from / 5 + t / 60);
    }
    if (/range|autonomy|available distance|distance to/.test(n)) return soc * 1.45;
    if (u === 'min') return 42;
    if (/serial/.test(n)) return 913450;
    if (/odometer|total.*km|vehicle.*distance/.test(n)) return 45678;
    if (/speed/.test(n) && u.includes('km')) return Math.max(0, speed);
    if (/rpm/.test(n)) return Math.max(0, speed * 95);
    if (/pedal|throttle/.test(n)) return Math.max(0, 25 + 20 * Math.sin(t / 19 + 0.7));
    if (/tyre|tire/.test(n) && u.includes('bar')) return 2.4;
    if (u === 'mbar') return 2400;
    if (/pressure/.test(n)) return 5.2;
    if (/temp/.test(n) || u === '°c' || u === 'ºc') return 24 + 3 * Math.sin(f.from / 7);
    if (/12v|14v|aux.*batt/.test(n) && u === 'v') return 14.1;
    if (u === 'kwh/100km') return 14.2;
    if (u === 'v' && /batt|traction|pack|hv /.test(n)) return 363 + soc / 4;
    if (u === 'v') return 230;
    if (u === 'a') return power > 0 ? power * 2.6 : 0;
    if (u === 'kw') return power;
    if (u === 'kwh') return 0.412 * soc;
    if (u === 'km') return 45678;
    if (u === 'nm') return 0;
    if (u === '%') return 55;
    if (/counter|number of/.test(n)) return 123;
    return 1;
  }

  _emitFreeFrame() {
    const fields = this.db?.registry.fieldsForFreeFrame(this._filter) || [];
    if (!fields.length) return; // stay silent, driver will time out
    const maxTo = Math.max(...fields.map(f => f.to));
    // reuse the synthesizer with an empty response id
    const hex = this._synthesizeFree(fields, maxTo);
    this._emit(hex + '\r');
  }

  _synthesizeFree(fields, maxTo) {
    const bits = new Array(Math.ceil((maxTo + 1) / 8) * 8).fill(0);
    const writeBits = (from, to, value) => {
      for (let i = to; i >= from; i--) { bits[i] = value & 1; value = Math.floor(value / 2); }
    };
    for (const f of fields) {
      let raw = Math.round(this._valueFor(f) / f.resolution + f.offset);
      const width = f.to - f.from + 1;
      const ceil = Math.pow(2, width) - (width > 4 ? 2 : 1);
      if (raw < 0) raw = Math.pow(2, width) + raw;
      writeBits(f.from, f.to, Math.min(Math.max(raw, 0), ceil));
    }
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return hex;
  }
}
