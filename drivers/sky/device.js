const Homey = require('homey');
const FreshIntelliventSky = require('../../lib/sky');
const ConnectionManager = require('../../lib/ConnectionManager');
const KeyStore = require('../../lib/KeyStore');

const DEFAULT_POLL_INTERVAL = 300; // Default poll interval in seconds (5 min)
const POLL_INITIAL_DELAY = 15000;  // First poll after init (15s)
const RETRY_INTERVAL = 60000;     // Retry interval on failure (60s)
const MAX_CONSECUTIVE_FAILURES = 5; // Mark unavailable after N consecutive poll failures

class SkyDevice extends Homey.Device {
  /**
   * Get configured poll interval in milliseconds from device settings.
   */
  _getPollIntervalMs() {
    const seconds = parseInt(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL;
    return seconds * 1000;
  }

  /**
   * Ensure we have an auth code stored and displayed in settings.
   * Auto-fetches from the fan if not yet available.
   * Syncs from KeyStore → device settings for user visibility.
   */
  async ensureAuthCode() {
    const keyId = this.getData().address || this.getData().uuid || this.getData().id;
    const keyStore = new KeyStore(this.homey);
    const existing = await keyStore.load(keyId);

    // Always sync the stored auth code to device settings for user visibility
    if (existing?.code) {
      const currentSetting = this.getSetting('auth_code');
      if (currentSetting !== existing.code) {
        await this.setSettings({ auth_code: existing.code }).catch(() => null);
        this.log(`Auth code synced to settings: ${existing.code.length / 2} bytes`);
      }
    }
  }

  async onInit() {
    this.log('SkyDevice has been initialized');
    try {
        const peripheralId = this.getData().uuid || this.getData().address || this.getData().id;
        const keyId = this.getData().address || peripheralId;
        this.connectionManager = new ConnectionManager(this.homey, peripheralId, keyId);
        this.sky = new FreshIntelliventSky(this.connectionManager);
        this.pollTimer = null;
        this._polling = false;  // Guard against overlapping polls
        this._consecutiveFailures = 0; // Track consecutive poll failures
        this._lastPollSuccess = false; // Track last poll result

        // Register listeners
        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('boost_mode', this.onCapabilityBoost.bind(this));
        this.registerCapabilityListener('pause_mode', this.onCapabilityPause.bind(this));
        this.registerCapabilityListener('constant_speed_mode', this.onCapabilityConstantSpeed.bind(this));
        this.registerCapabilityListener('humidity_mode', this.onCapabilityHumidity.bind(this));
        this.registerCapabilityListener('light_mode', this.onCapabilityLight.bind(this));
        this.registerCapabilityListener('airing_mode', this.onCapabilityAiring.bind(this));
        this.registerCapabilityListener('target_rpm', this.onCapabilityTargetRpm.bind(this));

        // Use setWarning instead of setUnavailable so last values stay visible
        await this.setWarning('Waiting for first poll...');

        // Log configured poll interval
        const intervalSec = parseInt(this.getSetting('poll_interval')) || DEFAULT_POLL_INTERVAL;
        this.log(`Poll interval: ${intervalSec}s (retry on failure: ${RETRY_INTERVAL / 1000}s)`);

        // Schedule first poll, then chain with setTimeout (no overlapping setInterval)
        this._schedulePoll(POLL_INITIAL_DELAY);
        
        this.log('onInit completed successfully');
    } catch (err) {
        this.error('Error in onInit:', err);
    }
  }

  /**
   * Schedule the next poll using setTimeout (avoids overlapping polls).
   * On success: wait full configured interval. On failure: retry sooner.
   */
  _schedulePoll(delay) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      // Schedule next: full interval on success, faster retry on failure
      const nextDelay = this._lastPollSuccess ? this._getPollIntervalMs() : RETRY_INTERVAL;
      this._schedulePoll(nextDelay);
    }, delay);
  }

  async onDeleted() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.connectionManager) {
      await this.connectionManager.disconnect(); // Also clears idle timer
    }
  }

  async poll() {
    // Prevent overlapping polls — BLE only supports one connection at a time
    if (this._polling) {
      this.log('Poll skipped — previous poll still running');
      return;
    }
    this._polling = true;

    try {
      // Sync auth code to settings for user visibility
      await this.ensureAuthCode().catch(() => null);

      const sensorData = await this.sky.getSensorData();
      this.log(`Sensor data: rpm=${sensorData.rpm} temp=${sensorData.temp}°C humidity=${sensorData.humidity}%RH auth=${sensorData.authenticated} mode=${sensorData.modeRaw} tempAvg=${sensorData.tempAvg}°C`);

      // Check if we're properly authenticated — warn user if not
      if (!sensorData.authenticated) {
        this.log('⚠ Fan reports auth=false — writes will fail. Put fan in pairing mode to capture correct auth code.');
      }

      // After a successful connection, sync any re-captured auth code from ConnectionManager
      await this.ensureAuthCode().catch(() => null);
      await this.setCapabilityValue('measure_rpm', sensorData.rpm);
      await this.setCapabilityValue('measure_temperature', sensorData.temp);
      if (sensorData.humidity !== null && this.hasCapability('measure_humidity')) {
        await this.setCapabilityValue('measure_humidity', sensorData.humidity);
      }

      const boost = await this.sky.getBoost();
      this.log(`Boost: enabled=${boost.enabled} rpm=${boost.rpm} seconds=${boost.seconds}`);
      await this.setCapabilityValue('boost_mode', boost.enabled);
      
      const pause = await this.sky.getPause();
      this.log(`Pause: enabled=${pause.enabled} min=${pause.minutes}`);
      await this.setCapabilityValue('pause_mode', pause.enabled);
      
      const constant = await this.sky.getConstantSpeed();
      this.log(`Constant speed: enabled=${constant.enabled} rpm=${constant.rpm}`);
      await this.setCapabilityValue('constant_speed_mode', constant.enabled);
      await this.setCapabilityValue('target_rpm', Math.round(constant.rpm));
      
      const humidity = await this.sky.getHumidity();
      this.log(`Humidity: enabled=${humidity.enabled} detection=${humidity.detection} rpm=${humidity.rpm}`);
      await this.setCapabilityValue('humidity_mode', humidity.enabled);
      
      const light = await this.sky.getLightVOC();
      this.log(`Light: enabled=${light.light.enabled} VOC: enabled=${light.voc.enabled}`);
      await this.setCapabilityValue('light_mode', light.light.enabled);
      
      const airing = await this.sky.getAiring();
      this.log(`Airing: enabled=${airing.enabled} runTime=${airing.runTime} rpm=${airing.rpm}`);
      await this.setCapabilityValue('airing_mode', airing.enabled);

      // Sync on/off state (paused = off)
      if (this.hasCapability('onoff')) {
        await this.setCapabilityValue('onoff', !pause.enabled);
      }

      // Sync actual fan values to device settings so toggles use correct parameters
      await this._syncSettingsFromFan(boost, humidity, pause, airing, light).catch(e => this.error('Settings sync error:', e));

      // Update last_updated timestamp
      const tz = this.homey.clock.getTimezone();
      const locale = this.homey.i18n.getLanguage();

      const timeStr = new Date().toLocaleTimeString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      if (this.hasCapability('last_updated')) {
        await this.setCapabilityValue('last_updated', timeStr);
      }
      
      this.log('Poll completed successfully');
      this._consecutiveFailures = 0;
      this._lastPollSuccess = true;

      // Clear any previous warning and ensure device shows as available
      await this.unsetWarning();
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

    } catch (err) {
      this._consecutiveFailures += 1;
      this._lastPollSuccess = false;
      this.error(`Polling error (failure ${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);

      // Use setWarning so last known values remain visible to the user
      const message = String(err?.message || err || 'Unknown polling error');
      if (message.includes('Could not connect') || message.includes('not found') || message.includes('Peripheral Not Found')) {
        await this.setWarning(`BLE connection failed (attempt ${this._consecutiveFailures})`);
      } else {
        await this.setWarning(message);
      }

      // Only mark fully unavailable after several consecutive failures
      if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.getAvailable()) {
        this.setUnavailable('Fan not reachable after multiple attempts. Check range and pairing.');
      }
    } finally {
      // Don't disconnect here — ConnectionManager's idle timer will auto-disconnect
      // after 30s of no activity. This allows the user to change settings right
      // after a poll without needing to establish a new BLE connection.
      this._polling = false;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // Handle poll interval change — restart timer with new interval
    if (changedKeys.includes('poll_interval')) {
      const newSeconds = parseInt(newSettings.poll_interval) || DEFAULT_POLL_INTERVAL;
      this.log(`Poll interval changed to ${newSeconds}s`);
      this._schedulePoll(newSeconds * 1000);
    }

    // Handle auth code change
    if (changedKeys.includes('auth_code')) {
      if (newSettings.auth_code) {
        const keyStore = new KeyStore(this.homey);
        const keyId = this.getData().address || this.getData().uuid || this.getData().id;
        await keyStore.save(keyId, { code: newSettings.auth_code });
        await this.connectionManager.disconnect();
      }
    }

    // Handle humidity settings
    if (changedKeys.some(k => ['humidity_rpm', 'humidity_detection'].includes(k))) {
      const enabled = this.getCapabilityValue('humidity_mode') !== false;
      const detection = parseInt(newSettings.humidity_detection) || 1;
      const rpm = parseInt(newSettings.humidity_rpm) || 2000;
      this.log(`Settings: humidity detection=${detection} rpm=${rpm}`);
      await this.sky.setHumidity(enabled, detection, rpm);
      this._schedulePoll(5000);
    }

    // Handle boost settings (minutes in settings → seconds for fan)
    if (changedKeys.some(k => ['boost_rpm', 'boost_minutes'].includes(k))) {
      const enabled = this.getCapabilityValue('boost_mode') !== false;
      const rpm = parseInt(newSettings.boost_rpm) || 2400;
      const seconds = (parseInt(newSettings.boost_minutes) || 10) * 60;
      this.log(`Settings: boost rpm=${rpm} seconds=${seconds}`);
      await this.sky.setBoost(enabled, rpm, seconds);
      this._schedulePoll(5000);
    }

    // Handle pause duration
    if (changedKeys.includes('pause_minutes')) {
      const enabled = this.getCapabilityValue('pause_mode') !== false;
      const minutes = parseInt(newSettings.pause_minutes) || 60;
      this.log(`Settings: pause minutes=${minutes}`);
      await this.sky.setPause(enabled, minutes);
      this._schedulePoll(5000);
    }

    // Handle airing settings
    if (changedKeys.some(k => ['airing_rpm', 'airing_run_time'].includes(k))) {
      const enabled = this.getCapabilityValue('airing_mode') !== false;
      const runTime = parseInt(newSettings.airing_run_time) || 60;
      const rpm = parseInt(newSettings.airing_rpm) || 1500;
      this.log(`Settings: airing runTime=${runTime} rpm=${rpm}`);
      await this.sky.setAiring(enabled, runTime, rpm);
      this._schedulePoll(5000);
    }

    // Handle light/VOC settings
    if (changedKeys.some(k => ['light_detection', 'voc_enabled', 'voc_detection'].includes(k))) {
      const lightEnabled = this.getCapabilityValue('light_mode') !== false;
      const lightDetection = parseInt(newSettings.light_detection) || 1;
      const vocEnabled = newSettings.voc_enabled !== false;
      const vocDetection = parseInt(newSettings.voc_detection) || 1;
      this.log(`Settings: light detection=${lightDetection} voc=${vocEnabled} vocDetection=${vocDetection}`);
      await this.sky.setLightVOC(lightEnabled, lightDetection, vocEnabled, vocDetection);
      this._schedulePoll(5000);
    }
  }

  /**
   * Helper: execute a BLE write with error handling.
   * Reschedules next poll after a successful write so we pick up the new state.
   */
  async _executeWrite(label, fn) {
    try {
      this.log(`${label}: sending to fan...`);
      await fn();
      this.log(`${label}: success`);
      // Reschedule poll to pick up new state sooner (5s)
      this._schedulePoll(5000);
    } catch (err) {
      this.error(`${label} failed:`, err);
      const msg = String(err?.message || '');
      if (msg.includes('Write not permitted') || msg.includes('not permitted')) {
        throw new Error('Fan rejected write — authentication may be incorrect. Go to Advanced Settings and verify the auth code, or put the fan in pairing mode to re-capture it.');
      }
      throw new Error(`Could not send to fan. Try again in a moment.`);
    }
  }

  async onCapabilityTargetRpm(value) {
    // Use cached constant_speed_mode value — no BLE read needed
    const enabled = this.getCapabilityValue('constant_speed_mode') !== false;
    const rpm = Math.round(value);
    // write integer RPM to the fan
    await this._executeWrite('Set target RPM', () => this.sky.setConstantSpeed(enabled, rpm));
    // ensure the capability is stored/displayed as integer as well
    await this.setCapabilityValue('target_rpm', rpm).catch(() => null);
  }

  async onCapabilityBoost(value) {
    const rpm = parseInt(this.getSetting('boost_rpm')) || 2400;
    const minutes = parseInt(this.getSetting('boost_minutes')) || 10;
    const seconds = minutes * 60;
    await this._executeWrite('Set boost', () => this.sky.setBoost(value, rpm, seconds));
  }

  async onCapabilityPause(value) {
    const minutes = parseInt(this.getSetting('pause_minutes')) || 60;
    await this._executeWrite('Set pause', () => this.sky.setPause(value, minutes));
    // Keep on/off in sync: paused = off
    if (this.hasCapability('onoff')) {
      await this.setCapabilityValue('onoff', !value).catch(() => null);
    }
  }

  async onCapabilityConstantSpeed(value) {
    // Use cached target_rpm value
    const rpm = this.getCapabilityValue('target_rpm') || 1200;
    await this._executeWrite('Set constant speed', () => this.sky.setConstantSpeed(value, rpm));
  }

  async onCapabilityHumidity(value) {
    const detection = parseInt(this.getSetting('humidity_detection')) || 1;
    const rpm = parseInt(this.getSetting('humidity_rpm')) || 2000;
    await this._executeWrite('Set humidity mode', () => this.sky.setHumidity(value, detection, rpm));
  }

  async onCapabilityLight(value) {
    const lightDetection = parseInt(this.getSetting('light_detection')) || 1;
    const vocEnabled = this.getSetting('voc_enabled') !== false;
    const vocDetection = parseInt(this.getSetting('voc_detection')) || 1;
    await this._executeWrite('Set light mode', () =>
      this.sky.setLightVOC(value, lightDetection, vocEnabled, vocDetection)
    );
  }

  async onCapabilityAiring(value) {
    const runTime = parseInt(this.getSetting('airing_run_time')) || 60;
    const rpm = parseInt(this.getSetting('airing_rpm')) || 1500;
    await this._executeWrite('Set airing mode', () => this.sky.setAiring(value, runTime, rpm));
  }

  async onCapabilityOnOff(value) {
    const minutes = parseInt(this.getSetting('pause_minutes')) || 60;
    if (!value) {
      // Turn OFF = pause the fan
      await this._executeWrite('Pause fan', () => this.sky.setPause(true, minutes));
      await this.setCapabilityValue('pause_mode', true).catch(() => null);
    } else {
      // Turn ON = unpause the fan
      await this._executeWrite('Unpause fan', () => this.sky.setPause(false, minutes));
      await this.setCapabilityValue('pause_mode', false).catch(() => null);
    }
  }

  /**
   * Sync actual fan values to device settings.
   * This ensures capability toggles use correct parameters instead of defaults.
   */
  async _syncSettingsFromFan(boost, humidity, pause, airing, lightVOC) {
    const updates = {};

    // Boost: only sync when enabled (fan reports 0 when boost is off)
    if (boost.enabled || boost.rpm > 0) {
      const boostMinutes = Math.round(boost.seconds / 60);
      if (boost.rpm >= 800 && this.getSetting('boost_rpm') !== boost.rpm) updates.boost_rpm = boost.rpm;
      if (boostMinutes > 0 && this.getSetting('boost_minutes') !== boostMinutes) updates.boost_minutes = boostMinutes;
    }

    // Humidity: only sync RPM when it has a valid value
    if (humidity.rpm >= 800 && this.getSetting('humidity_rpm') !== humidity.rpm) updates.humidity_rpm = humidity.rpm;
    if (String(this.getSetting('humidity_detection')) !== String(humidity.detection)) {
      updates.humidity_detection = String(humidity.detection);
    }

    // Pause
    if (pause.minutes > 0 && this.getSetting('pause_minutes') !== pause.minutes) updates.pause_minutes = pause.minutes;

    // Airing: only sync when values are valid
    if (airing.rpm >= 800 && this.getSetting('airing_rpm') !== airing.rpm) updates.airing_rpm = airing.rpm;
    if (airing.runTime > 0 && this.getSetting('airing_run_time') !== airing.runTime) updates.airing_run_time = airing.runTime;

    // Light/VOC
    if (String(this.getSetting('light_detection')) !== String(lightVOC.light.detection)) {
      updates.light_detection = String(lightVOC.light.detection);
    }
    if (this.getSetting('voc_enabled') !== lightVOC.voc.enabled) updates.voc_enabled = lightVOC.voc.enabled;
    if (String(this.getSetting('voc_detection')) !== String(lightVOC.voc.detection)) {
      updates.voc_detection = String(lightVOC.voc.detection);
    }

    if (Object.keys(updates).length > 0) {
      this.log(`Syncing ${Object.keys(updates).length} settings from fan:`, Object.keys(updates).join(', '));
      await this.setSettings(updates);
    }
  }

  /** Called by the Flow Action run listener: args.device.startConstantSpeedRPM() **/
  async startConstantSpeedRPM(requestedRpm) {
    this.log('startConstantSpeedRPM called with:', requestedRpm);

    // Fallback default if not provided
    let rpm = Number(requestedRpm);
    if (!Number.isFinite(rpm)) rpm = 1200;

    // Clamp to supported range
    const MIN_RPM = 800;
    const MAX_RPM = 2400;
    rpm = Math.max(MIN_RPM, Math.min(MAX_RPM, Math.round(rpm)));

    const enabled = true; // Force state

    // Send the command to the fan
    try {
      if (typeof this._executeWrite === 'function') {
        await this._executeWrite('Set constant speed', () => this.sky.setConstantSpeed(enabled, rpm));
      } else {
        await this.sky.setConstantSpeed(enabled, rpm);
      }
    } catch (e) {
      this.error('Failed to send constant speed command:', e);
      throw e;
    }

    // Reflect state in capabilities
    try {
      if (this.hasCapability('target_rpm')) {
        await this.setCapabilityValue('target_rpm', rpm);
      }
      if (this.hasCapability('constant_speed_mode')) {
        await this.setCapabilityValue('constant_speed_mode', true);
      }
    } catch (e) {
      this.error('Failed to set capability values:', e);
    }

    this.log(`Constant speed mode enabled at ${rpm} RPM`);
    return true;
  }

  /** Called by the Flow Action run listener: args.device.stopConstantSpeed() **/
  async stopConstantSpeed() {
    this.log('stopconstantspeed called');

    const enabled = false; // Force state

    // Send the command to the fan
    try {
      if (typeof this._executeWrite === 'function') {
        await this._executeWrite('Set constant speed', () => this.sky.setConstantSpeed(enabled));
      } else {
        await this.sky.setConstantSpeed(enabled);
      }
    } catch (e) {
      this.error('Failed to send constant speed command:', e);
      throw e;
    }

    // Reflect state in capabilities
    try {
      if (this.hasCapability('constant_speed_mode')) {
        await this.setCapabilityValue('constant_speed_mode', false);
      }
    } catch (e) {
      this.error('Failed to set capability values:', e);
    }

    this.log(`Constant speed mode disabled`);
    return true;
  }

  /** Called by the Flow Action run listener: args.device.startBoostDuration() **/
  async startBoostDuration(minutes) {
    const rpm = parseInt(this.getSetting('boost_rpm')) || 2400;

    let mins = Number(minutes);

    // Clamp to supported range
    const MIN_Timer = 1;
    const MAX_Timer = 120;
    minutes = Math.max(MIN_Timer, Math.min(MAX_Timer, Math.round(mins)));

    const seconds = minutes * 60; // Convert minutes to seconds as that is the value sent to the Fan

    const enabled = true; // Force state

    await this._executeWrite('Set boost', () => this.sky.setBoost(enabled, rpm, seconds));

    // Reflect state in capabilities
    try {
      if (this.hasCapability('boost_mode')) {
        await this.setCapabilityValue('boost_mode', true);
      }
    } catch (e) {
      this.error('Failed to set capability values:', e);
    }

    this.log(`Boost Mode enabled for ${minutes} Minutes`);
    return true;
  }


  /** Placeholder for upcoming flow **/


}

module.exports = SkyDevice;
