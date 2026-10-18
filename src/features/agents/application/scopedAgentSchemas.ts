export type Schema = Record<string, unknown>;
/** OpenAI strict mode represents optional properties as required nullable values. */
export function strictScopedToolSchema(source: Schema): Schema {
  const schema = { ...source };
  delete schema.$schema;
  if (schema.properties && typeof schema.properties === 'object') {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
      const child = strictScopedToolSchema(value as Schema);
      return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }];
    }));
    schema.required = Object.keys(schema.properties as Schema);
    schema.additionalProperties = false;
  }
  if (schema.items && typeof schema.items === 'object') schema.items = strictScopedToolSchema(schema.items as Schema);
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((item) => strictScopedToolSchema(item as Schema));
    schema.items = { anyOf: items };
    schema.minItems = items.length;
    schema.maxItems = items.length;
    delete schema.prefixItems;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) schema[key] = schema[key].map((item) => strictScopedToolSchema(item as Schema));
  }
  return schema;
}

/** Reverse only optional-null fields, retaining explicitly nullable domain fields. */
export function decodeScopedToolInput(schema: Schema, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeScopedToolInput((schema.items ?? {}) as Schema, item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const matching = variants.find((variant: Schema) => {
      const properties = variant.properties as Record<string, Schema> | undefined;
      return properties && Object.keys(record).every((key) => key in properties)
        && Object.entries(properties).every(([key, property]) => property.const === undefined || record[key] === property.const);
    });
    if (matching) return decodeScopedToolInput(matching, value);
  }
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) =>
    key in properties && !required.has(key) && item === null ? [] : [[key, decodeScopedToolInput(properties[key] ?? {}, item)]],
  ));
}