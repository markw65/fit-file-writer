import { BaseFitField } from "@garmin/fitsdk";

export function isArrayField(field: BaseFitField | undefined) {
  return field?.array === true;
}
