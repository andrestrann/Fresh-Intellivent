const Homey = require('homey');

class FreshIntelliventApp extends Homey.App {
  onInit() {
    this.log('Fresh Intellivent App is running...');


    // ** Action Flow Cards ** //
    // Activate Constant speed mode at selected RPM
    const startConstantSpeed = this.homey.flow.getActionCard('start-constant-speed-rpm');

    startConstantSpeed.registerRunListener(async (args, state) => {
      try {
        let rpm = Number(args.rpm);
        if (!Number.isFinite(rpm)) {
          rpm = 2400
        }
        await args.device.startConstantSpeedRPM(rpm);
        return true; // indicates success to Flow
      } catch (err) {
        this.error('Failed to activate constant speed mode:', err);
        throw new Error(this.homey.__('errors.activation_failed') || 'Activation failed');
      }
    });

    // Deactivate Constant speed mode
    const stopConstantSpeed = this.homey.flow.getActionCard('stop-constant-speed');

    stopConstantSpeed.registerRunListener(async (args, state) => {
     await args.device.stopConstantSpeed();
     return true;
    });
  }
}

module.exports = FreshIntelliventApp;