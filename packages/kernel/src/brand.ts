declare const jooEventsBrand: unique symbol;

/** A nominal type whose value is created only by its owning parser. */
export type Brand<Value, Name extends string> = Value & {
  readonly [jooEventsBrand]: Name;
};
