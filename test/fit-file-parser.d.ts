declare module "fit-file-parser" {
  export type FitRecord = {
    timestamp: Date;
    altitude: number;
    distance: number;
    cadence: number;
    heart_rate: number;
    position_lat: number;
    position_long: number;
    speed: number;
    power?: number;
    Wind?: number;
  };

  export type FitFile = {
    records?: FitRecord[];
    field_descriptions?: { field_name: string; units: string }[];
  };

  export default class FitParser {
    constructor(options: {
      force: boolean;
      speedUnit: "km/h" | "mph" | "m/s";
      lengthUnit: "km" | "mi" | "m";
      temperatureUnit: "celcius" | "kelvin" | "farenheit";
      elapsedRecordField: boolean;
      mode: "cascade" | "list" | "both";
    });

    parse(data: Buffer, callback: (error: string, data: FitFile) => void): void;
  }
}
