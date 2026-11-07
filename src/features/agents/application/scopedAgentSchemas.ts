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

/** Select a union branch before removing its optional-null fields. Validation remains Zod's job. */
function matchesInputShape(schema: Schema, value: unknown): boolean {
  if (schema.const !== undefined) return value === schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.some((variant: Schema) => matchesInputShape(variant, value));
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.properties && typeof schema.properties === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Schema>;
    return Object.keys(record).every((key) => key in properties)
      && Object.entries(properties).every(([key, property]) => property.const === undefined || record[key] === property.const);
  }
  return schema.type === 'null' ? value === null : true;
}

function explicitlyAcceptsNull(schema: Schema): boolean {
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'))) return true;
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
  const variants = schema.anyOf ?? schema.oneOf;
  return Array.isArray(variants) && variants.some((variant: Schema) => explicitlyAcceptsNull(variant));
}

/** Reverse only optional-null fields, retaining explicitly nullable domain fields. */
export function decodeScopedToolInput(schema: Schema, value: unknown): unknown {
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const matching = variants.find((variant: Schema) => matchesInputShape(variant, value));
    if (matching) return decodeScopedToolInput(matching, value);
  }
  if (Array.isArray(value)) return value.map((item) => decodeScopedToolInput((schema.items ?? {}) as Schema, item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) =>
    key in properties && !required.has(key) && item === null && !explicitlyAcceptsNull(properties[key])
      ? [] : [[key, decodeScopedToolInput(properties[key] ?? {}, item)]],
  ));
}
