/**
 * Wrap a function with correct, unminified parameter names for hypha-rpc.
 *
 * In production builds, Babel/Terser minifies parameter names (e.g. 'code' → 'e').
 * hypha-rpc's getParamNames() parses Function.toString() to map kwargs to
 * positional args. With minified names, kwargs like {code: '...'} can't be
 * mapped and args are silently dropped.
 *
 * This helper uses new Function() to create a wrapper whose parameter names
 * are taken from the function's __schema__ property, so hypha-rpc always sees
 * the real parameter names regardless of minification.
 */
export function wrapFn(fn: any): any {
  const schema = fn.__schema__;
  const paramNames: string[] = schema?.parameters?.properties
    ? Object.keys(schema.parameters.properties)
    : [];

  if (paramNames.length === 0) {
    return fn;
  }

  const paramList = paramNames.join(", ");
  const wrapper = new Function(
    "fn",
    `return async function(${paramList}) { return fn(${paramList}); }`
  )(fn);

  if (schema) wrapper.__schema__ = schema;
  return wrapper;
}
