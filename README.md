# @markw65/fit-file-writer

> Generate .FIT files easily and directly from JS/TS.

## Install

```
$ npm install @markw65/fit-file-writer --save
```

## How to use

See `makeFit` function in [test](./test/test.ts). Essentially:

```ts
import { FitDevInfo, FitWriter } from "@markw65/fit-file-writer";
// ...
const fitWriter = new FitWriter();
const startTime = new Date();
const start = fitWriter.time(startTime);
fitWriter.writeMessage(
  "file_id",
  {
    type: "activity",
    manufacturer: "garmin",
    product: 0,
    serial_number: 0xdeadbeef,
    time_created: start,
    product_name: "AeroPod",
  },
  null,
  true
);
fitWriter.writeMessage(
  "activity",
  {
    total_timer_time: <time-in-seconds>,
    num_sessions: 1,
    type: "manual",
    timestamp: start,
    local_timestamp: start - startTime.getTimezoneOffset() * 60,
  },
  null,
  true
);
// ... write a session and at least one lap (see test.ts), then
// samples contains the data you want to encode into the file
samples.forEach((sample) => {
  const timestamp = fitWriter.time(sample.time);
  const distance = sample.dist;
  const speed = sample.speed;
  const position_long = fitWriter.latlng(sample.lng);
  const position_lat = fitWriter.latlng(sample.lat);
  fitWriter.writeMessage(
    "record",
    {
      timestamp,
      distance,
      speed,
      position_lat,
      position_long,
    },
  );
})
myFitData = fitWriter.finish();
// Note that myFitData is a DataView whose ArrayBuffer may contain more
// data than just the fit file. To convert to a Uint8Array, you need to
// take account of byteOffset and byteLength
const uint8Array = new Uint8Array(myFitData.buffer, myFitData.byteOffset, myFitData.byteLength);
// similarly for Buffer
const buffer = Buffer.from(myFitData.buffer, myFitData.byteOffset, myFitData.byteLength);
```

## Release Notes

See [Change Log](CHANGELOG.md)

## API

1.  `FitWriter#time(value)`:
    Converts value from a JS Date to a Garmin time in seconds

1.  `FitWriter#latlng(value)`:
    Converts value from radians to Garmin's `semicircle` units, which are used by `position_lat` and `position_long` amongst others.

1.  `FitWriter#writeMessage(messageKind, messageFields, optionalDeveloperFields, lastUse)`:\
    Adds a message (and a local definition if needed) to the fit file.
    - `messageKind` is the name of the message
    - `messageFields` is an object whose field names determine the fields to write, and whose field values determine the corresponding values
    - `optionalDeveloperFields` when non-null and non-empty is a list of developer fields to be included.
    - `lastUse` can be set to tell the FitWriter that this is that last use of this local definition. For many messages, you only send one of them, so you can set this and the local definition will be freed up immediately. For things like `lap`s and `record`s there could be a lot, in which case its best to not set it until the last one. You will get a valid FIT file regardless of how this is set, but if you set it when you shouldn't (eg on every `record`) there will be a lot of redundant local definitions. And if you don't set it at all, its likely that your records will use local ids greater than 3, meaning you never get compressed time stamps.
