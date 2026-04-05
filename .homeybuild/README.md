# Fresh Intellivent SKY for Homey

Control your Fresh Intellivent SKY fans via Bluetooth using Homey Pro.

## Limitations
- Poor BLE signal strenght from fan. Homey needs to be somewhat close to the fan in order to work.
- Fan can only sustain one BLE connection at a time, meaning if you have the Fresh app open, Homey will not be able to communicate with the fan and vice versa.

## Known issues (under investigation)
- Connection and auth with fan fails randomly.
- High Memory (PSS) use, around 3 times higher than Homey recommends.
- Memory leak (PSS Memory increasing the longer the app is running).
- Node Instances created per device (ConnectionManager, KeyStore etc), doubling the RAM used per additional added device
- If multiple sky devices are installed, poll crashing makes the BLE connection fail => connection queue needed
- Relative Humidity sometimes showing unexpected values.

## Features
- Read Temperature and Humidity
- Read Fan Speed (RPM)
- Control Fan Speed
- Toggle Boost, Pause, Constant Speed, Humidity, Light/VOC, and Airing modes.
- Action flows for Boost and Constant Speed mode.

## Credits
This app is based on the [Fresh Intellivent Sky integration for Home Assistant](https://github.com/angoyd/freshintelliventHacs) by [angoyd](https://github.com/angoyd) and the underlying python library [pyfreshintellivent](https://github.com/angoyd/pyfreshintellivent).

## License
MIT
