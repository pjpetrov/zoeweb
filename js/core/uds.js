/*
 * ZoeWeb — UDS (ISO 14229) helper operations on top of the ELM327 driver.
 * Read/clear DTCs, diagnostic sessions, and raw requests for the Pro console.
 */

export const DTC_STATUS_BITS = [
  'test failed', 'failed this cycle', 'pending', 'confirmed',
  'not completed since clear', 'failed since clear', 'not completed this cycle', 'warning light',
];

export function decodeDtcStatus(status) {
  const out = [];
  for (let i = 0; i < 8; i++) if (status & (1 << i)) out.push(DTC_STATUS_BITS[i]);
  return out;
}

export class Uds {
  constructor(elm) { this.elm = elm; }

  /** Open the diagnostic session the ECU expects (e.g. 10c0 / 1003). */
  async startSession(ecu) {
    return this.elm.requestIsoTp(ecu, ecu.sessionRequestId || '10c0');
  }

  async testerPresent(ecu) {
    return this.elm.requestIsoTp(ecu, '3e00').catch(() => {});
  }

  /**
   * Read DTCs (service 19 02). Returns [{code, failureType, status, name, typeName, statusText}].
   */
  async readDtcs(ecu) {
    await this.startSession(ecu).catch(() => {}); // many ECUs answer without a session
    const respId = ecu.dtcResponseIds[0] || '5902ff';
    const mask = respId.length >= 6 ? respId.substring(4, 6) : 'ff';
    const payload = await this.elm.requestIsoTp(ecu, '1902' + mask, { timeout: 5000 });
    if (!payload.startsWith('5902')) throw new Error('unexpected DTC answer: ' + payload.substring(0, 12));
    const dtcs = [];
    for (let i = 6; i + 8 <= payload.length; i += 8) {
      const code = payload.substring(i, i + 4).toUpperCase();
      const failureType = payload.substring(i + 4, i + 6).toUpperCase();
      const status = parseInt(payload.substring(i + 6, i + 8), 16);
      if (code === '0000' || status === 0) continue;
      dtcs.push({
        code, failureType, status,
        // bits 0/1/2/3/5 = failed now / failed this cycle / pending / confirmed / failed since clear.
        // Status with only "test not completed" bits (0x50) is NOT a fault — the self-test simply
        // hasn't run yet; Renault ECUs list every supported test this way.
        active: (status & 0x2f) !== 0,
        name: ecu.dtcs.get(code) || 'Unknown DTC',
        typeName: ecu.tests.get(failureType) || '',
        statusText: decodeDtcStatus(status).join(', '),
      });
    }
    return dtcs;
  }

  /** Clear ALL stored DTCs of one ECU (service 14 FFFFFF). */
  async clearDtcs(ecu) {
    await this.startSession(ecu).catch(() => {});
    const payload = await this.elm.requestIsoTp(ecu, '14ffffff', { timeout: 5000 });
    if (!payload.startsWith('54')) throw new Error('clear rejected: ' + payload.substring(0, 12));
    return true;
  }

  /** Raw UDS request, hex in → hex out. The Pro console uses this. */
  async raw(ecu, requestHex, timeout = 5000) {
    return this.elm.requestIsoTp(ecu, requestHex.replace(/\s+/g, '').toLowerCase(), { timeout });
  }

  /** ReadDataByIdentifier (22 xxxx) convenience. */
  async readDid(ecu, did) {
    const p = await this.raw(ecu, '22' + did);
    return p.substring(6); // strip 62 + did
  }

  /** WriteDataByIdentifier (2E xxxx <data>) — used by the guarded parameter writer. */
  async writeDid(ecu, did, dataHex) {
    const p = await this.raw(ecu, '2e' + did + dataHex);
    if (!p.startsWith('6e')) throw new Error('write rejected: ' + p.substring(0, 12));
    return true;
  }

  /** RoutineControl (31 01/02/03 xxxx ...) — actuator tests, resets. */
  async routine(ecu, sub, routineId, dataHex = '') {
    return this.raw(ecu, '31' + sub + routineId + dataHex);
  }
}
