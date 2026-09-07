/*
 * ZoeWeb — Diagnostic Trouble Codes screen: read and CLEAR fault codes per ECU.
 * (CanZE only reads DTCs; clearing is a ZoeWeb extension using UDS service 14.)
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';

export class DtcScreen extends Screen {
  constructor() { super('dtc', 'Fault codes', '⚠️'); }

  render(c, ctx) {
    const results = el('div', {});
    const status = el('div', { class: 'hint' }, 'Pick an ECU, then read its stored fault codes.');
    const select = el('select', { class: 'input' });
    for (const ecu of ctx.db.ecus.filter(e => e.addressable && e.mnemonic && e.mnemonic !== '-')) {
      select.append(el('option', { value: ecu.fromIdHex }, `${ecu.name} (${ecu.mnemonic})`));
    }

    const run = (label, fn) => async () => {
      if (!ctx.elm.initialized) { status.textContent = 'Connect to the car first.'; return; }
      await ctx.poller.pause();
      status.textContent = label + '…';
      try { await fn(); } catch (e) { status.textContent = '✗ ' + e.message; }
      finally { ctx.poller.resume(); }
    };

    const ecuOf = () => ctx.db.ecuByFromId(select.value);

    const readBtn = el('button', { class: 'btn', onclick: run('Reading DTCs', async () => {
      const ecu = ecuOf();
      const dtcs = await ctx.uds.readDtcs(ecu);
      results.replaceChildren(this._renderDtcs(ecu, dtcs));
      const n = dtcs.filter(d => d.active).length;
      status.textContent = n ? `${n} actual fault(s) stored in ${ecu.mnemonic}.` : `${ecu.mnemonic}: no actual faults 🎉`;
    }) }, 'Read DTCs');

    const readAllBtn = el('button', { class: 'btn', onclick: run('Scanning all ECUs', async () => {
      results.replaceChildren();
      let total = 0;
      for (const ecu of ctx.db.ecus.filter(e => e.addressable && e.mnemonic && e.mnemonic !== '-')) {
        status.textContent = `Scanning ${ecu.mnemonic}…`;
        try {
          const dtcs = await ctx.uds.readDtcs(ecu);
          const n = dtcs.filter(d => d.active).length;
          total += n;
          if (dtcs.length) results.append(this._renderDtcs(ecu, dtcs));
        } catch (e) {
          results.append(el('p', { class: 'hint' }, `${ecu.mnemonic}: not reachable (${e.message})`));
        }
      }
      status.textContent = `Scan complete — ${total} actual fault(s) across all ECUs.`;
    }) }, 'Scan all ECUs');

    const clearBtn = el('button', { class: 'btn danger', onclick: async () => {
      const ecu = ecuOf();
      if (!confirm(`Clear ALL stored fault codes in ${ecu.name} (${ecu.mnemonic})?\n\n` +
        'Only do this after noting the codes. A fault that is still present will come back.')) return;
      await run('Clearing DTCs', async () => {
        await ctx.uds.clearDtcs(ecu);
        const dtcs = await ctx.uds.readDtcs(ecu).catch(() => []);
        results.replaceChildren(this._renderDtcs(ecu, dtcs));
        const n = dtcs.filter(d => d.active).length;
        status.textContent = `✓ ${ecu.mnemonic} cleared. ${n} actual fault(s) remain (still-present faults reappear).`;
      })();
    } }, 'Clear DTCs ⚠');

    c.append(
      section('Diagnostic trouble codes',
        el('div', { class: 'toolbar' }, select, readBtn, readAllBtn, clearBtn),
        status),
      results,
    );
  }

  _renderDtcs(ecu, dtcs) {
    const box = section(`${ecu.name} (${ecu.mnemonic})`);
    const faults = dtcs.filter(d => d.active);
    const untested = dtcs.filter(d => !d.active);
    if (!faults.length) box.append(el('p', { class: 'hint' }, 'No actual stored faults. 🎉'));
    if (faults.length) {
      const table = el('table', { class: 'table' },
        el('tr', {}, el('th', {}, 'Code'), el('th', {}, 'Description'), el('th', {}, 'Failure type'), el('th', {}, 'Status')));
      for (const d of faults) {
        table.append(el('tr', {},
          el('td', { class: 'mono' }, `DF ${d.code}.${d.failureType}`),
          el('td', {}, d.name),
          el('td', {}, d.typeName),
          el('td', { class: 'hint' }, d.statusText)));
      }
      box.append(el('div', { class: 'scroll-x' }, table));
    }
    if (untested.length) {
      const det = el('details', {},
        el('summary', { class: 'hint' },
          `${untested.length} self-test(s) not yet run — not faults, the ECU just hasn't been through those conditions since the last clear`));
      for (const d of untested) {
        det.append(el('p', { class: 'hint mono' }, `DF ${d.code}.${d.failureType} ${d.name}`));
      }
      box.append(det);
    }
    return box;
  }
}
