const Homey = require('homey');
const ConnectionManager = require('../../lib/ConnectionManager');
const FreshIntelliventSky = require('../../lib/sky');
const KeyStore = require('../../lib/KeyStore');

class SkyDriver extends Homey.Driver {

  /**
   * Connect to the fan and read the AUTH characteristic.
   * Fan MUST be in pairing mode (hold button 8s → LED blinks).
   * Returns the hex auth code string, or throws if it fails.
   */
  async fetchAndStoreAuth(deviceData) {
    const peripheralId = deviceData?.uuid;
    const keyId = deviceData?.address || peripheralId;

    if (!peripheralId || !keyId) {
      throw new Error('Missing BLE identifiers for selected fan.');
    }

    this.log(`fetchAndStoreAuth: peripheralId=${peripheralId} keyId=${keyId}`);

    // Use a fresh ConnectionManager with NO auth (we don't have a code yet or want a new one)
    // Skip the normal authenticate flow — we'll handle it manually
    const cm = new ConnectionManager(this.homey, peripheralId, keyId, {
      retryEnabled: true,
      maxConnectAttempts: 5,
      skipAuth: true, // Don't authenticate — we're capturing the code
    });
    const keyStore = new KeyStore(this.homey);

    try {
      await cm.connect();

      // Read the AUTH characteristic directly
      const authData = await cm.readCharacteristic('4cad343a-209a-40b7-b911-4d9b3df569b2');
      const authCode = authData.toString('hex');
      this.log(`Auth code read from fan: ${authCode} (${authData.length} bytes)`);

      if (authCode === '00000000' || authCode === '0000000000000000') {
        throw new Error('Fan returned all zeros — it is NOT in pairing mode. Hold the button for 8 seconds until the LED blinks, then try again.');
      }

      // Write it back to authenticate
      await cm.writeCharacteristic('4cad343a-209a-40b7-b911-4d9b3df569b2', authData);
      await new Promise(r => setTimeout(r, 1000));

      // Save it
      await keyStore.save(keyId, { code: authCode });
      this.log(`Auth code captured and saved for ${keyId}: ${authCode}`);

      return authCode;
    } finally {
      await cm.disconnect();
    }
  }

  async onPair(session) {
    this.log('onPair session started');

    session.setHandler('list_devices', async () => {
      this.log('list_devices handler called');

      const devices = await this.homey.ble.discover();
      const deviceArray = Array.isArray(devices) ? devices : Object.values(devices);
      this.log(`Discover found ${deviceArray.length} BLE devices`);

      const found = [];
      const seenIds = new Set();

      for (const device of deviceArray) {
        const localName = device?.localName || device?.name;

        if (localName === 'Intellivent SKY' || localName === 'Intellivent ICE') {
          const bleAddress = String(device?.address || device?.uuid || '');
          const peripheralUuid = String(device?.uuid || bleAddress).toLowerCase().replace(/[^a-f0-9]/g, '');
          const id = bleAddress.replace(/[^A-Za-z0-9_-]/g, '_');

          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);

          const deviceObj = {
            name: localName,
            data: {
              id,
              uuid: peripheralUuid || id,
              address: bleAddress
            }
          };

          this.log('Found device:', JSON.stringify(deviceObj));
          found.push(deviceObj);
        }
      }
      this.log(`Found ${found.length} Intellivent devices`);
      return found;
    });

    session.setHandler('add_devices', async (devices) => {
      this.log('add_devices handler called with', Array.isArray(devices) ? devices.length : 0, 'devices');
      const selectedDevices = Array.isArray(devices) ? devices : [];
      const enriched = [];

      for (const selected of selectedDevices) {
        try {
          const authCode = await this.fetchAndStoreAuth(selected?.data || {});
          enriched.push({
            ...selected,
            settings: {
              ...(selected?.settings || {}),
              auth_code: authCode
            }
          });
        } catch (err) {
          this.error(`Auth fetch failed for ${selected?.name}: ${err.message}. Device added without auth.`);
          enriched.push(selected);
        }
      }

      return enriched;
    });
  }

  /**
   * Repair flow — allows user to re-capture the auth code.
   * User must put the fan in pairing mode before starting repair.
   */
  async onRepair(session, device) {
    this.log(`onRepair session started for ${device.getName()}`);

    session.setHandler('recapture_auth', async () => {
      this.log('Repair: recapture_auth handler called');
      const deviceData = device.getData();
      try {
        const authCode = await this.fetchAndStoreAuth(deviceData);
        // Update device settings with new auth code
        await device.setSettings({ auth_code: authCode }).catch(() => null);
        // Force disconnect so next poll re-authenticates with new code
        if (device.connectionManager) {
          await device.connectionManager.disconnect();
        }
        this.log(`Repair: auth code recaptured successfully: ${authCode}`);
        return { success: true, message: `Authentication code captured: ${authCode}` };
      } catch (err) {
        this.error(`Repair: auth recapture failed: ${err.message}`);
        return { success: false, message: err.message };
      }
    });
  }
}

module.exports = SkyDriver;
