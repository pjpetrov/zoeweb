/*
 * ZoeWeb — Expert (DDT4All) page. Loads DDT4All ECU definitions (individual
 * .json files or a whole ecu.zip) and renders their parameters with a clean UI:
 * a searchable ECU picker, decoded reads, and guarded/journaled writes.
 *
 * No proprietary database is shipped — the user loads their own files.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';
import { parseDdt } from '../core/ddt.js';
import { listZip, extractText } from '../core/unzip.js';

const STORE = 'zoe.ddt.files.v1';

// predefined ECU-type filters — each matches any of its name substrings
const CATEGORIES = [
  ['Battery / BMS', ['bms', 'lbc', 'batt']],
  ['BCM / body', ['bcm', 'uch']],
  ['EVC / VCM', ['evc', 'hcm', 'vcm']],
  ['TCU / telematics', ['tcu', 'dcm']],
  ['Cluster', ['tdb', 'cluster', 'miu']],
  ['ABS / ESC', ['abs', 'esc', 'esp', 'vdc']],
  ['Charger', ['bcb', 'obc', 'charg', 'chameleon']],
  ['Motor / inverter', ['peb', 'inv', 'invme', 'invhsg']],
  ['Airbag / SRS', ['acu', 'airbag', 'aibag', 'srs']],
  ['Steering', ['dae', 'eps', 'pas']],
  ['Climate', ['clim', 'hvac']],
  ['Park assist', ['upa', 'sonar', 'park', 'apb']],
  ['Nav / R-Link', ['mfd', 'rlink', 'r-link', 'nav', 'radio', 'media', 'itm']],
  ['Gateway', ['s-gw', 'gateway', 'plc', 'plgw', 'gw3']],
  ['Lights / USM', ['usm', 'upc', 'light']],
  ['TPMS', ['tpms', 'sspp', 'ssp']],
];

export class ExpertScreen extends Screen {
  constructor() {
    super('expert', 'Expert (DDT)', '🧩');
    this.ecus = new Map();   // name → DdtEcu (individually loaded, persisted)
    this.zip = null;         // { buf, entries } (session only)
    this.cache = new Map();  // zip entry name → DdtEcu
    this.selected = null;
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
    } catch (_) { /* too big — memory only */ }
  }

  /** Unified, alphabetically-sorted list of available ECUs (lazy for zip). */
  _index() {
    const items = [];
    for (const [name, ecu] of this.ecus) items.push({ label: name, get: async () => ecu });
    if (this.zip) {
      for (const en of this.zip.entries) {
        const label = en.name.split('/').pop().replace(/\.json$/i, '');
        items.push({ label, get: () => this._fromZip(en) });
      }
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }

  async _fromZip(en) {
    if (this.cache.has(en.name)) return this.cache.get(en.name);
    const text = await extractText(this.zip.buf, en);
    const ecu = parseDdt(text, en.name.split('/').pop());
    this.cache.set(en.name, ecu);
    return ecu;
  }

  render(c, ctx) {
    const status = el('div', { class: 'hint' }, '');
    const listBox = el('div', { class: 'picker-list' });
    const body = el('div', {});

    // --- loaders ---
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
        refreshList();
      } });
    const zipInput = el('input', { type: 'file', accept: '.zip', style: 'display:none',
      onchange: async e => {
        const file = e.target.files[0];
        if (file) {
          status.textContent = 'Reading zip…';
          try {
            const buf = await file.arrayBuffer();
            const entries = listZip(buf).filter(en => /\.json$/i.test(en.name));
            this.zip = { buf, entries };
            this.cache.clear();
            status.textContent = `Loaded ${entries.length} ECU definitions from the zip.`;
          } catch (err) { status.textContent = '✗ ' + err.message; }
          refreshList();
        }
        zipInput.value = '';
      } });

    const search = el('input', { class: 'input', type: 'search', placeholder: 'type to filter ECUs…',
      oninput: () => { clearTimeout(this._deb); this._deb = setTimeout(refreshList, 150); } });

    // category chip row
    let activeCat = null; // array of substrings, or null for all
    const chipRow = el('div', { class: 'toolbar' });
    const chips = [];
    const allChip = el('button', { class: 'cat-chip sel', onclick: () => setCat(null, allChip) }, 'All');
    chipRow.append(allChip);
    for (const [label, pats] of CATEGORIES) {
      const chip = el('button', { class: 'cat-chip', onclick: () => setCat(pats, chip) }, label);
      chips.push(chip);
      chipRow.append(chip);
    }
    function setCat(pats, chipEl) {
      activeCat = pats;
      [allChip, ...chips].forEach(c => c.classList.remove('sel'));
      chipEl.classList.add('sel');
      refreshList();
    }

    const self = this;
    function refreshList() {
      const idx = self._index();
      const q = search.value.trim().toLowerCase();
      let filtered = activeCat
        ? idx.filter(i => activeCat.some(p => i.label.toLowerCase().includes(p)))
        : idx;
      if (q) filtered = filtered.filter(i => i.label.toLowerCase().includes(q));
      listBox.replaceChildren();
      if (!idx.length) {
        status.textContent = 'No ECU definitions loaded.';
        listBox.append(el('p', { class: 'hint' },
          'Load your DDT4All database: "Load database .zip" reads the whole ecu.zip, or load individual .json ' +
          'files. Then filter and pick an ECU here. No proprietary data is bundled in the app.'));
        body.replaceChildren();
        return;
      }
      status.textContent = `${idx.length} ECU definition(s) loaded — ${filtered.length} shown.`;
      for (const item of filtered.slice(0, 800)) {
        const row = el('button', { class: 'picker-row', onclick: async () => {
          [...listBox.children].forEach(ch => ch.classList?.remove('sel'));
          row.classList.add('sel');
          body.replaceChildren(el('p', { class: 'hint' }, 'loading…'));
          try { self.selected = await item.get(); self._renderEcu(ctx, self.selected, body); }
          catch (e) { body.replaceChildren(el('p', { class: 'hint' }, '✗ ' + e.message)); }
        } }, item.label);
        listBox.append(row);
      }
      if (filtered.length > 800) listBox.append(el('div', { class: 'hint' }, `…and ${filtered.length - 800} more — refine the filter`));
    }

    c.append(
      section('DDT4All ECU definitions',
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn', onclick: () => zipInput.click() }, 'Load database .zip…'),
          el('button', { class: 'btn', onclick: () => fileInput.click() }, 'Load .json file(s)…'),
          el('button', { class: 'btn', onclick: () => {
            if (!confirm('Forget all loaded ECU definitions? (Your files are not deleted.)')) return;
            this.ecus.clear(); this.zip = null; this.cache.clear(); localStorage.removeItem(STORE);
            body.replaceChildren(); refreshList();
          } }, 'Clear loaded'),
          fileInput, zipInput),
        status,
        el('div', { class: 'warnbox' },
          '⚠️ Expert mode drives raw ECU requests from your DDT files. Reads are safe; writes change ECU ' +
          'configuration and are executed as defined — every write is backed up to the Backups screen. ' +
          'Car stationary, ignition on. Know what a parameter does before writing it.'),
        chipRow,
        search,
        listBox),
      body,
    );
    refreshList();
    // deep-link: ?ecu=<phrase> auto-selects the first matching ECU
    const pre = new URLSearchParams(location.search).get('ecu');
    if (pre) {
      const row = [...listBox.children].find(r => r.textContent?.toLowerCase().includes(pre.toLowerCase()));
      row?.click();
    }
  }

  _renderEcu(ctx, ecu, body) {
    body.replaceChildren(
      el('p', { class: 'hint mono' },
        `${ecu.name} — request id ${ecu.toIdHex} → response ${ecu.fromIdHex} (${ecu.protocol}); ` +
        `${ecu.reads().length} readable, ${ecu.writes().length} writable parameters.`),
      this._sessionBar(ctx, ecu),
      this._reads(ctx, ecu),
      this._writes(ctx, ecu),
    );
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

  _reads(ctx, ecu) {
    const box = section('Read parameters');
    const results = el('div', {});
    const search = el('input', { class: 'input', type: 'search', placeholder: 'filter parameters…' });
    const table = el('table', { class: 'table' });
    const build = () => {
      const q = search.value.trim().toLowerCase();
      const list = ecu.reads().filter(r => !q || r.name.toLowerCase().includes(q));
      table.replaceChildren();
      for (const req of list.slice(0, 400)) {
        const btn = el('button', { class: 'btn', style: 'padding:4px 10px', onclick: () => this._read(ctx, ecu, req, results) }, 'Read');
        table.append(el('tr', {}, el('td', {}, req.name), el('td', { class: 'mono hint' }, req.sentbytes), el('td', {}, btn)));
      }
    };
    search.oninput = build;
    box.append(el('div', { class: 'toolbar' }, search), results, el('div', { class: 'scroll-x' }, table));
    build();
    return box;
  }

  async _read(ctx, ecu, req, results) {
    if (!ctx.elm.initialized) { results.prepend(el('p', { class: 'hint' }, 'connect to the car first')); return; }
    await ctx.poller.pause();
    try {
      const payload = await ctx.uds.raw(ecu.handle(), req.sentbytes, { timeout: 4000 });
      const items = ecu.decode(req, payload);
      const card = el('div', { class: 'card' }, el('h3', {}, req.name));
      const t = el('table', { class: 'table' });
      for (const it of items) {
        t.append(el('tr', {}, el('td', {}, it.comment || it.name), el('td', { class: 'mono' }, `${it.value} ${it.unit}`.trim())));
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

  _writes(ctx, ecu) {
    const box = section('Write parameters');
    const search = el('input', { class: 'input', type: 'search', placeholder: 'filter parameters…' });
    const table = el('table', { class: 'table' });
    const build = () => {
      const q = search.value.trim().toLowerCase();
      const list = ecu.writes().filter(r => !q || r.name.toLowerCase().includes(q));
      table.replaceChildren();
      for (const req of list.slice(0, 400)) {
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
        table.append(el('tr', {}, el('td', {}, req.name), el('td', {}, input), el('td', {}, apply)));
      }
    };
    search.oninput = build;
    box.append(el('div', { class: 'toolbar' }, search), el('div', { class: 'scroll-x' }, table));
    build();
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
        restorable: before != null, rawWrite: hex, rawRestore: before,
      });
      alert(`✓ written (${resp}). Backed up to the Backups screen.`);
    } catch (e) {
      alert('✗ ' + e.message);
    } finally {
      ctx.poller.resume();
    }
  }
}
