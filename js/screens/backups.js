/*
 * ZoeWeb — Backups & restore. Lists every parameter write the app has made
 * (persisted across sessions) and restores the original value on demand.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';
import { ecuFromEntry, journaledWrite } from '../core/journal.js';

export class BackupsScreen extends Screen {
  constructor() { super('backups', 'Backups', '💾'); }

  render(c, ctx) {
    const body = el('div', {});
    const status = el('div', { class: 'hint' }, '');

    const rebuild = () => {
      body.replaceChildren();
      const entries = ctx.journal.list();
      if (!entries.length) {
        body.append(el('p', { class: 'hint' },
          'No changes recorded yet. Every parameter the app writes is backed up here automatically, ' +
          'so you can always restore the original value — even after closing the app.'));
        return;
      }
      const table = el('table', { class: 'table' },
        el('tr', {}, el('th', {}, 'When'), el('th', {}, 'ECU'), el('th', {}, 'Setting'),
          el('th', {}, 'Was → Now'), el('th', {}, '')));
      for (const e of entries) {
        const when = new Date(e.ts).toLocaleString();
        const wasNow = `${(e.before ?? '—').toUpperCase()} → ${(e.after ?? '—').toUpperCase()}`;
        const action = el('td', {});
        if (e.restored) {
          action.append(el('span', { class: 'hint' }, '✓ restored'));
        } else if (!e.restorable) {
          action.append(el('span', { class: 'hint' }, 'no backup value'));
        } else {
          action.append(el('button', { class: 'btn', onclick: () => this._restore(ctx, e, status, rebuild) }, 'Restore'));
        }
        table.append(el('tr', {},
          el('td', { class: 'hint' }, when),
          el('td', {}, e.ecuName),
          el('td', {}, e.label + ` (${e.did.toUpperCase()})`),
          el('td', { class: 'mono' }, wasNow),
          action,
          el('td', {}, el('button', { class: 'btn', style: 'padding:4px 8px',
            onclick: () => { ctx.journal.remove(e.id); rebuild(); } }, '✕'))));
      }
      body.append(el('div', { class: 'scroll-x' }, table));
    };

    const off = ctx.journal.onChange(rebuild);
    this._bindings.push({ field: { listeners: { delete() { off(); } } }, listener: null });

    c.append(
      section('Backups & restore',
        el('p', { class: 'hint' },
          'Every write the app makes is recorded here with the value it replaced. ' +
          '"Restore" writes the original value back to the ECU (needs the car connected). ' +
          'The list is kept on this device across sessions.'),
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn', onclick: () => {
            if (confirm('Forget all backup records? This does NOT change the car — it only clears this list, ' +
              'so you lose the ability to restore these values from the app.')) { ctx.journal.clear(); rebuild(); }
          } }, 'Clear list')),
        status),
      body);
    rebuild();
  }

  async _restore(ctx, e, status, rebuild) {
    if (!ctx.elm.initialized) { status.textContent = 'Connect to the car first.'; status.className = 'hint warn'; return; }
    if (!confirm(`Restore ${e.label} on ${e.ecuName} back to ${e.before.toUpperCase()}?`)) return;
    await ctx.poller.pause();
    status.textContent = 'Restoring…'; status.className = 'hint';
    try {
      const ecu = ecuFromEntry(e);
      await ctx.uds.startSession(ecu).catch(() => {});
      if (e.rawRestore) {
        // DDT/expert write — replay the exact original request
        await ctx.uds.raw(ecu, e.rawRestore, { timeout: 5000 });
      } else {
        // route the restore through the journal too, so it is itself undoable
        await journaledWrite(ctx, ecu, e.did, e.before, e.label + ' (restore)');
      }
      ctx.journal.markRestored(e.id);
      status.textContent = `✓ ${e.label} restored to ${e.before.toUpperCase()} — cycle the ignition to apply.`;
      rebuild();
    } catch (err) {
      status.textContent = '✗ restore failed: ' + (err?.message || err);
      status.className = 'hint warn';
    } finally {
      ctx.poller.resume();
    }
  }
}
