/**
 * A small JSON Schema checker for the subset src/openapi.ts uses: type (one
 * or a list, `integer` included), enum, required, properties,
 * additionalProperties, items, minItems/maxItems, minimum/maximum,
 * minLength/maxLength, pattern, $ref, allOf, oneOf and anyOf. Formats and
 * annotations are not checked.
 *
 * With `strict`, an object whose schema lists its properties (and says
 * nothing about others) may not carry keys the schema doesn't name: that is
 * how the spec and the Worker drift apart unnoticed. Under allOf, a key
 * counts as named when any branch names it.
 */

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (t, v) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer');

/** Errors (`path: why`) found checking `value` against `schema`; empty when it fits. */
export function validate(schema, value, { root = schema, strict = false } = {}) {
  const errs = [];
  check(schema, value, '$', errs, { root, strict }, false);
  return errs;
}

function deref(s, root) {
  while (s?.$ref) {
    const at = s.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!at) throw new Error(`dangling $ref ${s.$ref}`);
    s = at;
  }
  return s;
}

/** Every property name the schema names, through $ref and allOf. */
function named(s, root) {
  s = deref(s, root);
  return [...Object.keys(s.properties ?? {}), ...(s.allOf ?? []).flatMap((b) => named(b, root))];
}

function check(s, v, path, errs, opts, inAllOf) {
  s = deref(s, opts.root);
  if (s.allOf) {
    for (const b of s.allOf) check(b, v, path, errs, opts, true);
    if (opts.strict && !inAllOf && typeOf(v) === 'object' && s.additionalProperties === undefined) {
      const known = new Set(named(s, opts.root));
      for (const k of Object.keys(v)) if (!known.has(k)) errs.push(`${path}.${k}: not in the schema`);
    }
  }
  for (const [kw, need] of [['oneOf', (n) => n === 1], ['anyOf', (n) => n >= 1]]) {
    if (!s[kw]) continue;
    const tries = s[kw].map((b) => {
      const e = [];
      check(b, v, path, e, opts, false);
      return e;
    });
    if (!need(tries.filter((e) => !e.length).length)) errs.push(`${path}: matches ${tries.filter((e) => !e.length).length} of ${kw} (${tries.flat().slice(0, 3).join('; ')})`);
  }
  if (s.type !== undefined && ![s.type].flat().some((t) => fits(t, v))) {
    errs.push(`${path}: ${typeOf(v)}, not ${[s.type].flat().join('|')}`);
    return;
  }
  if (s.enum && !s.enum.some((e) => e === v)) errs.push(`${path}: ${JSON.stringify(v)} not one of ${JSON.stringify(s.enum)}`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push(`${path}: ${v} < ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errs.push(`${path}: ${v} > ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && [...v].length < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && [...v].length > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${path}: does not match ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`, errs, opts, false));
  }
  if (typeOf(v) === 'object') {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: required, missing`);
    const props = s.properties ?? {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) check(props[k], x, `${path}.${k}`, errs, opts, false);
      else if (s.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
      else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${path}.${k}`, errs, opts, false);
      else if (opts.strict && !inAllOf && !s.allOf && s.properties && s.additionalProperties === undefined) errs.push(`${path}.${k}: not in the schema`);
    }
  }
}
