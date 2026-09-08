/*
 * ZoeWeb — dongle transports.
 * A transport moves raw text between the app and an ELM327-compatible dongle.
 *   connect(), disconnect(), write(string), set onData(cb), get info
 */

export class SerialTransport {
  constructor(baudRate = 115200) {
    this.baudRate = baudRate;
    this.onData = null;
    this.port = null;
    this._reader = null;
    this._writer = null;
    this._closing = false;
  }

  static get available() { return 'serial' in navigator; }
  get info() { return `USB serial @ ${this.baudRate} Bd`; }

  async _open(port) {
    try {
      await port.open({ baudRate: this.baudRate });
    } catch (e) {
      // a refresh may have left the port half-open — close, settle, retry once
      try { await port.close(); } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
      await port.open({ baudRate: this.baudRate });
    }
    return port;
  }

  async connect() {
    // reuse the port the user already granted (no picker on reconnect/refresh);
    // if the saved grant is stale (e.g. after re-pairing the dongle), forget it
    // and fall back to the picker
    this.port = null;
    const granted = await navigator.serial.getPorts();
    if (granted.length === 1) {
      try {
        this.port = await this._open(granted[0]);
      } catch (e) {
        try { await granted[0].forget(); } catch (_) {}
      }
    }
    if (!this.port) {
      this.port = await this._open(await navigator.serial.requestPort());
    }
    this._writer = this.port.writable.getWriter();
    this._closing = false;
    this._readLoop();
  }

  /** Drop all saved port grants so the next connect shows the picker again. */
  static async forgetSavedPorts() {
    if (!('serial' in navigator)) return 0;
    const ports = await navigator.serial.getPorts();
    for (const p of ports) { try { await p.forget(); } catch (_) {} }
    return ports.length;
  }

  _readLoop() {
    this._readLoopDone = (async () => {
      const decoder = new TextDecoder();
      while (this.port?.readable && !this._closing) {
        this._reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this._reader.read();
            if (done) break;
            if (value && this.onData) this.onData(decoder.decode(value));
          }
        } catch (e) {
          if (!this._closing) console.error('serial read', e);
        } finally {
          this._reader.releaseLock();
        }
      }
    })();
  }

  async write(str) {
    await this._writer.write(new TextEncoder().encode(str));
  }

  async disconnect() {
    this._closing = true;
    try { await this._reader?.cancel(); } catch (_) {}
    // wait until the read loop has actually released its stream lock —
    // closing while locked silently fails and leaves the port wedged
    try { await this._readLoopDone; } catch (_) {}
    try { this._writer?.releaseLock(); } catch (_) {}
    this._writer = null;
    try { await this.port?.close(); } catch (e) { console.warn('port close', e); }
    this.port = null;
  }
}

/*
 * BLE ELM327 clones expose a "serial over GATT" service: one characteristic
 * that notifies (dongle→app) and one that accepts writes (app→dongle) —
 * sometimes the same characteristic does both. Which service UUID is used
 * varies wildly between clones, so we request access to all the usual
 * suspects and then DISCOVER the notify/write pair generically instead of
 * hardcoding characteristic ids.
 *
 * Web Bluetooth only lets a page see services it declared up front, so this
 * list is the gate: a dongle using yet another UUID needs it added here.
 */
/*
 * WebSocket transport — for CLASSIC Bluetooth (SPP) dongles via the local
 * tools/spp-bridge.py helper, which relays a WebSocket to the dongle.
 * ws://localhost is allowed even from an https page.
 */
export class WsTransport {
  constructor(url = 'ws://localhost:8472') {
    this.url = url;
    this.onData = null;
    this.ws = null;
  }

  static get available() { return 'WebSocket' in window; }
  get info() { return `SPP bridge (${this.url})`; }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      const decoder = new TextDecoder();
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error(
        `cannot reach the bridge at ${this.url} — is "python3 tools/spp-bridge.py …" running on THIS computer?`));
      ws.onmessage = ev => {
        if (this.onData) {
          this.onData(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data));
        }
      };
      ws.onclose = () => { this.ws = null; };
    });
  }

  async write(str) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('bridge connection lost');
    this.ws.send(new TextEncoder().encode(str));
  }

  async disconnect() {
    try { this.ws?.close(); } catch (_) {}
    this.ws = null;
  }
}

const shortUuid = u => u.startsWith('0000') && u.endsWith('-0000-1000-8000-00805f9b34fb')
  ? u.substring(4, 8) : u;
const charProps = c => ['notify', 'indicate', 'write', 'writeWithoutResponse', 'read']
  .filter(p => c.properties[p]).map(p => p === 'writeWithoutResponse' ? 'wnr' : p[0] + p[1]).join(',');

/*
 * All service UUIDs as full 128-bit strings: the spec also allows 16-bit
 * numbers, but some Web-BLE implementations (Bluefy on iOS) fail to parse
 * them ("Request payload could not be parsed").
 */
const uuid128 = v => typeof v === 'number'
  ? `0000${v.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`
  : v.toLowerCase();
const BLE_CANDIDATE_SERVICES = [...new Set([
  0xfff0,   // most Chinese clones (fff1/fff2)
  0xffe0,   // HM-10 style modules (ffe1 does both)
  0xffe5,   // HM-16/17 split write service (ffe9)
  0xffb0,   // some "OBDBLE" clones
  0x18f0,   // Viecar / iCar style (2af0/2af1)
  0xabf0,   // some vLinker firmwares (abf1/abf2)
  0xae00,   // cheap generic BLE serial (ae01/ae02)
  0xff00,   // misc clones
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service (NUS)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate iCar Pro BLE
].map(uuid128))];

export class BleTransport {
  constructor() {
    this.onData = null;
    this.device = null;
    this._writeChar = null;
    this._name = '';
    this._writeWithResponse = false;
  }

  static get available() { return 'bluetooth' in navigator; }
  get info() { return `Bluetooth LE (${this._name || 'not connected'})`; }

  async connect() {
    const errText = e => e?.message || e?.name || (e ? String(e) : 'unknown error');
    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BLE_CANDIDATE_SERVICES,
      });
    } catch (e1) {
      // Bluefy and some other Web-BLE implementations reject acceptAllDevices —
      // retry with explicit filters (common dongle names + known services)
      const filters = [
        ...['IOS-Vlink', 'vLink', 'V-LINK', 'VLink', 'OBD', 'ELM', 'iCar', 'IOS-', 'KONNWEI', 'Veepeak', 'VEEPEAK']
          .map(namePrefix => ({ namePrefix })),
        ...BLE_CANDIDATE_SERVICES.map(s => ({ services: [s] })),
      ];
      try {
        this.device = await navigator.bluetooth.requestDevice({ filters, optionalServices: BLE_CANDIDATE_SERVICES });
      } catch (e2) {
        throw new Error('Bluetooth picker failed: ' + errText(e2) +
          (errText(e1) !== errText(e2) ? ` (first attempt: ${errText(e1)})` : ''));
      }
    }
    this._name = this.device.name || this.device.id;
    let server;
    try {
      server = await this.device.gatt.connect();
    } catch (e) {
      throw new Error('GATT connect failed: ' + (e?.message || e?.name || e || 'unknown error'));
    }

    let services = [];
    try { services = await server.getPrimaryServices(); } catch (_) {}
    const found = [];

    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (_) { continue; }
      found.push(`${svc.uuid} [${chars.map(c => shortUuid(c.uuid) + ':' + charProps(c)).join(' ')}]`);
      const notifyChar = chars.find(c => c.properties.notify || c.properties.indicate);
      const writeChar = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
      if (!notifyChar || !writeChar) continue;

      await notifyChar.startNotifications();
      const decoder = new TextDecoder();
      notifyChar.addEventListener('characteristicvaluechanged', ev => {
        if (this.onData) this.onData(decoder.decode(ev.target.value));
      });
      this._writeChar = writeChar;
      this._writeWithResponse = !writeChar.properties.writeWithoutResponse;
      this._name += ` (${shortUuid(svc.uuid)})`;
      return;
    }

    this.device.gatt.disconnect();
    throw new Error(found.length
      ? 'No usable serial service on this device. It exposed: ' + found.join('; ') +
        ' — send this to the developer to get the dongle supported.'
      : 'The device exposed no accessible GATT services. This usually means it is a CLASSIC ' +
        'Bluetooth (SPP) ELM327, which no browser can use — you need a BLE dongle ' +
        '(e.g. Vgate iCar Pro "Bluetooth 4.0", vLinker MC+, OBDLink CX) or a USB cable.');
  }

  async write(str) {
    const data = new TextEncoder().encode(str);
    // BLE writes are limited to ~20 bytes per packet on many clones
    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, i + 20);
      if (!this._writeWithResponse && this._writeChar.writeValueWithoutResponse) {
        await this._writeChar.writeValueWithoutResponse(chunk);
      } else {
        await this._writeChar.writeValue(chunk);
      }
    }
  }

  async disconnect() {
    try { this.device?.gatt?.disconnect(); } catch (_) {}
    this.device = null;
  }
}
