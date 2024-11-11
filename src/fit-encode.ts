import {
  ExtFitField,
  FitBaseTypes,
  FitExtraTypes,
  FitMessageInputs,
  FitMessageMap,
  FitRawTypes,
  fit_messages,
  fit_types,
} from "./fit-tables";

type keysOf<o> = {
  [K in keyof o]: K extends string ? K : K extends number ? `${K}` : never;
}[keyof o];

export function keysOf<o extends object>(o: o) {
  return Object.keys(o) as keysOf<o>[];
}

type FitMessages = typeof fit_messages;
type MessageKeys = keyof FitMessages;

export type FitDevInfo = {
  field_num: number;
  value: number;
};

const crc_table = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

type LocalDefinitionField = {
  key: string;
  size: number;
  base_type: string;
  info: [number, number, number];
};

type LocalDefinition = {
  global: MessageKeys;
  local: number;
  localCompressed: number;
  hasTimestamp: boolean;
  fields: LocalDefinitionField[];
  devFields: LocalDefinitionField[];
};

function baseTypeInfo(
  type: FitExtraTypes,
  value: unknown,
  field?: ExtFitField
): { type: FitBaseTypes; size: number } {
  let isArray = field?.array === "true";
  let size;
  if (field?.hasComponents && field.components.length >= 2) {
    size = field.bits.reduce((t, b) => t + b, 0);
    isArray = false;
    if (size & 7) {
      throw new Error(`Invalid bit-size ${size} for component bit field`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`Wanted an array for component field, but got ${value}`);
    }
    size >>= 3;
    switch (type) {
      case "byte":
      case "uint8":
      case "uint16":
      case "uint32":
        return { type, size };
    }
    throw new Error(`Unexpected type '${type}' for component field`);
  }
  switch (type) {
    case "string": {
      if (typeof value !== "string") {
        throw new Error(`string without a length`);
      }
      size = value.length;
      isArray = false;
      break;
    }
    case "sint8":
    case "uint8":
    case "uint8z":
    case "byte":
    case "enum":
      size = 1;
      break;
    case "sint16":
    case "uint16":
    case "uint16z":
      size = 2;
      break;
    case "sint32":
    case "uint32":
    case "float32":
    case "uint32z":
      size = 4;
      break;
    case "float64":
    case "sint64":
    case "uint64":
    case "uint64z":
      size = 8;
      break;
    default:
      throw new Error(`Unexpected fit type ${type}`);
  }
  if (isArray) {
    if (!Array.isArray(value)) {
      throw new Error(`expected an array`);
    }
    size *= value.length;
  }
  return { type, size };
}

const timestampId = fit_messages.record.fields.timestamp.num;

export type FitWriterOptions = {
  noCompressedTimestamps?: boolean;
  usePreferredRecords?: boolean;
};

export class FitWriter {
  private buffer: DataView;
  private offset = 0;
  private crc: number;
  private definitionMap = new Map<string, LocalDefinition>();
  private nextLocalDef = 0;
  private localDefs: string[] = [];
  private scratch = new DataView(new ArrayBuffer(8));
  private devFieldTypes = new Map<
    number,
    { base_type: FitBaseTypes; developer_data_index: number }
  >();
  private lastTimeStamp: number | null | undefined;
  private options: FitWriterOptions;
  private ensureSpace(bytes: number) {
    const newSize = this.offset + bytes;
    if (this.buffer.byteLength >= newSize) return;
    const src = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength
    );
    const dst = new Uint8Array(newSize * 2);
    dst.set(src);
    this.buffer = new DataView(dst.buffer);
  }

  constructor(options?: FitWriterOptions | boolean) {
    if (options === true || options === false) {
      this.options = { noCompressedTimestamps: options };
    } else {
      this.options = options ?? { noCompressedTimestamps: true };
    }
    this.buffer = new DataView(new ArrayBuffer(0x4000));
    this.crc = 0;
    this.file_header();
  }

  private write_crc() {
    const crc = this.crc;
    this.word(crc);
    this.crc = 0;
  }

  private update_crc(byte: number) {
    // compute checksum of lower four bits of byte
    let crc = this.crc;
    let tmp = crc_table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ crc_table[byte & 0xf];

    // now compute checksum of upper four bits of byte
    tmp = crc_table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ crc_table[(byte >> 4) & 0xf];

    this.crc = crc;
  }

  private byte(b: number): FitWriter {
    this.ensureSpace(1);
    b &= 255;
    this.update_crc(b);
    this.buffer.setUint8(this.offset++, b);
    return this;
  }

  private word(w: number): FitWriter {
    return this.byte(w).byte(w >> 8);
  }

  private long(l: number): FitWriter {
    return this.word(l).word(l >> 16);
  }

  private float(f: number): FitWriter {
    this.scratch.setFloat32(0, f, true);
    for (let i = 0; i < 4; i++) {
      this.byte(this.scratch.getUint8(i));
    }
    return this;
  }

  private double(d: number): FitWriter {
    this.scratch.setFloat64(0, d, true);
    for (let i = 0; i < 8; i++) {
      this.byte(this.scratch.getUint8(i));
    }
    return this;
  }

  private str(s: string): FitWriter {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    return this;
  }

  private field(field_no: number, size: number, base_type: number): FitWriter {
    return this.byte(field_no).byte(size).byte(base_type);
  }

  private definition(
    local: number,
    global: number,
    fields: [number, number, number][],
    devFields: [number, number, number][]
  ): FitWriter {
    this.byte(0x40 + (devFields.length ? 0x20 : 0) + (local & 15));
    this.byte(0); // reserved
    this.byte(0); // little endian
    this.word(global);
    this.byte(fields.length);
    fields.forEach((field) => this.field(...field));
    if (devFields.length) {
      this.byte(devFields.length);
      devFields.forEach((devField) => this.field(...devField));
    }
    return this;
  }

  private file_header(data_length: number = 0): FitWriter {
    this.byte(14); // header length
    this.byte(0x20); // protocol version number
    this.word(2195); // profile version
    this.long(data_length);
    this.str(".FIT");
    this.write_crc();
    return this;
  }

  // Convert a JS Date, or it's numerical representation to a
  // Garmin timestamp
  time(t: number | Date): number {
    // garmin time stamps are offset from unix time stamps...
    return Math.round(+t / 1000 - 631065600);
  }

  // Convert a latitude or longitude in radians to
  // Garmin's 'semicircle' units
  latlng<T extends number | undefined>(l: T): T {
    if (l == null) return l;
    const v = l / (Math.PI * 2) + 0.5;
    const frac = v - Math.floor(v);
    return Math.round((frac - 0.5) * Math.pow(2, 32)) as T;
  }

  // Finish, and return a DataView containing the fit file contents
  finish(): DataView {
    this.write_crc();
    const { offset } = this;
    // move back to the leng
    this.offset = 0;
    this.file_header(offset - 16);
    this.offset = offset;
    return new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteOffset + this.offset
    );
  }

  private writeFieldValue(
    defField: LocalDefinitionField,
    value: unknown,
    type: FitExtraTypes,
    field: ExtFitField | null
  ) {
    if (field?.hasComponents && field.components.length > 1) {
      const aval = value;
      if (!Array.isArray(aval)) {
        throw new Error(
          `Expected array of components for field '${field.name}', but got ${value}`
        );
      }
      let packed = 0n;
      let nbits = 0;
      for (let i = field.components.length; i--; ) {
        const bits = field.bits[i];
        const scale = Array.isArray(field.scale) ? field.scale[i] : null;
        const offset = Array.isArray(field.offset) ? field.offset[i] : null;
        if (bits == null || scale == null || offset == null) {
          throw new Error(
            `Inconsistent component definition for field '${field.name}'`
          );
        }
        const v = aval[i];
        if (typeof v !== "number") {
          throw new Error(`Expected a numeric components, but got: ${v}`);
        }
        packed <<= BigInt(bits);
        packed |= BigInt(((v + offset) * scale) & ((1 << bits) - 1));
        nbits += bits;
      }
      let size = 0;
      switch (defField.base_type) {
        case "byte":
        case "uint8":
          size = 8;
          break;
        case "uint16":
          size = 16;
          break;
        case "uint32":
          size = 32;
          break;
        default:
          throw new Error(
            `Unexpected base_type '${defField.base_type}' for component field`
          );
      }
      if (nbits % size) {
        throw new Error(`bit size must be a multiple of ${size}`);
      }
      value = Array(nbits / size)
        .fill(0)
        .map(() => {
          const v = Number(packed & ((1n << BigInt(size)) - 1n));
          packed >>= BigInt(size);
          return v;
        });
    }
    if (type === "string") {
      if (typeof value !== "string" || value.length !== defField.size) {
        throw new Error(
          `String mismatch. Expected string of length ${defField.size}, but got: ${value}`
        );
      }
      this.str(value);
      return;
    }
    if (Array.isArray(value)) {
      let size = -1;
      switch (defField.base_type) {
        case "byte":
          size = 1;
          break;
        case "word":
          size = 2;
          break;
        case "long":
          size = 4;
          break;
        default:
          throw new Error(
            `Unexpected base type for array: ${defField.base_type}`
          );
      }
      if (defField.size !== size * value.length) {
        throw new Error(
          `Array mismatch. Expected array of length ${
            defField.size / size
          }, but got: ${value.length}`
        );
      }

      value.forEach((v) => {
        switch (defField.base_type) {
          case "byte":
            this.byte(v);
            break;
          case "word":
            this.word(v);
            break;
          case "long":
            this.long(v);
            break;
          default:
            throw new Error(
              `Unexpected base type for array: ${defField.base_type}`
            );
        }
      });
      return;
    }
    const fitField: Record<string, number> | undefined =
      fit_types[type as FitRawTypes];
    let num = 0;
    if (typeof value === "string") {
      num = fitField?.[value];
      if (num == null) {
        throw new Error(`Missing value ${value} in field ${defField.key}`);
      }
    } else if (typeof value === "number") {
      num = value;
    } else if (fitField?.mask) {
      const v = value as { value: number; options?: string[] };
      num = v.value;
      v.options?.forEach((option) => {
        const optVal = fitField[option];
        if (optVal == null) {
          throw new Error(`Missing option ${option} in field ${defField.key}`);
        }
        num |= optVal;
      });
    } else {
      throw new Error(`Unexpected field/value types`);
    }
    if (field != null) {
      num =
        (num + (Array.isArray(field.offset) ? field.offset[0] : field.offset)) *
        (Array.isArray(field.scale) ? field.scale[0] : field.scale);
    }
    if (defField.base_type.startsWith("float")) {
      if (defField.size === 4) {
        this.float(num);
        return;
      }
      if (defField.size === 8) {
        this.double(num);
        return;
      }
    } else {
      if (defField.size === 1) {
        this.byte(num & 0xff);
        return;
      }
      if (defField.size === 2) {
        this.word(num & 0xffff);
        return;
      }
      if (defField.size === 4) {
        this.long(num & 0xffffffff);
        return;
      }
    }
    throw new Error(`Unsupported size: ${defField.size}`);
  }

  getPreferredField(message: FitMessageMap[string], key: string) {
    const field = message.fields[key];
    if (!field) {
      throw new Error(
        `Didn't find field '${key}' in message '${message.name}'`
      );
    }
    if (
      !this.options.usePreferredRecords ||
      !field.hasComponents ||
      field.components.length !== 1
    ) {
      return field;
    }
    const f = Object.values(message.fields).find(
      (f) => f.num === field.components[0]
    );
    if (!f) {
      throw new Error(
        `Didn't find preferred field for '${message.name}:${field.name}`
      );
    }
    return f;
  }
  // write a message to the file. If a local definition doesn't
  // exist for this message, create one.
  // If lastUse is true, the local definition will be discarded
  // after writing the message (so that the local id can be re-used)
  writeMessage<T extends MessageKeys>(
    messageType: T,
    messageInfo: Partial<FitMessageInputs[T]>,
    devInfo: FitDevInfo[] | null = null,
    lastUse = false
  ) {
    const removeDef = (index: number) => {
      const prevDef = this.localDefs[index];
      if (prevDef) {
        const def = this.definitionMap.get(prevDef);
        if (def) {
          this.definitionMap.delete(prevDef);
          this.localDefs[def.local] = "";
          if (def.localCompressed >= 0) {
            this.localDefs[def.localCompressed] = "";
          }
        }
        this.localDefs[index] = "";
      }
    };
    const globalMessage: FitMessageMap[T] = fit_messages[messageType];
    const compressedTimestamp =
      !this.options.noCompressedTimestamps &&
      this.lastTimeStamp != null &&
      globalMessage.fields.timestamp?.num === timestampId &&
      "timestamp" in messageInfo &&
      typeof messageInfo.timestamp === "number" &&
      messageInfo.timestamp >= this.lastTimeStamp &&
      messageInfo.timestamp - this.lastTimeStamp < 32 &&
      messageInfo.timestamp;

    const keys = keysOf(messageInfo).filter(
      (k): k is NonNullable<typeof k> =>
        messageInfo[k as keyof typeof messageInfo] != null
    );
    keys.sort((a, b) => {
      const va = globalMessage.fields[a].num;
      const vb = globalMessage.fields[b].num;
      return va - vb;
    });
    const definitionKey = `${messageType}:${keys
      .map((k) => {
        let result = k as string;
        const field = globalMessage.fields[k];
        if (!field.hasComponents || field.components.length <= 1) {
          if (field?.array === "true") {
            const value = messageInfo[k as keyof typeof messageInfo];
            if (field?.type === "string") {
              if (typeof value !== "string") {
                throw new Error(
                  `Expected a string value for ${messageType}:${k} but got ${typeof value}`
                );
              }
            } else {
              if (!Array.isArray(value)) {
                throw new Error(
                  `Expected an array value for ${messageType}:${k} but got ${typeof value}`
                );
              }
            }
            result += `:${value.length}`;
          }
        }
        return result;
      })
      .concat(devInfo?.map((info) => `dev-field-${info.field_num}`) ?? [])
      .join("*")}`;
    let definition = this.definitionMap.get(definitionKey);
    if (!definition) {
      const index = this.nextLocalDef & 15;
      removeDef(index);
      let hasTimestamp = false;
      const localCompressed =
        compressedTimestamp && index <= 3 && lastUse ? index : -1;
      const fields = keys.flatMap((key) => {
        const field = this.getPreferredField(globalMessage, key);
        if (field.name === "timestamp" && field.num === timestampId) {
          hasTimestamp = true;
          if (localCompressed >= 0) return [];
        }
        let size = -1;
        let base_type: FitBaseTypes | "" = "";
        const type = fit_types[field.type as FitRawTypes];
        if (type) {
          if (type._max <= 0xff) {
            size = 1;
            base_type =
              type._max < 0xff
                ? "mask" in type
                  ? "uint8"
                  : "enum"
                : type._min >= 1
                ? "uint8z"
                : "";
          } else if (type._max <= 0xffff) {
            size = 2;
            base_type = "uint16";
          } else if (type._max <= 0xffffffff) {
            size = 4;
            base_type = "uint32";
          }
        } else {
          ({ type: base_type, size } = baseTypeInfo(
            field.type,
            messageInfo[key as keyof typeof messageInfo],
            field
          ));
        }
        if (size < 0) {
          throw new Error(
            `Unsupported size for field '${key}' in message '${messageType}'`
          );
        }
        const base_type_index =
          fit_types.fit_base_type[base_type as FitBaseTypes];
        if (base_type_index == null) {
          throw new Error(
            `Invalid base type '${base_type}' for field '${key}' in message '${messageType}'`
          );
        }
        return {
          key,
          size,
          base_type,
          info: [field.num, size, base_type_index],
        } satisfies LocalDefinitionField;
      });
      definition = {
        global: messageType,
        local: index,
        localCompressed,
        hasTimestamp,
        fields,
        devFields:
          devInfo?.flatMap((d) => {
            const fieldInfo = this.devFieldTypes.get(d.field_num);
            if (fieldInfo == null) {
              throw new Error(
                `Missing definition for developer field ${d.field_num}`
              );
            }
            const { size, type } = baseTypeInfo(fieldInfo.base_type, d.value);
            return {
              key: d.field_num.toString(),
              base_type: type,
              size,
              info: [d.field_num, size, fieldInfo.developer_data_index],
            };
          }) ?? [],
      };
      this.localDefs[index] = definitionKey;
      this.nextLocalDef = (index + 1) & 15;
      this.definitionMap.set(definitionKey, definition);
      this.definition(
        definition.local,
        globalMessage.value,
        definition.fields.map((f) => f.info),
        definition.devFields.map((f) => f.info)
      );
    }
    if (compressedTimestamp) {
      if (definition.localCompressed < 0) {
        if (messageType === "record") {
          let local = this.nextLocalDef < 4 ? this.nextLocalDef : 0;
          if (local === definition.local) local = (local + 1) & 3;
          removeDef(local);
          definition.localCompressed = local;
          this.localDefs[local] = definitionKey;
          this.definition(
            local,
            globalMessage.value,
            definition.fields
              .map((f) => f.info)
              .filter((f) => f[0] !== timestampId),
            definition.devFields.map((f) => f.info)
          );
        }
      }
    }
    const header =
      compressedTimestamp && definition.localCompressed >= 0
        ? 128 + (definition.localCompressed << 5) + (compressedTimestamp & 31)
        : definition.local;
    this.byte(header);
    if (messageType === "field_description") {
      const fieldDescMessage = messageInfo as Partial<
        FitMessageInputs["field_description"]
      >;
      const type_id = fieldDescMessage.fit_base_type_id;
      const base_type =
        typeof type_id === "string" && type_id in fit_types.fit_base_type
          ? type_id
          : (Object.entries(fit_types.fit_base_type).find(
              ([, v]) => v === type_id
            )?.[0] as FitBaseTypes);
      if (base_type == null) {
        throw new Error(
          `Missing fit_base_type_id in developer field_description`
        );
      }
      const field_no = fieldDescMessage["field_definition_number"];
      if (field_no == null) {
        throw new Error(
          `Missing field_definition_number in developer field_description`
        );
      }
      const developer_data_index = fieldDescMessage["developer_data_index"];
      if (developer_data_index == null) {
        throw new Error(
          `Missing developer_data_index in developer field_description`
        );
      }
      this.devFieldTypes.set(field_no, {
        base_type,
        developer_data_index,
      });
    }
    definition.fields.forEach((defField) => {
      const value = messageInfo[defField.key as keyof typeof messageInfo];
      if (definition.hasTimestamp && defField.key === "timestamp") {
        if (header & 128) {
          return;
        }
        this.lastTimeStamp = value as number | null;
      }
      const field = this.getPreferredField(globalMessage, defField.key);
      this.writeFieldValue(defField, value, field.type, field);
    });
    definition.devFields.forEach((defField, index) => {
      const info = devInfo![index];
      const ft = this.devFieldTypes.get(info.field_num);
      if (!ft) {
        throw new Error(
          `Missing definition for developer field ${info.field_num}`
        );
      }
      this.writeFieldValue(defField, info.value, ft.base_type, null);
    });
    if (lastUse) {
      removeDef(definition.local);
      if (((definition.local + 1) & 15) === this.nextLocalDef) {
        this.nextLocalDef = definition.local;
      }
    }
  }
}
