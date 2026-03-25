import { FitField } from "@garmin/fitsdk";
import * as fs from "fs/promises";

export function csv_split(line: string) {
  const re = /(".*?"|[^,]*)(,|$)/g;
  const result: string[] = [];
  let next;
  while ((next = re.exec(line)) != null && next[0].length) {
    const str = next[1];
    result.push(str.startsWith('"') ? str.slice(1, -1) : str);
  }
  return result;
}

function toNumber(s: string) {
  if (!s) return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}
function process_messages() {
  return fetch(
    "https://docs.google.com/spreadsheets/d/1x34eRAZ45nbi3U3GyANotgmoQfj0fR49wBxmL-oLogc/export?format=csv&gid=4419141"
  )
    .then((response) => response.arrayBuffer())
    .then(async (data) => {
      const content = new TextDecoder().decode(data).replace(/[\r\n]+/g, "\n");
      await fs.writeFile("tools/undocumented-messages.csv", content);
      const lines = content.split(/\n/);
      const header = lines.shift()?.toLowerCase();
      if (
        header !==
        "Message Name,Field Def #,Field Name,Field Type,Array,Components,Scale,Offset,Units,Bits,Accumulate,Ref Field Name,Ref Field Value,Comment,Products:,EXAMPLE,Global Message Number,Source".toLowerCase()
      ) {
        throw new Error("CSV format changed. Inspect, and fix any assumptions");
      }
      const headerMap = Object.fromEntries(
        csv_split(header).map((field, i) => [field, i] as const)
      );
      type Message = {
        name: string;
        value?: number;
        fields: Record<string, Omit<FitField, "base_type">>;
      };
      const messages: Record<string, Message> = {};
      lines.push("<end>");
      lines.reduce<Message | null>(
        (record, line) => {
          const row = csv_split(line);
          if (row[0]) {
            if (record && /^\w+$/.test(record.name)) {
              messages[record.name] = record;
            }
            const value = toNumber(row[headerMap["global message number"]]);
            return value == null
              ? { name: row[0], fields: {} }
              : {
                  name: row[0],
                  value,
                  fields: {},
                };
          }
          if (!record) {
            throw new Error(
              `Invalid CSV file. Got field entry with no active record`
            );
          }
          const [
            ,
            numStr,
            name,
            typeStr,
            array,
            componentsStr,
            scaleStr,
            offsetStr,
            units,
            bitsStr,
            accumulateStr,
          ] = row;
          if (!/^\w+$/.test(name)) {
            return record;
          }
          switch (typeStr) {
            case "bits":
            case "":
              console.error(
                `Dropping field ${name} with unknown type '${typeStr}'`
              );
              return record;
          }
          const type = typeStr
            .replace("float_32", "float32")
            .replace(/^int(\d+)/, "sint$1")
            .replace(/^(u|s)sint/, "$1int");
          const components = componentsStr ? componentsStr.split(",") : [];
          const bits = bitsStr
            ? bitsStr.split(",").map((b) => toNumber(b))
            : [];
          if (
            bits.length !== components.length ||
            bits.some((b) => b == null)
          ) {
            throw new Error(
              `Incompatible bits and components. Found bits=${bits}, components=${components} in field ${name} in message ${record.name}`
            );
          }
          const num = toNumber(numStr);
          if (num == null) {
            console.error(
              `Field ${name} has invalid id '${numStr}' in message ${record.name}`
            );
            return record;
          }
          const scale = toNumber(scaleStr) ?? 1;
          const offset = toNumber(offsetStr) ?? 0;

          record.fields[name] = {
            name,
            num,
            type,
            array: array !== "",
            scale,
            offset,
            units,
            subFields: [],
            isAccumulated: accumulateStr !== "",
            bits: bits as number[],
            components,
            hasComponents: false,
          };
          return record;
        },
        null as Message | null
      );
      return messages;
    });
}

function process_types() {
  return fetch(
    "https://docs.google.com/spreadsheets/d/1x34eRAZ45nbi3U3GyANotgmoQfj0fR49wBxmL-oLogc/export?format=csv&gid=164559909"
  )
    .then((response) => response.arrayBuffer())
    .then(async (data) => {
      const content = new TextDecoder().decode(data).replace(/[\r\n]+/g, "\n");
      await fs.writeFile("tools/undocumented-types.csv", content);
      const lines = content.split(/\n/);
      const header = lines.shift()?.toLowerCase();
      if (
        header !==
        "Type Name,Base Type,Value Name,Value,Comment,Source,".toLowerCase()
      ) {
        throw new Error("CSV format changed. Inspect, and fix any assumptions");
      }
      type Type = Record<string, number>;
      const types: Record<string, Type> = {};
      lines.push("<end>");
      lines.reduce<{ type: Type; name: string } | null>((record, line) => {
        const row = csv_split(line);
        if (row[0]) {
          if (record) {
            types[record.name] = record.type;
          }
          return { name: row[0], type: {} };
        }
        if (!record) {
          throw new Error(
            `Invalid CSV file. Got field entry with no active record`
          );
        }
        const [, , name, numStr] = row;
        const num = Number(numStr);
        if (isNaN(num)) {
          throw new Error(
            `While parsing type ${record.name}, no id for field ${name}`
          );
        }
        record.type[name] = num;
        return record;
      }, null);
      return types;
    });
}

Promise.all([process_types(), process_messages()])
  .then(async ([types, messages]) => {
    console.log(
      `// GENERATED BY:\n`,
      `// % npm run refresh-undocumented\n`,
      "// Re-run to pick up changes to https://docs.google.com/spreadsheets/d/1x34eRAZ45nbi3U3GyANotgmoQfj0fR49wBxmL-oLogc\n\n"
    );
    console.log(
      `export const undocumented_types = ${JSON.stringify(types, undefined, "  ")};\n`,
      `export const undocumented_messages = ${JSON.stringify(messages, undefined, "  ")};\n`
    );
  })
  .catch((e) => {
    console.error(`Failed to generate undocumented messages: ${e}`);
    process.exit(1);
  });
