/*
 * ZoeWeb — application shell: settings, connection lifecycle, navigation.
 */
import { VehicleDb, CARS } from './core/ecus.js';
import { Poller } from './core/poller.js';
import { Uds } from './core/uds.js';
import { detectCar } from './core/detect.js';
import { WriteJournal } from './core/journal.js';
import { createVirtualFields } from './core/virtual.js';
import { Elm327 } from './device/elm327.js';
import { SerialTransport, BleTransport, WsTransport } from './device/transport.js';
import { DemoTransport } from './device/demo.js';
import { el, section } from './ui/widgets.js';
import {
  Screen, DashboardScreen, DrivingScreen, BatteryScreen, ChargingScreen,
  RangeScreen, ConsumptionScreen, ClimateScreen, TiresScreen, BrakingScreen,
} from './screens/screens.js';
import { DtcScreen } from './screens/dtc.js';
import { AllDataScreen } from './screens/alldata.js';
import { ProScreen } from './screens/pro.js';
import { BackupsScreen } from './screens/backups.js';
import { ServiceScreen } from './screens/service.js';

export const APP_VERSION = '2026-09-08.1';

const settings = {
  get car() { return localStorage.getItem('zoe.car') || 'ZOE'; },
  set car(v) { localStorage.setItem('zoe.car', v); },
  get transport() { return localStorage.getItem('zoe.transport') || 'demo'; },
  set transport(v) { localStorage.setItem('zoe.transport', v); },
  get baud() { return parseInt(localStorage.getItem('zoe.baud') || '115200', 10); },
  set baud(v) { localStorage.setItem('zoe.baud', String(v)); },
  get wsUrl() { return localStorage.getItem('zoe.wsurl') || 'ws://localhost:8472'; },
  set wsUrl(v) { localStorage.setItem('zoe.wsurl', v); },
  get autoDetect() { return localStorage.getItem('zoe.autodetect') !== '0'; },
  set autoDetect(v) { localStorage.setItem('zoe.autodetect', v ? '1' : '0'); },
};

class SettingsScreen extends Screen {
  constructor() { super('settings', 'Settings', '⚙️'); }
  render(c) {
    const carSel = el('select', { class: 'input', onchange: async e => {
      settings.car = e.target.value;
      await app.reloadDb();
    } });
    for (const [key, car] of Object.entries(CARS)) {
      carSel.append(el('option', { value: key, ...(settings.car === key ? { selected: '' } : {}) }, car.label));
    }
    const trSel = el('select', { class: 'input', onchange: e => { settings.transport = e.target.value; } });
    // explain exactly WHY a transport is unavailable
    const isChromium = !!window.chrome;
    const whyNot = api => {
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
        return api === 'serial'
          ? 'impossible on iOS — Apple allows no browser access to serial ports'
          : 'blocked in iOS browsers (Chrome included) — install the free "Bluefy" browser from the App Store and open this page there';
      }
      if (!window.isSecureContext) return 'page must be served over https:// or localhost';
      if (!isChromium) return 'needs a Chromium browser (Chrome, Edge, Brave…) — Firefox/Safari don’t implement it';
      if (api === 'serial') return /android/i.test(navigator.userAgent)
        ? 'not available in Android Chrome — use Bluetooth LE'
        : 'not enabled in this Chromium build';
      return 'disabled in this Chromium build — try chrome://flags/#enable-web-bluetooth';
    };
    const options = [
      ['demo', 'Demo (simulated car)', true, ''],
      ['serial', 'USB / serial ELM327 (Web Serial)', SerialTransport.available, whyNot('serial')],
      ['ble', 'Bluetooth LE ELM327 (Web Bluetooth)', BleTransport.available, whyNot('bluetooth')],
      ['ws', 'Classic Bluetooth via PC bridge (WebSocket)', WsTransport.available, ''],
    ];
    for (const [v, label, avail, reason] of options) {
      trSel.append(el('option', { value: v, ...(avail ? {} : { disabled: '' }), ...(settings.transport === v ? { selected: '' } : {}) },
        label + (avail ? '' : ' — ' + reason)));
    }
    const wsUrlIn = el('input', { class: 'input mono', value: settings.wsUrl, style: 'min-width:240px',
      onchange: e => { settings.wsUrl = e.target.value.trim(); } });
    const baudSel = el('select', { class: 'input', onchange: e => { settings.baud = e.target.value; } });
    for (const b of [9600, 38400, 115200, 230400]) {
      baudSel.append(el('option', { value: b, ...(settings.baud === b ? { selected: '' } : {}) }, b + ' Bd'));
    }
    c.append(
      section('Vehicle',
        el('div', { class: 'toolbar' }, el('label', {}, 'Car model'), carSel),
        el('div', { class: 'toolbar' }, el('label', {}, 'Auto-detect on connect'),
          (() => {
            const cb = el('input', { type: 'checkbox', onchange: e => { settings.autoDetect = e.target.checked; } });
            cb.checked = settings.autoDetect;
            return el('label', { style: 'min-width:0' }, cb, ' identify the car from its ECUs and switch automatically');
          })()),
        el('div', { class: 'toolbar' }, el('label', {}, ''),
          el('button', { class: 'btn', onclick: async () => {
            if (!app.connected || app.transport instanceof DemoTransport) { app.setStatus('Connect to a real car first to detect it.', 'warn'); return; }
            await app.poller.pause(); try { await app.autoDetectCar(); } finally { app.poller.resume(); }
          } }, 'Detect car now'))),
      section('Dongle',
        el('div', { class: 'toolbar' }, el('label', {}, 'Connection'), trSel),
        el('div', { class: 'toolbar' }, el('label', {}, 'Serial baud rate'), baudSel),
        el('div', { class: 'toolbar' }, el('label', {}, 'Saved serial port'),
          el('button', { class: 'btn', onclick: async e => {
            const n = await SerialTransport.forgetSavedPorts();
            e.target.textContent = n ? 'Forgotten — next Connect will ask' : 'Nothing was saved';
            setTimeout(() => { e.target.textContent = 'Choose port again on next Connect'; }, 2500);
          } }, 'Choose port again on next Connect')),
        el('div', { class: 'toolbar' }, el('label', {}, 'Bridge URL'), wsUrlIn),
        el('p', { class: 'hint' },
          'Web Serial needs Chrome/Edge on desktop. Web Bluetooth also works in Chrome on Android. ' +
          'CLASSIC Bluetooth (SPP) dongles: on macOS, pair the dongle in System Settings and pick its named ' +
          'serial port (e.g. cu.OBDII) — NEVER "Bluetooth-Incoming-Port", that one is a dead end. ' +
          'On Linux/Windows, run "python3 tools/spp-bridge.py <dongle-MAC>" and use the PC-bridge option.')),
      section('About', el('p', { class: 'hint' },
        'ZoeWeb is a web port of CanZE (canze.fisch.lu), reusing its GPL-3.0 vehicle databases. ' +
        'It reads (and, in the Pro console, writes) diagnostic data of Renault ZE cars via an OBD2 dongle. ' +
        'Use at your own risk; never operate while driving.')),
    );
  }
}

class App {
  constructor() {
    this.screens = [
      new DashboardScreen(), new DrivingScreen(), new BatteryScreen(), new ChargingScreen(),
      new RangeScreen(), new ConsumptionScreen(), new ClimateScreen(), new TiresScreen(),
      new BrakingScreen(), new DtcScreen(), new ServiceScreen(), new BackupsScreen(), new AllDataScreen(), new ProScreen(), new SettingsScreen(),
    ];
    this.current = null;
    this.transport = null;
    this.elm = null;
    this.db = null;
    this.poller = null;
    this.uds = null;
    this.connected = false;
    this.journal = new WriteJournal();
  }

  async start() {
    this.$nav = document.getElementById('nav');
    this.$content = document.getElementById('content');
    this.$status = document.getElementById('status-text');
    this.$connBtn = document.getElementById('connect-btn');
    this.$led = document.getElementById('led');
    this.$connBtn.addEventListener('click', () => this.connected ? this.disconnect() : this.connect());

    for (const s of this.screens) {
      const b = el('button', { class: 'nav-btn', 'data-id': s.id, onclick: () => location.hash = s.id },
        el('span', { class: 'nav-icon' }, s.icon), el('span', {}, s.title));
      this.$nav.append(b);
    }
    window.addEventListener('hashchange', () => this.route());
    // close the serial port on refresh/navigation, or the OS keeps a wedged
    // half-open Bluetooth channel and the next session gets silence
    window.addEventListener('pagehide', () => { if (this.connected) this.disconnect(); });

    await this.reloadDb();
    this.route();
    if (new URLSearchParams(location.search).has('autoconnect')) await this.connect();
  }

  async reloadDb() {
    const wasConnected = this.connected;
    if (wasConnected) await this.disconnect();
    this.setStatus(`Loading ${CARS[settings.car].label} database…`);
    this.db = await new VehicleDb(settings.car).load();
    this.elm = new Elm327(new DemoTransport()); // placeholder until connect
    this.poller = new Poller(this.db, this.elm);
    for (const vf of createVirtualFields()) this.poller.registerVirtual(vf);
    this.uds = new Uds(this.elm);
    this.poller.onError = (job, e) => this.setStatus(`${job.key}: ${e.message}`, 'warn');
    this.poller.onActivity = job => { this.blink(); };
    this.setStatus(`${CARS[settings.car].label} — ${this.db.registry.all.length} fields, ${this.db.ecus.length} ECUs. Not connected.`);
    // re-render current screen against the new db
    if (this.current) { const cur = this.current; this.current = null; this.show(cur.id); }
  }

  async connect() {
    try {
      const kind = settings.transport;
      this.transport =
        kind === 'serial' ? new SerialTransport(settings.baud) :
        kind === 'ble' ? new BleTransport() :
        kind === 'ws' ? new WsTransport(settings.wsUrl) : new DemoTransport();
      if (this.transport instanceof DemoTransport) this.transport.db = this.db;
      this.setStatus('Connecting…');
      await this.transport.connect();
      this.elm = new Elm327(this.transport);
      this.poller.elm = this.elm;
      this.uds.elm = this.elm;
      try {
        await this.elm.init(msg => this.setStatus(msg));
      } catch (e) {
        if (kind !== 'serial') throw e;
        // transient Bluetooth-serial wedge: cycle the port once and retry
        this.setStatus('No answer — cycling the port and retrying…');
        await this.transport.disconnect();
        await new Promise(r => setTimeout(r, 800));
        await this.transport.connect();
        this.elm = new Elm327(this.transport);
        this.poller.elm = this.elm;
        this.uds.elm = this.elm;
        await this.elm.init(msg => this.setStatus(msg));
      }
      this.connected = true;
      this.$connBtn.textContent = 'Disconnect';
      this.$connBtn.classList.add('connected');
      if (settings.autoDetect && !(this.transport instanceof DemoTransport)) {
        await this.autoDetectCar();
      }
      this.poller.start();
      this.setStatus(`Connected — ${this.transport.info}`);
    } catch (e) {
      this.setStatus('Connection failed: ' + (e?.message || e?.name || (e ? String(e) : 'unknown error')), 'warn');
      try { await this.transport?.disconnect(); } catch (_) {}
      this.connected = false;
    }
  }

  /** Probe the bus and switch to the detected car's database if it differs. */
  async autoDetectCar() {
    this.setStatus('Identifying car…');
    let result;
    try {
      result = await detectCar(this.elm, msg => this.setStatus('Identifying car — ' + msg));
    } catch (e) {
      this.setStatus('Auto-detect failed (' + (e?.message || e) + ') — using ' + CARS[settings.car].label, 'warn');
      return;
    }
    if (!result.car) {
      this.setStatus(`Could not identify the car automatically — using ${CARS[settings.car].label}. Set it in Settings if wrong.`, 'warn');
      return;
    }
    if (result.car === settings.car) {
      this.setStatus(`Detected ${CARS[result.car].label} ✓`);
      return;
    }
    // switch database, keeping the live connection
    settings.car = result.car;
    this.db = await new VehicleDb(result.car).load();
    this.poller = new Poller(this.db, this.elm);
    for (const vf of createVirtualFields()) this.poller.registerVirtual(vf);
    this.uds = new Uds(this.elm);
    this.poller.onError = (job, e) => this.setStatus(`${job.key}: ${e.message}`, 'warn');
    this.poller.onActivity = () => this.blink();
    if (this.current) { const cur = this.current; this.current = null; this.show(cur.id); }
    this.setStatus(`Auto-detected ${CARS[result.car].label} — database switched.`);
  }

  async disconnect() {
    this.connected = false;
    await this.poller?.stop();
    try { await this.transport?.disconnect(); } catch (_) {}
    if (this.elm) this.elm.initialized = false;
    this.$connBtn.textContent = 'Connect';
    this.$connBtn.classList.remove('connected');
    this.setStatus('Disconnected.');
  }

  route() {
    const id = location.hash.replace('#', '') || 'dashboard';
    this.show(this.screens.some(s => s.id === id) ? id : 'dashboard');
  }

  show(id) {
    if (this.current?.id === id) return;
    if (this.current) this.current.unmount(this);
    this.current = this.screens.find(s => s.id === id);
    this.$content.replaceChildren();
    document.querySelectorAll('.nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.id === id));
    this.current.mount(this.$content, this);
    document.getElementById('sidebar').classList.remove('open');
  }

  setStatus(text, cls = '') {
    this.$status.textContent = text;
    this.$status.className = cls;
  }

  blink() {
    this.$led.classList.add('on');
    clearTimeout(this._ledT);
    this._ledT = setTimeout(() => this.$led.classList.remove('on'), 150);
  }
}

const app = new App();
document.getElementById('menu-btn').addEventListener('click', () =>
  document.getElementById('sidebar').classList.toggle('open'));
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.getElementById('app-version').textContent = 'v' + APP_VERSION + ' · ';
app.start().catch(e => {
  document.getElementById('status-text').textContent = 'Failed to start: ' + e.message;
  console.error(e);
});
