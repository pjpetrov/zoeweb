/*
 * ZoeWeb — the polling scheduler (CanZE's Device.queryNextFilter equivalent).
 * Screens subscribe field SIDs with an interval; the poller groups them into
 * jobs (one CAN free frame, or one ISO-TP request) and rotates through them.
 */

export class Poller {
  constructor(db, elm) {
    this.db = db;
    this.elm = elm;
    this.jobs = new Map();       // key → { type, key, dueAt, interval, owners:Map(owner→interval), ... }
    this.virtuals = new Map();   // sid → VirtualField
    this.running = false;
    this.paused = 0;
    this.onError = () => {};
    this.onActivity = () => {};
    this._loopPromise = null;
  }

  registerVirtual(vf) { this.virtuals.set(vf.sid, vf); }

  getField(sid) { return this.virtuals.get(sid) || this.db.registry.getBySid(sid); }

  /** Subscribe a sid for an owner (screen). interval 0 = as fast as possible. */
  subscribe(sid, intervalMs, owner) {
    const vf = this.virtuals.get(sid);
    if (vf) {
      for (const dep of vf.deps) this.subscribe(dep, intervalMs, owner + '#' + sid);
      for (const dep of vf.deps) {
        const f = this.db.registry.getBySid(dep);
        if (f) {
          const handler = () => vf.recompute(s => {
            const fld = this.db.registry.getBySid(s);
            return fld && typeof fld.value === 'number' ? fld.value : NaN;
          });
          handler._vfOwner = owner + '#' + sid;
          f.listeners.add(handler);
        }
      }
      return;
    }
    const field = this.db.registry.getBySid(sid);
    if (!field) { console.warn('unknown sid', sid); return; }
    const key = field.isIsoTp
      ? `d:${field.frameIdHex}.${field.requestId}`
      : `f:${field.frameIdHex}`;
    let job = this.jobs.get(key);
    if (!job) {
      job = field.isIsoTp
        ? { type: 'diag', key, frameIdHex: field.frameIdHex, requestId: field.requestId, responseId: field.responseId }
        : { type: 'free', key, frameIdHex: field.frameIdHex };
      job.owners = new Map();
      job.dueAt = 0;
      job.errors = 0;
      this.jobs.set(key, job);
    }
    job.owners.set(owner + ':' + sid, Math.max(intervalMs, 0));
    job.interval = Math.min(...job.owners.values());
  }

  /** Remove every subscription (and virtual-field listener) of an owner. */
  clearOwner(owner) {
    for (const [key, job] of this.jobs) {
      for (const o of [...job.owners.keys()]) {
        if (o.startsWith(owner + ':') || o.startsWith(owner + '#')) job.owners.delete(o);
      }
      if (job.owners.size === 0) this.jobs.delete(key);
      else job.interval = Math.min(...job.owners.values());
    }
    for (const f of this.db.registry.all) {
      for (const l of [...f.listeners]) {
        if (l._vfOwner && (l._vfOwner.startsWith(owner + '#'))) f.listeners.delete(l);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loopPromise = this._loop();
  }

  async stop() {
    this.running = false;
    await this._loopPromise;
  }

  /** Suspend polling (e.g. while the DTC screen owns the bus). */
  async pause() {
    this.paused++;
    await this._idle;
  }
  resume() { this.paused = Math.max(0, this.paused - 1); }

  async _loop() {
    while (this.running) {
      if (this.paused || this.jobs.size === 0) {
        await sleep(120);
        continue;
      }
      const now = Date.now();
      let best = null;
      for (const job of this.jobs.values()) {
        if (job.dueAt <= now && (!best || job.dueAt < best.dueAt)) best = job;
      }
      if (!best) { await sleep(30); continue; }

      this._idle = this._runJob(best);
      await this._idle;
    }
  }

  async _runJob(job) {
    try {
      if (job.type === 'free') {
        const hex = await this.elm.requestFreeFrame(job.frameIdHex);
        this._decode(hex, this.db.registry.fieldsForFreeFrame(job.frameIdHex));
      } else {
        const ecu = this.db.ecuByFromId(job.frameIdHex) || {
          fromIdHex: job.frameIdHex, toIdHex: this._guessToId(job.frameIdHex),
          isExtended: job.frameIdHex.length > 3,
        };
        const payload = await this.elm.requestIsoTp(ecu, job.requestId);
        this._decode(payload, this.db.registry.fieldsForResponse(job.frameIdHex, job.responseId));
      }
      job.errors = 0;
      this.onActivity(job);
    } catch (e) {
      job.errors++;
      this.onError(job, e);
    }
    // back off after repeated failures so one dead frame doesn't hog the bus
    const backoff = job.errors ? Math.min(job.errors * 2000, 20000) : 0;
    job.dueAt = Date.now() + Math.max(job.interval, 80) + backoff;
  }

  _guessToId(fromIdHex) {
    // 7xx diag pairs usually differ by 0x20 (7ec→7cc is NOT the rule; use ecu table when possible)
    const id = parseInt(fromIdHex, 16);
    return (id - 0x20).toString(16);
  }

  _decode(hexPayload, fields) {
    if (!fields.length) return;
    let bin = '';
    for (const c of hexPayload) bin += parseInt(c, 16).toString(2).padStart(4, '0');
    for (const f of fields) f.decodeFromBinaryString(bin);
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
