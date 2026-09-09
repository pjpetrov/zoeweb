/*
 * ZoeWeb — Expert (DDT4All) page. Loads DDT4All ECU definition files and
 * renders their parameters with a clean UI: read any value (decoded with the
 * ECU's own scaling/enums) and write configuration (guarded + journaled).
 *
 * No proprietary database is shipped — the user loads their own .json ECU files.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';
import { parseDdt } from '../core/ddt.js';
import { listZip, extractText } from '../core/unzip.js';

const STORE = 'zoe.ddt.files.v1';

export class ExpertScreen extends Screen {
  constructor() {
    super('expert', 'Expert (DDT)', '🧩');
    this.ecus = new Map();   // name → DdtEcu
    this._loadStored();
  }

  _loadStored() {
    try {
      const files = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const [fn, text] of Object.entries(files)) {
        try { const e = parseDdt(text, fn); this.ecus.set(e.name, e); } catch (_) {}
      }
    } catch (_) {}
  }

  _persist(fn, text) {
    try {
      const files = JSON.parse(localStorage.getItem(STORE) || '{}');
      files[fn] = text;
      localStorage.setItem(STORE, JSON.stringify(files));
    } catch (_) { /* too big for localStorage — kept in memory only */ }
  }

  render(c, ctx) {
    const status = el('div', { class: 'hint' },
      this.ecus.size ? `${this.ecus.size} ECU definition(s) loaded.` : 'No ECU definitions loaded yet.');
    const body = el('div', {});

    // --- file loader (individual .json) ---
    const fileInput = el('input', { type: 'file', accept: '.json', multiple: '', style: 'display:none',
      onchange: async e => {
        for (const file of e.target.files) {
          try {
            const text = await file.text();
            const ecu = parseDdt(text, file.name);
            this.ecus.set(ecu.name, ecu);
            this._persist(file.name, text);
          } catch (err) { status.textContent = `✗ ${file.name}: ${err.message}`; }
        }
        rebuild();
      } });
    const loadBtn = el('button', { class: 'btn', onclick: () => fileInput.click() }, 'Load ECU file(s)…');

    // --- database .zip loader: auto-pick ECUs matching the selected car ---
    const zipInput = el('input', { type: 'file', accept: '.zip', style: 'display:none',
      onchange: async e => {
        const file = e.target.files[0];
        if (file) await this._loadZip(ctx, file, status, rebuild);
        zipInput.value = '';
      } });
    const zipBtn = el('button', { class: 'btn', onclick: () => zipInput.click() }, 'Load database .zip (auto-match car)…');
    const clearBtn = el('button', { class: 'btn', onclick: () => {
      if (!confirm('Forget all loaded ECU definitions? (Your files are not deleted.)')) return;
      this.ecus.clear(); localStorage.removeItem(STORE); rebuild();
    } }, 'Clear loaded');

    // --- ecu selector + search ---
    const ecuSel = el('select', { class: 'input', onchange: rebuildBody });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'filter parameters…',
      oninput: () => { clearTimeout(this._deb); this._deb = setTimeout(rebuildBody, 250); } });

    const self = this;
    function rebuild() {
      ecuSel.replaceChildren();
      for (const name of self.ecus.keys()) ecuSel.append(el('option', { value: name }, name));
      status.textContent = self.ecus.size
        ? `${self.ecus.size} ECU definition(s) loaded — pick one below.`
        : 'No ECU definitions loaded. Load your DDT4All .json ECU files to begin.';
      rebuildBody();
    }

    function rebuildBody() {
      body.replaceChildren();
      const ecu = self.ecus.get(ecuSel.value);
      if (!ecu) {
        body.append(el('p', { class: 'hint' },
          'Load your DDT4All database: "Load database .zip" scans the whole ecu.zip and keeps only the ECU ' +
          'definitions whose diagnostic address matches the car you picked in Settings (' + ctx.db.car.label + '). ' +
          'Or load individual .json ECU files. Then pick an ECU above. No proprietary data is bundled in the app. ' +
          'Tip: a few addresses are shared across Renault models, so if two files match one ECU, prefer the one ' +
          'named for your platform (Zoe = X10 / L38 / X61) or the newest date.'));
        return;
      }
      const filter = search.value.trim().toLowerCase();
      const match = r => !filter || r.name.toLowerCase().includes(filter);
      body.append(el('p', { class: 'hint mono' },
        `${ecu.name} — request id ${ecu.toIdHex} → response ${ecu.fromIdHex} (${ecu.protocol}); ` +
        `${ecu.reads().length} readable, ${ecu.writes().length} writable parameters.`));
      body.append(self._sessionBar(ctx, ecu));
      body.append(self._reads(ctx, ecu, r => match(r)));
      body.append(self._writes(ctx, ecu, r => match(r)));
    }

    c.append(
      section('DDT4All ECU definitions',
        el('div', { class: 'toolbar' }, zipBtn, loadBtn, clearBtn, fileInput, zipInput),
        status,
        el('div', { class: 'warnbox' },
          '⚠️ Expert mode drives raw ECU requests loaded from your DDT files. Reads are safe; writes change ' +
          'ECU configuration and are executed as defined — every write is backed up to the Backups screen. ' +
          'Car stationary, ignition on. Know what a parameter does before writing it.'),
        el('div', { class: 'toolbar' }, el('label', {}, 'ECU'), ecuSel, search)),
      body,
    );
    rebuild();
  }

  /**
   * Load a DDT database .zip and keep only the ECU files whose diagnostic
   * address matches an ECU of the currently selected car (from Settings).
   */
  async _loadZip(ctx, file, status, rebuild) {
    status.textContent = 'Reading zip…';
    // the selected car's ECU addresses (request + response ids), from the DB
    const carIds = new Set();
    for (const e of ctx.db.ecus) {
      if (e.toIdHex) carIds.add(e.toIdHex.toLowerCase());
      if (e.fromIdHex) carIds.add(e.fromIdHex.toLowerCase());
    }
    let entries;
    try {
      const buf = await file.arrayBuffer();
      entries = listZip(buf).filter(en => /\.json$/i.test(en.name));
      status.textContent = `Scanning ${entries.length} ECU files for ${ctx.db.car.label}…`;
      let matched = 0, scanned = 0;
      for (const en of entries) {
        scanned++;
        if (scanned % 100 === 0) status.textContent = `Scanning ${scanned}/${entries.length}… (${matched} match so far)`;
        let text;
        try { text = await extractText(buf, en); } catch (_) { continue; }
        let obd;
        try { obd = JSON.parse(text).obd; } catch (_) { continue; }
        const send = (obd?.send_id || '').toLowerCase();
        const recv = (obd?.recv_id || '').toLowerCase();
        if (!carIds.has(send) && !carIds.has(recv)) continue; // not this car's ECU
        try {
          const ecu = parseDdt(text, en.name.split('/').pop());
          this.ecus.set(ecu.name, ecu);
          this._persist(en.name.split('/').pop(), text);
          matched++;
        } catch (_) {}
      }
      status.textContent = `✓ matched ${matched} ECU definition(s) for ${ctx.db.car.label} ` +
        `(from ${entries.length} in the zip). Pick one below.`;
    } catch (err) {
      status.textContent = '✗ ' + err.message;
    }
    rebuild();
  }

  _sessionBar(ctx, ecu) {
    const log = el('span', { class: 'hint' }, '');
    const run = (label, reqHex) => async () => {
      if (!ctx.elm.initialized) { log.textContent = 'connect to the car first'; return; }
      await ctx.poller.pause();
      try { const r = await ctx.uds.raw(ecu.handle(), reqHex); log.textContent = `${label}: ${r}`; }
      catch (e) { log.textContent = `${label}: ${e.message}`; }
      finally { ctx.poller.resume(); }
    };
    return el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: run('extended session', '10c0') }, 'Extended session'),
      el('button', { class: 'btn', onclick: run('tester present', '3e00') }, 'Tester present'),
      log);
  }

  _reads(ctx, ecu, match) {
    const box = section('Read parameters');
    const results = el('div', {});
    const list = ecu.reads().filter(match);
    const table = el('table', { class: 'table' });
    for (const req of list.slice(0, 300)) {
      const btn = el('button', { class: 'btn', style: 'padding:4px 10px', onclick: () => this._read(ctx, ecu, req, results) }, 'Read');
      table.append(el('tr', {}, el('td', {}, req.name), el('td', { class: 'mono hint' }, req.sentbytes), el('td', {}, btn)));
    }
    box.append(
      el('div', { class: 'toolbar' },
        el('button', { class: 'btn', onclick: async () => {
          for (const req of list.slice(0, 60)) await this._read(ctx, ecu, req, results);
        } }, `Read all (${Math.min(list.length, 60)})`),
        el('span', { class: 'hint' }, `${list.length} readable`)),
      results,
      el('div', { class: 'scroll-x' }, table));
    return box;
  }

  async _read(ctx, ecu, req, results) {
    if (!ctx.elm.initialized) { return; }
    await ctx.poller.pause();
    try {
      const payload = await ctx.uds.raw(ecu.handle(), req.sentbytes, { timeout: 4000 });
      const items = ecu.decode(req, payload);
      const card = el('div', { class: 'card' }, el('h3', {}, req.name));
      const t = el('table', { class: 'table' });
      for (const it of items) {
        t.append(el('tr', {},
          el('td', {}, it.comment || it.name),
          el('td', { class: 'mono' }, `${it.value} ${it.unit}`.trim())));
      }
      card.append(el('div', { class: 'scroll-x' }, t));
      results.prepend(card);
      while (results.childElementCount > 8) results.lastChild.remove();
    } catch (e) {
      results.prepend(el('p', { class: 'hint' }, `${req.name}: ${e.message}`));
    } finally {
      ctx.poller.resume();
    }
  }

  _writes(ctx, ecu, match) {
    const box = section('Write parameters');
    const list = ecu.writes().filter(match);
    const table = el('table', { class: 'table' });
    for (const req of list.slice(0, 300)) {
      // a write request typically carries one dataitem
      const itemName = Object.keys(req.sendbyte_dataitems)[0];
      const def = ecu.itemDef(itemName);
      let input;
      if (def.lists) {
        input = el('select', { class: 'input' });
        for (const [k, label] of Object.entries(def.lists)) input.append(el('option', { value: k }, `${label} (${k})`));
      } else {
        input = el('input', { class: 'input mono', placeholder: def.unit || 'value', style: 'min-width:120px' });
      }
      const apply = el('button', { class: 'btn danger', style: 'padding:4px 10px',
        onclick: () => this._write(ctx, ecu, req, itemName, input) }, 'Write ⚠');
      table.append(el('tr', {},
        el('td', {}, req.name), el('td', {}, input), el('td', {}, apply)));
    }
    box.append(el('span', { class: 'hint' }, `${list.length} writable`), el('div', { class: 'scroll-x' }, table));
    return box;
  }

  async _write(ctx, ecu, req, itemName, input) {
    if (!ctx.elm.initialized) { alert('Connect to the car first.'); return; }
    const raw = ecu.toRaw(itemName, input.value);
    if (Number.isNaN(raw)) { alert('Enter a value.'); return; }
    const hex = ecu.buildWrite(req, itemName, raw);
    const phrase = ecu.name.slice(0, 6).toUpperCase();
    if (prompt(`⚠️ WRITE to ${ecu.name}\n\n${req.name}\nrequest: ${hex}\n\nEvery write is backed up. ` +
      `Type ${phrase} to confirm:`)?.trim().toUpperCase() !== phrase) return;
    await ctx.poller.pause();
    try {
      await ctx.uds.startSession(ecu.handle()).catch(() => {});
      // back up: find a matching read request for this identifier
      const did = req.sentbytes.substring(2, 6);
      const readReq = ecu.reads().find(r => r.sentbytes.substring(2, 6) === did);
      let before = null;
      if (readReq) {
        const p = await ctx.uds.raw(ecu.handle(), readReq.sentbytes).catch(() => null);
        if (p) before = ecu.buildWrite(req, itemName, ecu.decode(readReq, p)[0]?.raw ?? 0);
      }
      const resp = await ctx.uds.raw(ecu.handle(), hex, { timeout: 5000 });
      ctx.journal.record({
        ecuName: ecu.name, toIdHex: ecu.toIdHex, fromIdHex: ecu.fromIdHex, sessionRequestId: '10c0',
        did, label: `DDT: ${req.name}`,
        before: before ? before.substring(4) : null, after: hex.substring(4),
        restorable: before != null,
        rawWrite: hex, rawRestore: before,
      });
      alert(`✓ written (${resp}). Backed up to the Backups screen.`);
    } catch (e) {
      alert('✗ ' + e.message);
    } finally {
      ctx.poller.resume();
    }
  }
}
