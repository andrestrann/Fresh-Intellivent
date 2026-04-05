'use strict';

const KeyStore = require('./KeyStore');

const UUID_AUTH = '4cad343a209a40b7b9114d9b3df569b2';
const UUID_DEVICE_STATUS = '528b80e8c47a4c0abdf1916a7748f412';

/**
 * Known GATT service UUIDs for Fresh Intellivent fans.
 * Mapped from successful discoverAllServicesAndCharacteristics() results.
 * Used to avoid the slow 8-second full GATT enumeration that causes
 * the fan to drop the BLE connection (fan timeout ~5s).
 */
const SVC_MODES = 'c119e8580531468196745a11f0e53bb4';   // All mode characteristics
const SVC_STATUS = '1a46a853e5ed4696bac070e346884a26';   // Device status + unknown
const SVC_AUTH = 'e6834e4b7b3a48e691e4f1d005f564d3';     // Auth, device name, etc.

/**
 * Map each characteristic UUID (dashless lowercase) to its parent service UUID.
 * This lets us call peripheral.read(serviceUuid, charUuid) without full discovery.
 */
const CHAR_TO_SERVICE = {
  // Auth service
  '4cad343a209a40b7b9114d9b3df569b2': SVC_AUTH,
  'b85fa07a93824838871c81d045dcc2ff': SVC_AUTH,
  'd1ae6b70ee124f6db166d2063dcaffe1': SVC_AUTH,
  '638ff62c38234e0f81791695c46ee8af': SVC_AUTH,
  // Status service
  '528b80e8c47a4c0abdf1916a7748f412': SVC_STATUS,
  '25a824ad30214de99f2f60cf8d17bded': SVC_STATUS,
  // Mode service (all 7c4adc01..0e)
  '7c4adc012f3311e793ae92361f002671': SVC_MODES,
  '7c4adc022f3311e793ae92361f002671': SVC_MODES,
  '7c4adc032f3311e793ae92361f002671': SVC_MODES,
  '7c4adc042f3311e793ae92361f002671': SVC_MODES,
  '7c4adc052f3311e793ae92361f002671': SVC_MODES,
  '7c4adc062f3311e793ae92361f002671': SVC_MODES,
  '7c4adc072f3311e793ae92361f002671': SVC_MODES,
  '7c4adc082f3311e793ae92361f002671': SVC_MODES,
  '7c4adc092f3311e793ae92361f002671': SVC_MODES,
  '7c4adc0a2f3311e793ae92361f002671': SVC_MODES,
  '7c4adc0b2f3311e793ae92361f002671': SVC_MODES,
  '7c4adc0c2f3311e793ae92361f002671': SVC_MODES,
  '7c4adc0d2f3311e793ae92361f002671': SVC_MODES,
  '7c4adc0e2f3311e793ae92361f002671': SVC_MODES,
};

/**
 * ConnectionManager — manages BLE connections to Fresh Intellivent fans.
 *
 * Uses peripheral.read(serviceUuid, charUuid) / peripheral.write(serviceUuid, charUuid, data)
 * shorthand to avoid slow full GATT enumeration. The fan disconnects after ~5s but full
 * discovery takes ~8s, causing consistent failures.
 *
 * Connection strategy:
 *   - Prefers Strategy A (find-only) which is consistently most reliable
 *   - Interleaves B (discover+wait) and C (discover+find) to refresh BLE cache
 *   - Uses gentle linear backoff (2s, 3s, 3s, 4s, 5s, 5s...) to avoid long waits
 *   - 8 max attempts per connect cycle for better success rate
 *   - 3s BLE radio settle before every connect
 */
class ConnectionManager {
  constructor(homey, peripheralId, keyId, options = {}) {
    this.homey = homey;
    this.peripheralId = peripheralId;
    this.keyId = keyId || peripheralId;
    this.options = {
      retryEnabled: options.retryEnabled !== false,
      maxConnectAttempts: Number.isInteger(options.maxConnectAttempts) ? options.maxConnectAttempts : 0,
      skipAuth: options.skipAuth === true, // Skip authentication on connect (for auth capture flow)
    };
    this.peripheral = null;
    this.isConnected = false;
    this.connectPromise = null;
    this.keyStore = new KeyStore(homey);
    this._lastDisconnectTime = 0; // Track last disconnect to enforce cooldown
    this._lastAuthTime = 0;       // Track when we last authenticated
    // this._authMaxAge = 8000;      // Re-auth if last auth was more than 8s ago ** OLD CODE **
    this._authMaxAge = 4000; // ** NEW CODE ** Re-auth if last auth was more than 4s ago. Prevents write not permitted errors
    this._idleTimer = null;       // Auto-disconnect after idle period
    this._idleTimeout = 30000;    // Keep connection alive for 30s after last activity
    this._discoveredServices = null; // Cache for GATT discovery (needed for writes)
  }

  /**
   * Reset the idle timer. Called after each successful read/write.
   * After _idleTimeout ms of no activity, auto-disconnects.
   */

  /** NEW CODE **/
  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._idleTimer = setTimeout(async () => {
      if (this.isConnected) await this.disconnect();
    }, this._idleTimeout);
  }

  /** OLD CODE **/
  //_resetIdleTimer() {
  //  if (this._idleTimer) clearTimeout(this._idleTimer);
  //  this._idleTimer = setTimeout(async () => {
  //    if (this.isConnected) {
  //      this.homey.log('[ConnectionManager] Idle timeout — auto-disconnecting');
  //      await this.disconnect();
  //    }
  //  }, this._idleTimeout);
  //}

  normalizeBleId(value) {
    return String(value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
  }

  normalizeUuid(uuid) {
    return String(uuid || '').replace(/-/g, '').toLowerCase();
  }

  logAdvertisement(label, adv) {
    this.homey.log(
      `[ConnectionManager] ${label}: uuid=${adv?.uuid} addr=${adv?.address} ` +
      `name=${adv?.localName || '?'} connectable=${adv?.connectable} ` +
      `addressType=${adv?.addressType || '?'} rssi=${adv?.rssi ?? '?'} ` +
      `serviceUuids=${JSON.stringify(adv?.serviceUuids || [])}`
    );
  }

  findMatchingAdvertisement(devices) {
    const arr = Array.isArray(devices) ? devices : Object.values(devices);
    const target = this.normalizeBleId(this.keyId || this.peripheralId);

    if (target) {
      for (const device of arr) {
        const addr = this.normalizeBleId(device?.address);
        const uuid = this.normalizeBleId(device?.uuid);
        if (addr === target || uuid === target) return device;
      }
    }

    for (const device of arr) {
      const name = String(device?.localName || device?.name || '');
      if (name === 'Intellivent SKY' || name === 'Intellivent ICE') return device;
    }

    return null;
  }

  /**
   * Connect to the fan's BLE GATT server.
   * Rotates through strategies with A (find-only) preferred:
   *   A, B, A, C, A, B, A, C
   * After connect, authenticates immediately using peripheral.write() shorthand
   * — NO full GATT discovery (too slow, fan drops connection after ~5s).
   */
  async connect() {
    if (this.isConnected && this.peripheral) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _doConnect() {
    let attempts = 0;
    const maxAttempts = this.options.maxConnectAttempts > 0
      ? this.options.maxConnectAttempts
      : 8;

    // Strategy rotation: favor A (find-only), interleave B and C to refresh caches
    const strategyOrder = ['A', 'B', 'A', 'C', 'A', 'B', 'A', 'C'];
    // Gentle linear backoff: 2, 3, 3, 4, 5, 5, 5, 5 seconds
    const backoffs = [2000, 3000, 3000, 4000, 5000, 5000, 5000, 5000];

    // Enforce a cooldown period after the last disconnect to let BLE radio recover
    const cooldownMs = 5000;
    const sinceDisconnect = Date.now() - this._lastDisconnectTime;
    if (this._lastDisconnectTime > 0 && sinceDisconnect < cooldownMs) {
      const wait = cooldownMs - sinceDisconnect;
      this.homey.log(`[ConnectionManager] BLE cooldown: waiting ${wait}ms before reconnect`);
      await new Promise(r => setTimeout(r, wait));
    }

    while (true) {
      attempts += 1;
      const strategyKey = strategyOrder[(attempts - 1) % strategyOrder.length];

      try {
        this.homey.log(`[ConnectionManager] attempt ${attempts}/${maxAttempts} strategy=${strategyKey} for ${this.peripheralId}`);

        let advertisement = null;

        if (strategyKey === 'A') {
          // Strategy A: find-only — most reliable for locating the fan
          advertisement = await this.homey.ble.find(this.peripheralId);
          this.logAdvertisement('Strategy A (find)', advertisement);
        }
        else if (strategyKey === 'B') {
          // Strategy B: discover all, then pick our fan from results
          // const devices = await this.homey.ble.discover(); ** OLD CODE **
          const devices = await this.homey.ble.discover({ timeout: 3000 }); // ** NEW CODE **
          const arr = Array.isArray(devices) ? devices : Object.values(devices);
          this.homey.log(`[ConnectionManager] discover() found ${arr.length} BLE devices`);
          advertisement = this.findMatchingAdvertisement(devices);
          if (!advertisement) throw new Error('Target fan not found in discover results');
          this.logAdvertisement('Strategy B (discover)', advertisement);
        }
        else {
          // Strategy C: discover to refresh cache, then find by ID
          await this.homey.ble.discover().catch(() => null);
          this.homey.log('[ConnectionManager] Cache refreshed, waiting 2s...');
          await new Promise(r => setTimeout(r, 2000));
          advertisement = await this.homey.ble.find(this.peripheralId);
          this.logAdvertisement('Strategy C (discover+find)', advertisement);
        }

        if (!advertisement) throw new Error(`No advertisement found for ${this.peripheralId}`);

        // Wait for BLE radio to settle before connecting (critical for stability)
        this.homey.log('[ConnectionManager] Waiting 3s for BLE radio settle...');
         await new Promise(r => setTimeout(r, 3000)); //**OLD CODE**
        //await this.homey.ble.idle();  // **NEW CODE ** use built-in BLE settle on Homey

        const t0 = Date.now();
        this.homey.log('[ConnectionManager] Calling advertisement.connect()...');
        const peripheral = await advertisement.connect();
        this.homey.log(`[ConnectionManager] connect() took ${Date.now() - t0}ms`);
        this.peripheral = peripheral;
        this.isConnected = true;
        this.homey.log('[ConnectionManager] Connected!');

        // Authenticate immediately — unless skipAuth is set (auth capture flow)
        if (!this.options.skipAuth) {
          await this._authenticate();
        } else {
          this.homey.log('[ConnectionManager] skipAuth — skipping authentication');
        }

        // Start idle timer — auto-disconnect after 30s of no activity
        this._resetIdleTimer();

        // Listen for unexpected disconnects
        if (typeof peripheral.once === 'function') {
          peripheral.once('disconnect', () => {
            this.homey.log('[ConnectionManager] Peripheral disconnected (event)');
            this.isConnected = false;
            this.peripheral = null;
            this._discoveredServices = null;
            this._lastDisconnectTime = Date.now();
          });
        }

        return;

      } catch (err) {
        this.isConnected = false;
        this.peripheral = null;

        const msg = String(err?.message || err || 'Unknown error');
        this.homey.error(`[ConnectionManager] attempt ${attempts} failed: ${msg}`);

        if (this.options.retryEnabled === false || attempts >= maxAttempts) throw err;

        const delay = backoffs[Math.min(attempts - 1, backoffs.length - 1)];
        this.homey.log(`[ConnectionManager] retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * Authenticate using peripheral.write() shorthand with known service UUID.
   * After writing the auth code, verifies authentication by reading DEVICE_STATUS byte 7.
   * If auth fails, tries to re-capture the auth code (fan must be in pairing mode).
   */
  async _authenticate() {
    this.isAuthenticated = false;

    const keyData = await this.keyStore.load(this.keyId);
    if (!keyData || !keyData.code) {
      this.homey.log(`[ConnectionManager] No auth code stored for ${this.keyId} — attempting to capture from fan`);
      await this._captureAndAuth();
      return;
    }

    this.homey.log(`[ConnectionManager] Stored auth code for ${this.keyId}: ${keyData.code}`);
    await this._writeAuthCode(keyData.code);
  }

  /**
   * Write an auth code (hex string) to the AUTH characteristic, verify, handle failure.
   */
  async _writeAuthCode(hexCode) {
    const codeBuffer = Buffer.from(hexCode, 'hex');
    this.homey.log(`[ConnectionManager] Authenticating with ${codeBuffer.length}-byte code...`);

    try {
      await this.peripheral.write(SVC_AUTH, UUID_AUTH, codeBuffer);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      this.homey.error(`[ConnectionManager] Auth write failed: ${err.message}`);
      return;
    }

    // Verify auth by reading DEVICE_STATUS byte 7
    const verified = await this._verifyAuth();
    if (verified) {
      this.homey.log('[ConnectionManager] Authenticated ✓ (verified)');
      this.isAuthenticated = true;
      this._lastAuthTime = Date.now();
      return;
    }

    // Auth failed with stored code — try to re-capture (fan might be in pairing mode)
    this.homey.log('[ConnectionManager] Auth verification failed — stored code may be incorrect');
    this.homey.log('[ConnectionManager] Attempting to re-capture auth code from fan...');
    await this._captureAndAuth();
  }

  /**
   * Re-authenticate if auth has expired (session timeout).
   * The fan de-authenticates after ~10-20s of idle, so we must
   * re-send the auth code before writes.
   */
  async _ensureAuth() {
    if (!this.isConnected || !this.peripheral) return;

    const age = Date.now() - this._lastAuthTime;
    if (this.isAuthenticated && age < this._authMaxAge) {
      return; // Auth is still fresh
    }

    this.homey.log(`[ConnectionManager] Re-authenticating (auth age: ${Math.round(age / 1000)}s)...`);
    const keyData = await this.keyStore.load(this.keyId);
    if (!keyData || !keyData.code) {
      this.homey.log('[ConnectionManager] No auth code available for re-auth');
      return;
    }

    const codeBuffer = Buffer.from(keyData.code, 'hex');
    try {
      await this.peripheral.write(SVC_AUTH, UUID_AUTH, codeBuffer);
      await new Promise(r => setTimeout(r, 500));
      this._lastAuthTime = Date.now();
      this.isAuthenticated = true;
      this.homey.log('[ConnectionManager] Re-authenticated ✓');
    } catch (err) {
      this.homey.error(`[ConnectionManager] Re-auth write failed: ${err.message}`);
    }
  }

  /**
   * Verify authentication by reading DEVICE_STATUS and checking byte 7 (authenticated flag).
   */
  async _verifyAuth() {
    try {
      const status = await this.peripheral.read(SVC_STATUS, UUID_DEVICE_STATUS);
      if (status.length >= 8) {
        const authFlag = status.readUInt8(7);
        this.homey.log(`[ConnectionManager] Auth verify: DEVICE_STATUS byte 7 = ${authFlag}`);
        return authFlag !== 0;
      }
    } catch (err) {
      this.homey.error(`[ConnectionManager] Auth verify read failed: ${err.message}`);
    }
    return false;
  }

  /**
   * Try to read the auth code from the fan (works when fan is in pairing mode),
   * store it, and authenticate with it.
   * IMPORTANT: Only overwrites the stored code if the new code actually verifies.
   */
  async _captureAndAuth() {
    try {
      const authData = await this.peripheral.read(SVC_AUTH, UUID_AUTH);
      if (!authData || authData.length === 0) {
        this.homey.log('[ConnectionManager] AUTH characteristic returned empty data — fan may not be in pairing mode');
        return;
      }

      const newCode = authData.toString('hex');
      this.homey.log(`[ConnectionManager] Read auth code from fan: ${authData.length} bytes (${newCode})`);

      // Check if it's all zeros — fan is not in pairing mode
      if (newCode === '00000000' || newCode === '0000000000000000') {
        this.homey.log('[ConnectionManager] Auth code is all zeros — fan is NOT in pairing mode');
        return;
      }

      // Write it back to authenticate
      await this.peripheral.write(SVC_AUTH, UUID_AUTH, authData);
      await new Promise(r => setTimeout(r, 1000));

      // Verify — only save if it actually works
      const verified = await this._verifyAuth();
      if (verified) {
        // Only now save the new code — it's verified working
        await this.keyStore.save(this.keyId, { code: newCode });
        this.homey.log(`[ConnectionManager] Authenticated ✓ (new code captured, verified, and saved for ${this.keyId})`);
        this.isAuthenticated = true;
        this._lastAuthTime = Date.now();
      } else {
        // Don't save — the code didn't work, keep the old one
        this.homey.log('[ConnectionManager] Captured code did not verify — NOT saving. Put fan in pairing mode (hold button ~8s) and try again.');
      }
    } catch (err) {
      this.homey.error(`[ConnectionManager] Auth capture failed: ${err.message}`);
    }
  }

  async disconnect() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    try {
      if (this.peripheral && typeof this.peripheral.disconnect === 'function') {
        await this.peripheral.disconnect();
      }
    } catch (_) { /* ignore */ } //changed from _ to 'err'
    this.isConnected = false;
    this.peripheral = null;
    this.connectPromise = null;
    this._discoveredServices = null;
    this._lastDisconnectTime = Date.now();
  }

  /**
   * Read a BLE characteristic by UUID using peripheral.read() shorthand.
   * Uses CHAR_TO_SERVICE map to find the correct service UUID — no full GATT discovery needed.
   */
  async readCharacteristic(uuid) {
    await this.connect();
    if (!this.peripheral) throw new Error('No connected peripheral');

    const charUuid = this.normalizeUuid(uuid);
    const serviceUuid = CHAR_TO_SERVICE[charUuid];

    if (!serviceUuid) {
      throw new Error(`Unknown characteristic ${uuid} — not in service map`);
    }

    try {
      const buf = await this.peripheral.read(serviceUuid, charUuid);
      this.homey.log(`[ConnectionManager] Read ${charUuid.substring(0,8)}… → ${buf.length} bytes: ${buf.toString('hex')}`);
      this._resetIdleTimer();
      return buf;
    } catch (err) {
      this.homey.error(`[ConnectionManager] Read error (${charUuid.substring(0,8)}…): ${err.message}`);
      // Mark connection as dead so next operation reconnects
      this.isConnected = false;
      this.peripheral = null;
      this._lastDisconnectTime = Date.now();
      throw err;
    }
  }

  /**
   * Write data to a BLE characteristic using full GATT discovery.
   *
   * peripheral.write() shorthand doesn't properly detect characteristic write
   * properties (write vs write-without-response) because it skips GATT discovery.
   * The fan's mode characteristics require write-with-response, but the shorthand
   * may default to the wrong type — resulting in "Write not permitted".
   *
   * Full discovery + characteristic.write() lets the BLE stack see the correct
   * GATT properties and use the right write type — matching how pyfreshintellivent
   * (bleak) operates.
   */
  async writeCharacteristic(uuid, data) {
    await this.connect();
    if (!this.peripheral) throw new Error('No connected peripheral');

    const charUuid = this.normalizeUuid(uuid);
    const serviceUuid = CHAR_TO_SERVICE[charUuid];

    if (!serviceUuid) {
      throw new Error(`Unknown characteristic ${uuid} — not in service map`);
    }

    // Re-authenticate before writing — fan's auth expires after ~10-20s idle
    await this._ensureAuth();

    try {
      // Do GATT discovery once per connection — cache for subsequent writes
      if (!this._discoveredServices) {
        this.homey.log('[ConnectionManager] Discovering GATT services for write...');
        const t0 = Date.now();
        this._discoveredServices = await this.peripheral.discoverAllServicesAndCharacteristics();
        this.homey.log(`[ConnectionManager] GATT discovery took ${Date.now() - t0}ms, found ${this._discoveredServices.length} services`);
      }

      // Find the target service
      const service = this._discoveredServices.find(s => {
        const sUuid = this.normalizeUuid(s.uuid);
        return sUuid === serviceUuid;
      });
      if (!service) throw new Error(`Service ${serviceUuid.substring(0,8)}… not found after discovery`);

      // Find the target characteristic within the service
      const chars = service.characteristics || [];
      const char = chars.find(c => {
        const cUuid = this.normalizeUuid(c.uuid);
        return cUuid === charUuid;
      });
      if (!char) throw new Error(`Characteristic ${charUuid.substring(0,8)}… not found in service`);

      // Log properties for debugging (first time only)
      if (char.properties) {
        this.homey.log(`[ConnectionManager] Char ${charUuid.substring(0,8)}… properties: ${JSON.stringify(char.properties)}`);
      }

      // Write using the discovered characteristic object — BLE stack knows correct write type
      await char.write(data);
      this.homey.log(`[ConnectionManager] Write ${charUuid.substring(0,8)}… → ${data.length} bytes (via GATT discovery)`);
      this._resetIdleTimer();
    } catch (err) {
      this.homey.error(`[ConnectionManager] Write error (${charUuid.substring(0,8)}…): ${err.message}`);
      // Mark connection as dead so next operation reconnects
      this.isConnected = false;
      this.peripheral = null;
      this._discoveredServices = null;
      this._lastDisconnectTime = Date.now();
      throw err;
    }
  }
}

module.exports = ConnectionManager;
