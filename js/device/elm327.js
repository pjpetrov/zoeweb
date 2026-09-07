/*
 * ZoeWeb — ELM327 driver. A direct port of CanZE's ELM327.java flow:
 *   init:      ate0 ats0 ath0 atl0 atal atcaf0 atfcsh77b atfcsd300000 atfcsm1 atsp6
 *   free frame: atcra<id> + atma, grab one line
 *   ISO-TP:    atsh/atcra/atfcsh (+atsp7/atcp for 29 bit), manual framing, assemble
 */

export class ElmError extends Error {
  constructor(msg, nrc = null) { super(msg); this.nrc = nrc; }
}

const NRC_TEXT = {
  '10': 'general reject', '11': 'service not supported', '12': 'sub-function not supported',
  '13': 'incorrect message length', '22': 'conditions not correct', '31': 'request out of range',
  '33': 'security access denied', '35': 'invalid key', '7f': 'service not supported in active session',
  '78': 'response pending',
};

export class Elm327 {
  constructor(transport, log = () => {}) {
    this.transport = transport;
    this.log = log;              // (dir, text) → traffic console
    this._buf = '';
    this._waiter = null;
    this._lastId = '';           // last addressed ECU response id
    this._lastWasFree = false;
    this._lastWasExtended = false;
    this.initialized = false;
    transport.onData = chunk => this._onData(chunk);
  }

  _onData(chunk) {
    this._buf += chunk;
    if (this._waiter && this._waiter.test(this._buf)) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve(this._take());
    }
  }

  _take() { const b = this._buf; this._buf = ''; return b; }

  /** Send a command and wait until the buffer satisfies `test` (default: prompt). */
  send(cmd, { timeout = 2500, test = b => b.includes('>') } = {}) {
    return new Promise((resolve, reject) => {
      if (this._waiter) { this._waiter.reject(new ElmError('overlapping command')); this._waiter = null; }
      this._buf = '';
      const timer = setTimeout(() => {
        if (this._waiter) { this._waiter = null; resolve(this._take()); } // return whatever arrived
      }, timeout);
      this._waiter = {
        test,
        resolve: v => { clearTimeout(timer); this.log('rx', v); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
      if (cmd !== null) {
        this.log('tx', cmd);
        this.transport.write(cmd + '\r').catch(e => {
          clearTimeout(timer);
          if (this._waiter) { this._waiter = null; }
          reject(e);
        });
      }
    });
  }

  /** Send a bare CR and swallow whatever arrives — resyncs a laggy/booting link. */
  async _drain(ms = 350) {
    try { await this.transport.write('\r'); } catch (_) {}
    await new Promise(r => setTimeout(r, ms));
    this._buf = '';
  }

  async _cmdOk(cmd, retries = 0) {
    let last = '';
    for (let i = 0; i <= retries; i++) {
      const r = await this.send(cmd);
      if (r.toUpperCase().includes('OK') || r.includes('>')) return r;
      last = r;
      await this._drain(); // a late response from the previous command may be in flight
    }
    throw new ElmError(`ELM rejected "${cmd}": ${last.trim() || 'no answer'}`);
  }

  async init(onProgress = () => {}) {
    this.initialized = false;
    this._lastId = '';
    // Bluetooth serial links (macOS /dev/cu.*) come up lazily — the first bytes
    // written can be lost while the link re-establishes. Wake it and flush.
    onProgress('Waking the link…');
    await this._drain(600);
    await this._drain(300);
    onProgress('Resetting dongle…');
    await this.send('atws', { timeout: 4000 });
    await this.send('atd', { timeout: 1500 });
    await this._drain(200);
    const cmds = ['ate0', 'ats0', 'ath0', 'atl0', 'atal', 'atcaf0', 'atfcsh77b', 'atfcsd300000', 'atfcsm1', 'atsp6'];
    for (const c of cmds) {
      onProgress(`Init: ${c}`);
      await this._cmdOk(c, 2);
    }
    this.initialized = true;
    onProgress('Dongle ready');
  }

  /**
   * Probe one 11-bit id with a diag session request (10C0), headers on so the
   * responder's id is visible. Returns {requestId, responseId} or null.
   * Call probeBegin() once before a scan and probeEnd() after.
   */
  async probeBegin() {
    await this._cmdOk('atar').catch(() => {});
    await this._cmdOk('ath1');
    this._lastId = '';
  }

  async probeEnd() {
    await this._cmdOk('ath0').catch(() => {});
    this._lastId = '';
  }

  async probeId(idHex, timeout = 300) {
    await this._cmdOk('atsh' + idHex);
    await this._cmdOk('atfcsh' + idHex);
    const resp = await this.send('0210c0', { timeout, test: b => /50c0/i.test(b) });
    const m = resp.toLowerCase().replace(/\s/g, '').match(/([0-9a-f]{3})?0[0-9a-f]50c0/);
    if (!m) return null;
    return {
      requestId: idHex,
      responseId: m[1] || (parseInt(idHex, 16) + 0x20).toString(16),
    };
  }

  /** Passively capture one frame with the given 11-bit id (hex, e.g. "654"). */
  async requestFreeFrame(idHex, timeoutMs = 1200) {
    if (!this.initialized) throw new ElmError('not initialized');
    await this._cmdOk('atcra' + idHex);
    this._lastWasFree = true;
    this._lastId = '';
    const hexLine = b => /(^|[\r\n])[0-9a-fA-F]{2,}[\r\n]/.test(b);
    const resp = await this.send('atma', { timeout: timeoutMs, test: hexLine });
    // stop the monitor and swallow the leftovers
    await this.send('', { timeout: 300 }).catch(() => {});
    const line = resp.split(/[\r\n]+/).map(s => s.trim().replace(/\s/g, ''))
      .find(l => /^[0-9a-fA-F]{2,}$/.test(l));
    if (!line) throw new ElmError(`no frame captured for id ${idHex}`);
    return line.toLowerCase();
  }

  /** Address an ECU (once) then send a UDS request; returns the reassembled payload hex. */
  async requestIsoTp(ecu, requestId, { timeout = 3000 } = {}) {
    if (!this.initialized) throw new ElmError('not initialized');
    requestId = requestId.toLowerCase();

    if (this._lastWasFree) {
      await this._cmdOk('atar');
      this._lastWasFree = false;
      this._lastId = '';
    }

    if (this._lastId !== ecu.fromIdHex) {
      if (ecu.isExtended) {
        if (!this._lastWasExtended) {
          await this._cmdOk('atsp7');
          this._lastWasExtended = true;
        }
        await this._cmdOk('atcp' + ecu.toIdHex.substring(0, 2));
        await this._cmdOk('atsh' + ecu.toIdHex.substring(2));
      } else {
        if (this._lastWasExtended || this._lastId === '') {
          await this._cmdOk('atsp6');
          this._lastWasExtended = false;
        }
        await this._cmdOk('atsh' + ecu.toIdHex);
      }
      await this._cmdOk('atcra' + ecu.fromIdHex);
      await this._cmdOk('atfcsh' + ecu.toIdHex);
      this._lastId = ecu.fromIdHex;
    }

    // ---- transmit ----
    const len = requestId.length / 2;
    let resp;
    if (requestId.length <= 14) {
      resp = await this.send('0' + len.toString(16) + requestId, { timeout });
    } else {
      let flow = await this.send('1' + len.toString(16).padStart(3, '0') + requestId.substring(0, 12),
        { timeout, test: b => /[\r\n>]/.test(b) });
      let i = 12, seq = 1;
      while (i < requestId.length) {
        const chunk = '2' + (seq & 0xf).toString(16) + requestId.substring(i, i + 14);
        if (flow.trim().startsWith('3000')) {
          resp = await this.send(chunk, { timeout });
        } else if (flow.trim().startsWith('30')) {
          flow = await this.send(chunk, { timeout, test: b => /[\r\n>]/.test(b) });
          resp = flow;
        } else {
          throw new ElmError('ISO-TP tx flow error: ' + flow.trim());
        }
        i += 14; seq++;
      }
    }

    return this._assemble(resp, ecu, requestId, timeout);
  }

  async _assemble(resp, ecu, requestId, timeout) {
    const clean = s => s.trim().replace(/\s/g, '').toLowerCase();
    let lines = resp.split(/[\r\n]+/).map(clean).filter(l => l && l !== '>' && !/^ok$/i.test(l));
    if (lines.some(l => l.includes('canerror'))) throw new ElmError('CAN ERROR (car asleep or wrong car type?)');
    let first = lines.find(l => /^[01][0-9a-f]/.test(l));
    // maybe the remaining frames are still on their way — wait for the prompt
    if (!first || (first[0] === '1' && !resp.includes('>'))) {
      const more = await this.send(null, { timeout });
      lines = lines.concat(more.split(/[\r\n]+/).map(clean).filter(l => l && l !== '>'));
      first = first || lines.find(l => /^[01][0-9a-f]/.test(l));
    }
    if (!first) throw new ElmError('empty/invalid answer: ' + JSON.stringify(resp.trim().substring(0, 60)));

    let payload, expected;
    if (first[0] === '0') {                       // single frame
      const n = parseInt(first[1], 16);
      payload = first.substring(2, 2 + n * 2);
      expected = n;
    } else {                                      // first + consecutive frames
      expected = parseInt(first.substring(1, 4), 16);
      payload = first.substring(4);
      for (const l of lines) {
        if (l === first || !/^2[0-9a-f]/.test(l)) continue;
        payload += l.substring(2);
      }
      payload = payload.substring(0, expected * 2);
      if (payload.length < expected * 2) {
        throw new ElmError(`ISO-TP rx incomplete: got ${payload.length / 2}/${expected} bytes`);
      }
    }

    if (payload.startsWith('7f')) {
      const nrc = payload.substring(4, 6);
      throw new ElmError(`ECU refused ${requestId} (${NRC_TEXT[nrc] || 'NRC 0x' + nrc})`, nrc);
    }
    return payload;
  }
}
