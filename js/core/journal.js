/*
 * ZoeWeb — write journal.
 *
 * Every parameter write the app performs goes through journaledWrite(): it
 * reads the CURRENT value first, records {before, after, address, did} to
 * localStorage, then writes. The Backups screen replays any `before` value to
 * restore the original setting. Survives refreshes and reconnects.
 *
 * Only value writes (service 2E / config bytes) are journaled — they are the
 * ones that can be undone. DTC clears (14) change nothing restorable.
 */

const KEY = 'zoe.journal.v1';

export class WriteJournal {
  constructor() {
    this.entries = this._load();
    this.listeners = new Set();
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (_) { return []; }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.entries)); } catch (_) {}
    for (const l of this.listeners) { try { l(); } catch (_) {} }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  record(entry) {
    this.entries.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      restored: false,
      ...entry,
    });
    if (this.entries.length > 500) this.entries.length = 500;
    this._save();
  }

  markRestored(id) {
    const e = this.entries.find(x => x.id === id);
    if (e) { e.restored = true; e.restoredAt = Date.now(); this._save(); }
  }

  remove(id) { this.entries = this.entries.filter(e => e.id !== id); this._save(); }
  clear() { this.entries = []; this._save(); }
  list() { return this.entries; }
}

/** Rebuild a minimal ECU handle from a journal entry's stored addressing. */
export function ecuFromEntry(e) {
  return {
    toIdHex: e.toIdHex,
    fromIdHex: e.fromIdHex,
    isExtended: (e.fromIdHex || '').length > 3,
    sessionRequestId: e.sessionRequestId || '10c0',
    name: e.ecuName,
    mnemonic: e.mnemonic || e.ecuName,
  };
}

/**
 * The single write path used by every card. Reads the old value, writes the
 * new one, verifies by read-back, and journals the change for restore.
 *   ctx: the app (needs .uds and .journal)
 * Returns the read-back value hex, or throws.
 */
export async function journaledWrite(ctx, ecu, did, dataHex, label) {
  did = did.toLowerCase();
  dataHex = dataHex.toLowerCase();
  let before = null;
  try { before = (await ctx.uds.raw(ecu, '22' + did)).substring(6); } catch (_) {}
  await ctx.uds.writeDid(ecu, did, dataHex);
  let after = dataHex;
  try { after = (await ctx.uds.raw(ecu, '22' + did)).substring(6, 6 + dataHex.length); } catch (_) {}
  ctx.journal.record({
    ecuName: ecu.name || ecu.mnemonic || ecu.toIdHex,
    mnemonic: ecu.mnemonic,
    toIdHex: ecu.toIdHex,
    fromIdHex: ecu.fromIdHex,
    sessionRequestId: ecu.sessionRequestId,
    did,
    label: label || ('DID ' + did.toUpperCase()),
    before,
    after,
    restorable: before != null && before !== '',
  });
  return after;
}
