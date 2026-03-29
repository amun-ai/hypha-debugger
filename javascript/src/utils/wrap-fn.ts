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
  //
  // hypha-rpc HTTP handler passes kwargs as a single plain object, e.g.:
  //   execute_script({code: "..."}) instead of execute_script("...")
  //   get_react_tree({}) instead of get_react_tree()
  // We detect this and destructure, or discard empty objects.
  const paramList = paramNames.join(", ");
  const firstParam = paramNames[0];
  const wrapper = new Function(
    "fn",
    "paramNames",
    `return async function(${paramList}) {
      // Detect kwargs-as-object: single argument that is a plain object
      if (arguments.length === 1 && ${firstParam} != null && typeof ${firstParam} === "object" && !Array.isArray(${firstParam}) && !(${firstParam} instanceof Date) && ${firstParam}.constructor === Object) {
        var _kw = ${firstParam};
        var _keys = Object.keys(_kw);
        // Empty object {} → call with no args (all defaults)
        if (_keys.length === 0) {
          return fn();
        }
        // Keys match schema params → destructure
        if (paramNames.indexOf(_keys[0]) !== -1) {
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
