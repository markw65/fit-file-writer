declare module "@garmin/fitsdk" {
  export interface BaseFitField {
    name: string;
    type: string;
    array: "true" | "false" | "";
    scale: number | number[];
    offset: number | number[];
    units: string | string[];
    bits: number[];
    components: Array<number | string>;
    hasComponents: boolean;
  }
  export interface SubField extends BaseFitField {
    map: { name: string; value: number }[];
  }
  export interface FitField extends BaseFitField {
    num: number;
    isAccumulated: boolean;
    subFields: SubField[];
  }

  export class Stream {
    constructor(buffer: ArrayBuffer);
  }
  export class Decoder {
    constructor(stream: Stream);
    isFit(): boolean;
    checkIntegrity(): boolean;
    read(options?: {
      mesgListener?: (mesgNum: number, message: unknown) => void;
      expandSubFields?: boolean;
      expandComponents?: boolean;
      applyScaleAndOffset?: boolean;
      convertTypesToStrings?: boolean;
      convertDateTimesToDates?: boolean;
      includeUnknownData?: boolean;
      mergeHeartRates?: boolean;
    }): { messages: Record<string, unknown>; errors: unknown[] };
  }

  export const Profile: {
    types: Record<string, Record<number, string | number>>;
    messages: Record<
      number,
      {
        num: number;
        name: string;
        messagesKey: string;
        fields: Record<number, FitField>;
      }
    >;
  };
}
