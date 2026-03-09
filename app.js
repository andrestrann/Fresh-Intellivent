const Homey = require('homey');

class FreshIntelliventApp extends Homey.App {
  onInit() {
    this.log('Fresh Intellivent App is running...');


    // Action Flow Cards //

    // Activate Constant speed at selected RPM
    const actionCard = this.homey.flow.getActionCard('start-constant-speed-rpm');

    actionCard.registerRunListener(async (args, state) => {
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
  }
}

module.exports = FreshIntelliventApp;