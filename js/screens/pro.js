/*
 * ZoeWeb — Pro console. This goes beyond CanZE's read-only philosophy:
 *   - diagnostic session control (default / extended)
 *   - ReadDataByIdentifier browser (service 22)
 *   - guarded WriteDataByIdentifier (service 2E) with read-before-write
 *   - RoutineControl (service 31)
 *   - raw UDS request console with a full traffic log
 *
 * WARNING shown to the user: writing to ECUs can misconfigure or brick them.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';
import { journaledWrite } from '../core/journal.js';

export class ProScreen extends Screen {
  constructor() { super('pro', 'Pro console', '🛠️'); }

  render(c, ctx) {
    const log = el('div', { class: 'console mono' });
    const logLine = (cls, text) => {
      log.append(el('div', { class: cls }, text));
      log.scrollTop = log.scrollHeight;
      while (log.childElementCount > 400) log.firstChild.remove();
    };

    const select = el('select', { class: 'input' });
    for (const ecu of ctx.db.ecus.filter(e => e.addressable && e.mnemonic && e.mnemonic !== '-')) {
      select.append(el('option', { value: ecu.fromIdHex }, `${ecu.name} (${ecu.mnemonic})`));
    }
    const ecuOf = () => ctx.db.ecuByFromId(select.value);

    const exec = async (label, fn) => {
      if (!ctx.elm.initialized) { logLine('err', '! connect to the car first'); return; }
      await ctx.poller.pause();
      try {
        logLine('tx', `> ${label}`);
        const r = await fn();
        if (r !== undefined) logLine('rx', `< ${r}`);
      } catch (e) {
        logLine('err', `! ${e.message}`);
      } finally {
        ctx.poller.resume();
      }
    };

    // --- session control ---
    const sessions = el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: () => exec('start default session', () => ctx.uds.raw(ecuOf(), ctx.db.car.ph2 ? '1001' : '1081')) }, 'Default session'),
      el('button', { class: 'btn', onclick: () => exec('start extended session', () => ctx.uds.startSession(ecuOf())) }, 'Extended session'),
      el('button', { class: 'btn', onclick: () => exec('tester present', () => ctx.uds.raw(ecuOf(), '3e00')) }, 'Tester present'),
    );

    // --- read DID ---
    const didIn = el('input', { class: 'input mono', placeholder: 'DID, e.g. 2006', maxlength: '8' });
    const readRow = el('div', { class: 'toolbar' }, didIn,
      el('button', { class: 'btn', onclick: () => {
        const did = didIn.value.replace(/\s/g, '').toLowerCase();
        if (!/^[0-9a-f]{4}$/.test(did)) { logLine('err', '! DID must be 4 hex digits'); return; }
        exec(`read DID ${did}`, () => ctx.uds.raw(ecuOf(), '22' + did));
      } }, 'Read (22)'));

    // --- guarded write DID ---
    const wDid = el('input', { class: 'input mono', placeholder: 'DID', maxlength: '4' });
    const wData = el('input', { class: 'input mono', placeholder: 'data bytes (hex)', style: 'flex:1' });
    const writeRow = el('div', { class: 'toolbar' }, wDid, wData,
      el('button', { class: 'btn danger', onclick: async () => {
        const ecu = ecuOf();
        const did = wDid.value.replace(/\s/g, '').toLowerCase();
        const data = wData.value.replace(/\s/g, '').toLowerCase();
        if (!/^[0-9a-f]{4}$/.test(did) || !/^([0-9a-f]{2})+$/.test(data)) {
          logLine('err', '! DID must be 4 hex digits and data whole hex bytes'); return;
        }
        // read-before-write so the old value is in the log for rollback
        await exec(`read current value of ${did} (kept in log for rollback)`, () => ctx.uds.raw(ecu, '22' + did).catch(e => `unreadable: ${e.message}`));
        const phrase = ecu.mnemonic.toUpperCase();
        const answer = prompt(
          `⚠️ You are about to WRITE to the ${ecu.name}.\n\n` +
          `Request: 2E ${did} ${data}\n\n` +
          'A wrong write can misconfigure or permanently damage this ECU. Only proceed if you ' +
          'know exactly what this identifier does on your car (e.g. from DDT database documentation).\n\n' +
          `Type ${phrase} to confirm:`);
        if (answer?.trim().toUpperCase() !== phrase) { logLine('err', '! write cancelled'); return; }
        await exec(`WRITE DID ${did} = ${data}`, async () => {
          await ctx.uds.startSession(ecu).catch(() => {});
          const back = await journaledWrite(ctx, ecu, did, data, `Pro console write ${did}`);
          return '6e' + did + ' (backed up → Backups screen); read-back ' + back;
        });
      } }, 'Write (2E) ⚠'));

    // --- routine control ---
    const rId = el('input', { class: 'input mono', placeholder: 'routine id', maxlength: '4' });
    const rData = el('input', { class: 'input mono', placeholder: 'option bytes (hex, optional)' });
    const routineRow = el('div', { class: 'toolbar' }, rId, rData,
      el('button', { class: 'btn danger', onclick: () => {
        const id = rId.value.replace(/\s/g, '').toLowerCase();
        const data = rData.value.replace(/\s/g, '').toLowerCase();
        if (!/^[0-9a-f]{4}$/.test(id)) { logLine('err', '! routine id must be 4 hex digits'); return; }
        if (!confirm(`Start routine ${id} on ${ecuOf().mnemonic}? Routines can actuate hardware (pumps, valves, relays). Car must be stationary and secured.`)) return;
        exec(`routine start ${id}`, async () => {
          await ctx.uds.startSession(ecuOf()).catch(() => {});
          return ctx.uds.raw(ecuOf(), '3101' + id + data);
        });
      } }, 'Start routine (31 01) ⚠'));

    // --- raw console ---
    const rawIn = el('input', { class: 'input mono', placeholder: 'raw UDS request, e.g. 222001 or 21 03', style: 'flex:1',
      onkeydown: e => { if (e.key === 'Enter') sendRaw(); } });
    const sendRaw = () => {
      const req = rawIn.value.replace(/\s/g, '').toLowerCase();
      if (!/^([0-9a-f]{2})+$/.test(req)) { logLine('err', '! request must be whole hex bytes'); return; }
      const svc = req.substring(0, 2);
      if (['2e', '2f', '31', '34', '35', '36', '37', '3d', '85'].includes(svc)
        && !confirm(`Service ${svc.toUpperCase()} modifies the ECU. Send anyway?`)) return;
      exec(`raw ${req}`, () => ctx.uds.raw(ecuOf(), req));
      rawIn.value = '';
    };
    const rawRow = el('div', { class: 'toolbar' }, rawIn, el('button', { class: 'btn', onclick: sendRaw }, 'Send'));

    c.append(
      el('div', { class: 'warnbox' },
        '⚠️ This console can change your car\'s configuration. Reading (service 22/21) is safe; ',
        'writes (2E) and routines (31) are executed exactly as you type them, with no safety net. ',
        'Use only on your own vehicle, stationary, ignition on, charger unplugged — and know your Renault DDT parameter documentation before writing.'),
      section('Target ECU', el('div', { class: 'toolbar' }, select), sessions),
      section('Read data by identifier', readRow),
      section('Write data by identifier', writeRow),
      section('Routine control (actuator tests, resets)', routineRow),
      section('Raw UDS console', rawRow),
      section('Traffic log', log),
    );
    logLine('hint', 'ready — every request and response is logged here');
  }
}
