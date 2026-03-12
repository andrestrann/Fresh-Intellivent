const util = require('./util');

const UUIDs = {
  DEVICE_NAME: 'b85fa07a-9382-4838-871c-81d045dcc2ff',
  DEVICE_STATUS: '528b80e8-c47a-4c0a-bdf1-916a7748f412',
  AUTH: '4cad343a-209a-40b7-b911-4d9b3df569b2',
  HUMIDITY: '7c4adc01-2f33-11e7-93ae-92361f002671',
  LIGHT_VOC: '7c4adc02-2f33-11e7-93ae-92361f002671',
  CONSTANT_SPEED: '7c4adc03-2f33-11e7-93ae-92361f002671',
  TIMER: '7c4adc04-2f33-11e7-93ae-92361f002671',
  AIRING: '7c4adc05-2f33-11e7-93ae-92361f002671',
  PAUSE: '7c4adc06-2f33-11e7-93ae-92361f002671',
  BOOST: '7c4adc07-2f33-11e7-93ae-92361f002671',
  TEMPORARY_SPEED: '7c4adc08-2f33-11e7-93ae-92361f002671',
};

class FreshIntelliventSky {
  constructor(connectionManager) {
    this.connectionManager = connectionManager;
  }

  async fetchAuthCode() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.AUTH);
    return data.toString('hex');
  }

  async authenticate(authCode) {
    const buffer = Buffer.from(authCode, 'hex');
    await this.connectionManager.writeCharacteristic(UUIDs.AUTH, buffer);
  }

  async getHumidity() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.HUMIDITY);
    const enabled = data.readUInt8(0) !== 0;
    const detection = data.readUInt8(1);
    const rpm = data.readUInt16LE(2);
    return { enabled, detection, rpm };
  }

  async setHumidity(enabled, detection, rpm) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(util.validatedDetection(detection), 1);
    buffer.writeUInt16LE(util.validatedRPM(rpm), 2);
    await this.connectionManager.writeCharacteristic(UUIDs.HUMIDITY, buffer);
  }

  async getLightVOC() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.LIGHT_VOC);
    return {
      light: {
        enabled: data.readUInt8(0) !== 0,
        detection: data.readUInt8(1)
      },
      voc: {
        enabled: data.readUInt8(2) !== 0,
        detection: data.readUInt8(3)
      }
    };
  }

  async setLightVOC(lightEnabled, lightDetection, vocEnabled, vocDetection) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(lightEnabled ? 1 : 0, 0);
    buffer.writeUInt8(util.validatedDetection(lightDetection), 1);
    buffer.writeUInt8(vocEnabled ? 1 : 0, 2);
    buffer.writeUInt8(util.validatedDetection(vocDetection), 3);
    await this.connectionManager.writeCharacteristic(UUIDs.LIGHT_VOC, buffer);
  }

  async getConstantSpeed() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.CONSTANT_SPEED);
    return {
      enabled: data.readUInt8(0) !== 0,
      rpm: data.readUInt16LE(1)
    };
  }

  async setConstantSpeed(enabled, rpm) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt16LE(util.validatedRPM(rpm), 1);
    await this.connectionManager.writeCharacteristic(UUIDs.CONSTANT_SPEED, buffer);
  }

  async getTimer() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.TIMER);
    return {
      runTime: data.readUInt8(0),
      delay: {
        enabled: data.readUInt8(1) !== 0,
        minutes: data.readUInt8(2)
      },
      rpm: data.readUInt16LE(3)
    };
  }

  async setTimer(runTime, delayEnabled, delayMinutes, rpm) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(runTime, 0);
    buffer.writeUInt8(delayEnabled ? 1 : 0, 1);
    buffer.writeUInt8(delayMinutes, 2);
    buffer.writeUInt16LE(util.validatedRPM(rpm), 3);
    await this.connectionManager.writeCharacteristic(UUIDs.TIMER, buffer);
  }

  async getAiring() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.AIRING);
    return {
      enabled: data.readUInt8(0) !== 0,
      runTime: data.readUInt8(2),
      rpm: data.readUInt16LE(3)
    };
  }

  async setAiring(enabled, runTime, rpm) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(26, 1); // Always 26 (0x1A)
    buffer.writeUInt8(util.validatedMinutes(runTime), 2);
    buffer.writeUInt16LE(util.validatedRPM(rpm), 3);
    await this.connectionManager.writeCharacteristic(UUIDs.AIRING, buffer);
  }

  async getPause() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.PAUSE);
    return {
      enabled: data.readUInt8(0) !== 0,
      minutes: data.readUInt8(1)
    };
  }

  async setPause(enabled, minutes) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(util.validatedMinutes(minutes), 1);
    await this.connectionManager.writeCharacteristic(UUIDs.PAUSE, buffer);
  }

  async getBoost() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.BOOST);
    const enabled = data.readUInt8(0) !== 0;
    // Byte layout: [enabled:1] [speed:2 uint16LE] [seconds:2 uint16LE]
    const rpm = data.readUInt16LE(1);
    const seconds = data.readUInt16LE(3);
    return { enabled, rpm, seconds };
  }

  async setBoost(enabled, rpm, seconds) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    // Byte layout: [enabled:1] [speed:2 uint16LE] [seconds:2 uint16LE]
    buffer.writeUInt16LE(util.validatedRPM(rpm), 1);
    buffer.writeUInt16LE(Math.max(0, Math.round(seconds)), 3);
    await this.connectionManager.writeCharacteristic(UUIDs.BOOST, buffer);
  }

  async setTemporarySpeed(enabled, rpm) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt16LE(util.validatedRPM(rpm), 1);
    await this.connectionManager.writeCharacteristic(UUIDs.TEMPORARY_SPEED, buffer);
  }

  /**
   * Parse DEVICE_STATUS characteristic (15 bytes).
   * Struct format: <2B2H2B2H3B
   *   byte  0:   status (bool)
   *   byte  1:   mode_raw
   *   bytes 2-3: humidity_raw (uint16LE) → log(val/10)*10 for %RH
   *   bytes 4-5: temperature (uint16LE, /100 for °C)
   *   byte  6:   unknown
   *   byte  7:   authenticated (bool)
   *   bytes 8-9: rpm (uint16LE)
   *   bytes 10-11: temperature_avg (uint16LE, /100 for °C)
   *   bytes 12-14: unknowns
   */
  async getSensorData() {
    const data = await this.connectionManager.readCharacteristic(UUIDs.DEVICE_STATUS);

    if (data.length < 15) {
      throw new Error(`DEVICE_STATUS expected 15 bytes, got ${data.length}`);
    }

    const status = data.readUInt8(0) !== 0;
    const modeRaw = data.readUInt8(1);
    const humidityRaw = data.readUInt16LE(2);
    
    let humidity = null;
    // Filter common "invalid" markers and zero
      if (humidityRaw !== 0 && humidityRaw !== 0xFFFF) {
        const h = humidityRaw / 10;       // convert tenths → %
        if (Number.isFinite(h) && h >= 0 && h <= 100) {
          humidity = Math.round(h * 10) / 10; // one decimal place
      }
    }

    const temp = data.readUInt16LE(4) / 100;
    const authenticated = data.readUInt8(7) !== 0;
    const rpm = data.readUInt16LE(8);
    const tempAvg = data.readUInt16LE(10) / 100;

    return { status, modeRaw, humidity, temp, authenticated, rpm, tempAvg };
  }
}

module.exports = FreshIntelliventSky;
