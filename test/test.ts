import * as fs from "node:fs/promises";
import { FitDevInfo, FitWriter } from "src/fit-encode";
import FitParser, { FitFile } from "fit-file-parser";

type ParsedJSON = {
  time: Date;
  ele: number;
  dist: number;
  cad: number;
  hr: number;
  lat: number;
  lng: number;
  speed: number;
  power?: number;
  wind?: number;
};

function parseFit(data: DataView) {
  const fitParser = new FitParser({
    force: false,
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "kelvin",
    elapsedRecordField: true,
    mode: "list",
  });

  // Parse your file
  return new Promise<FitFile>((resolve, reject) =>
    fitParser.parse(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      function (error, data) {
        // Handle result of parse method
        if (error) {
          reject(new Error(error));
        } else {
          resolve(data);
        }
      }
    )
  );
}

function parseJson(rawJson: string): ParsedJSON[] {
  const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid json");
  }
  const get_time = (v: unknown) => {
    if (typeof v !== "string") {
      throw new Error("Expected a string");
    }
    return new Date(v);
  };
  const get_num = (v: unknown) => {
    if (typeof v !== "number") {
      throw new Error("Expected a number");
    }
    return v;
  };
  return parsed.map((e) => {
    return {
      time: get_time(e.time),
      ele: get_num(e.ele),
      dist: get_num(e.dist),
      cad: get_num(e.cad),
      hr: get_num(e.hr),
      lat: get_num(e.lat),
      lng: get_num(e.lng),
      speed: get_num(e.speed),
      power: e.power == null ? undefined : get_num(e.power),
      wind: e.wind == null ? undefined : get_num(e.wind),
    } as const;
  });
}

function makeFit(parsed: ParsedJSON[]) {
  const fitWriter = new FitWriter();

  const elapsed_time = (start: number, end: number) => {
    return (+parsed[end - 1].time - +parsed[start].time) / 1000;
  };
  const summary = (start: number, end: number) => {
    const startSample = parsed[start];
    const endSample = parsed[end] ?? parsed[end - 1];
    return {
      timestamp: fitWriter.time(startSample.time),
      start_time: fitWriter.time(startSample.time),
      total_elapsed_time: elapsed_time(start, end),
      total_timer_time: elapsed_time(start, end),
      total_distance: endSample.dist - startSample.dist,
      start_position_lat: fitWriter.latlng(startSample.lat),
      start_position_long: fitWriter.latlng(startSample.lng),
      sport: "cycling",
    } as const;
  };

  const start = fitWriter.time(parsed[0].time);
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
    "developer_data_id",
    {
      application_id: "42c9182e-23a6-425f-b8fc-316d3d164a6f"
        .replace(/-/g, "")
        .match(/../g)!
        .map((s) => parseInt(s, 16)),
      developer_data_index: 0,
    },
    null,
    true
  );

  const windFieldNum = 0;
  fitWriter.writeMessage(
    "field_description",
    {
      developer_data_index: 0,
      field_definition_number: windFieldNum,
      field_name: "Wind",
      fit_base_type_id: 137, // float64
      units: "m/s",
    },
    null,
    true
  );

  fitWriter.writeMessage(
    "activity",
    {
      total_timer_time: elapsed_time(0, parsed.length),
      num_sessions: 1,
      type: "manual",
      timestamp: start,
      local_timestamp: start - parsed[0].time.getTimezoneOffset() * 60,
    },
    null,
    true
  );
  fitWriter.writeMessage("session", summary(0, parsed.length), null, true);
  const laps = [
    0,
    parsed.length >> 2,
    parsed.length >> 1,
    (parsed.length * 3) >> 2,
  ];
  laps.forEach((start, i) => {
    const end = laps[i + 1] ?? parsed.length;
    fitWriter.writeMessage(
      "lap",
      summary(start, end),
      null,
      i === laps.length - 1
    );
  });
  parsed.forEach((v) => {
    const timestamp = fitWriter.time(v.time);
    const power = v.power;
    const distance = v.dist;
    const speed = v.speed;
    const altitude = v.ele;
    const cadence = v.cad;
    const heart_rate = v.hr;
    const position_long = fitWriter.latlng(v.lng);
    const position_lat = fitWriter.latlng(v.lat);
    const devInfo: FitDevInfo[] =
      v.wind != null
        ? [
            {
              field_num: windFieldNum,
              value: v.wind,
            } as const,
          ]
        : [];

    fitWriter.writeMessage(
      "record",
      {
        power,
        timestamp,
        speed,
        distance,
        altitude,
        cadence: cadence && cadence * 60,
        heart_rate: heart_rate && heart_rate * 60,
        position_lat,
        position_long,
      },
      devInfo
    );
  });

  return fitWriter.finish();
}

function compare(name: string, json: ParsedJSON[], fit: FitFile) {
  const check = (
    a: number | undefined,
    b: number | undefined,
    delta: number,
    msg: string
  ) => {
    if (a == null || b == null) {
      if (a == null && b == null) {
        return;
      }
      throw new Error(
        `${name}: ${msg}: a ${a == null ? "was" : "was not"} null while b ${
          b == null ? "was" : "was not"
        } null`
      );
    }
    if (a !== b && Math.abs(a - b) / (Math.abs(a) + Math.abs(b)) > delta) {
      throw new Error(
        delta === 0
          ? `${name}: ${msg}: ${a} != ${b}`
          : `${name}: ${msg}: |${a}-${b}| == ${Math.abs(a - b)}`
      );
    }
  };
  check(json.length, fit.records?.length, 0, "Array lengths mismatch");

  const epsilon = 1e-3;
  json.forEach((js, i) => {
    const ft = fit.records?.[i];
    if (!js || !ft) {
      throw new Error(`Missing element at i=${i}`);
    }
    check(+js.time, +ft.timestamp, 1000, "Timestamp mismatch");
    check(js.ele, ft.altitude, epsilon, "Altitude mismatch");
    check(js.dist, ft.distance, epsilon, "Distance mismatch");
    check(js.cad, ft.cadence / 60, epsilon, "Cadence mismatch");
    check(js.hr, ft.heart_rate / 60, epsilon, "Heartrate mismatch");
    check(
      js.lat,
      (ft.position_lat * Math.PI) / 180,
      epsilon,
      "Latitude mismatch"
    );
    check(
      js.lng,
      (ft.position_long * Math.PI) / 180,
      epsilon,
      "Longitude mismatch"
    );
    check(js.speed, ft.speed, epsilon, "Speed mismatch");
    check(js.power, ft.power, epsilon, "Power mismatch");
    check(js.wind, ft.Wind, epsilon, "Power mismatch");
  });
}

async function processJson(jsonFileName: string) {
  const rawJson = await fs.readFile(jsonFileName, "utf-8");
  const json = parseJson(rawJson);
  const rawFit = makeFit(json);
  const name = jsonFileName.replace(/\.[^.]+$/, "") + ".fit";
  const [fit] = await Promise.all([
    parseFit(rawFit),
    fs.writeFile(name, rawFit),
  ]);
  compare(name, json, fit);
}

async function driver() {
  const args = process.argv.slice(2);
  return Promise.all(
    args.map(async (arg) => {
      if (/\.json/i.test(arg)) {
        await processJson(arg);
      }
      return null;
    })
  );
}

driver().then(
  () => console.log("Success"),
  (e) => {
    console.log(`Failed: ${e}`);
    process.exit(1);
  }
);
