export type FitField = {
  field: string;
  type: string;
  scale: number | null;
  offset: number | null;
  units: string;
};

export declare const FIT: {
  types: Record<string, Record<number, string | number>>;
  messages: Record<
    number,
    { [K in number | "name"]: K extends "name" ? string : FitField }
  >;
};
