/*
 * ZoeWeb — All Data browser (CanZE's AllDataActivity/ResearchActivity):
 * live-query every known field of an ECU, with search.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';

export class AllDataScreen extends Screen {
  constructor() { super('alldata', 'All data', '🔎'); }

  render(c, ctx) {
    const select = el('select', { class: 'input' });
    const ecus = ctx.db.ecus.filter(e => e.addressable && e.mnemonic && e.mnemonic !== '-');
    for (const ecu of ecus) select.append(el('option', { value: ecu.fromIdHex }, `${ecu.name} (${ecu.mnemonic})`));
    const search = el('input', { class: 'input', placeholder: 'filter fields…', type: 'search' });
    const body = el('div', {});
    const status = el('div', { class: 'hint' }, '');

    const build = () => {
      this.unmount(ctx); // drop previous subscriptions
      body.replaceChildren();
      const ecu = ctx.db.ecuByFromId(select.value);
      const filter = search.value.trim().toLowerCase();
      const fields = ctx.db.registry.all.filter(f =>
        f.isIsoTp && f.frameIdHex === ecu.fromIdHex &&
        !/^1[04]|^19|^3e|^2e|^31|^27/.test(f.requestId) && // skip control services
        (!filter || (f.name + f.sid).toLowerCase().includes(filter)));
      status.textContent = `${fields.length} field(s). Values refresh continuously while this screen is open.`;
      const table = el('table', { class: 'table' },
        el('tr', {}, el('th', {}, 'Field'), el('th', {}, 'Value'), el('th', {}, 'Unit'), el('th', {}, 'SID / request')));
      const MAX = 400;
      fields.slice(0, MAX).forEach(f => {
        const td = el('td', { class: 'mono' }, '—');
        table.append(el('tr', {},
          el('td', {}, f.name || f.sid),
          td,
          el('td', {}, f.unit),
          el('td', { class: 'hint mono' }, `${f.sid} ← ${f.requestId}`)));
        this.bind(ctx, f.sid, { update: fl => { td.textContent = fl.format(); } }, 4000);
      });
      if (fields.length > MAX) status.textContent += ` Showing the first ${MAX}; refine the filter.`;
      body.append(el('div', { class: 'scroll-x' }, table));
    };

    select.addEventListener('change', build);
    let deb;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(build, 300); });
    c.append(section('Browse every known field', el('div', { class: 'toolbar' }, select, search), status), body);
    build();
  }
}
