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
 *
 * Additionally, it handles the case where hypha-rpc passes kwargs as a single
 * object argument (e.g. `fn({url: "..."})` instead of `fn("...")`). The
 * wrapper detects this and destructures the kwargs object automatically.
 */
export function wrapFn(fn: any): any {
  const schema = fn.__schema__;
  const paramNames: string[] = schema?.parameters?.properties
    ? Object.keys(schema.parameters.properties)
    : [];

  if (paramNames.length === 0) {
    return fn;
  }

  // Create a wrapper that:
  // 1. Has correct, unminified parameter names (for hypha-rpc getParamNames)
  // 2. Detects when kwargs are passed as a single object and destructures them
  const paramList = paramNames.join(", ");
  const wrapper = new Function(
    "fn",
    "paramNames",
    `return async function(${paramList}) {
      // Detect kwargs-as-object: single argument that is a plain object
      // whose keys match schema parameter names
      if (arguments.length === 1 && ${paramList} != null && typeof ${paramList} === "object" && !Array.isArray(${paramList}) && !(${paramList} instanceof Date)) {
        var _kw = ${paramList};
        var _firstKey = Object.keys(_kw)[0];
        if (_firstKey && paramNames.indexOf(_firstKey) !== -1) {
          var _args = paramNames.map(function(n) { return _kw[n]; });
          return fn.apply(null, _args);
        }
      }
      return fn(${paramList});
    }`
  )(fn, paramNames);

  if (schema) wrapper.__schema__ = schema;
  return wrapper;
}
