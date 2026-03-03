# Fresh Intellivent SKY for Homey

Control your Fresh Intellivent SKY fans via Bluetooth using Homey Pro.

## Known issues/limitatioins
- Poor signal strenght from fan BLE. Homey needs to be somewhat close to the fan.
- Connection and auth with fan fails randomly.
- Fan can only sustain one BLE connection at a time, meaning if you have the Fresh app open, Homey will not be able to communicate with the fan and vice versa.

## Features
- Read Temperature and Humidity
- Read Fan Speed (RPM)
- Control Fan Speed
- Toggle Boost, Pause, Constant Speed, Humidity, Light/VOC, and Airing modes.

## Credits
This app is based on the [Fresh Intellivent Sky integration for Home Assistant](https://github.com/angoyd/freshintelliventHacs) by [angoyd](https://github.com/angoyd) and the underlying python library [pyfreshintellivent](https://github.com/angoyd/pyfreshintellivent).

## License
MIT
