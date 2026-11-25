// @bun
// ../node_modules/zod/v4/core/core.js
var _a;
function $constructor(name, initializer, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: new Set
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0;i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a;
    const inst = params?.Parent ? new Definition : this;
    init(inst, def);
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = Symbol("zod_brand");

class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// ../node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = schema._zod.def.shape;
    for (const key in shape) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function merge(a, b) {
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    }
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
  rest.path ?? (rest.path = []);
  rest.message = message;
  if (ctx?.reportInput) {
    rest.input = _input;
  }
  return rest;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}

// ../node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// ../node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// ../node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// ../node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    var _a;
    (_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = new Set);
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// ../node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join(`
`));
  }
}

// ../node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 4,
  patch: 3
};

// ../node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      if (!def.normalize && def.protocol?.source === httpProtocol.source) {
        if (!/^https?:\/\//i.test(trimmed)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid URL format",
            input: payload.value,
            inst,
            continue: !def.abort
          });
          return;
        }
      }
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: def.hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv4`;
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv6`;
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error;
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error;
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error;
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error;
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64";
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64url";
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
  const isPresent = key in input;
  if (result.issues.length) {
    if (isOptionalIn && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && !isOptionalIn) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const isOptionalIn = _catchall.optin === "optional";
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (key === "__proto__")
      continue;
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = new Set);
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalIn = el._zod.optin === "optional";
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      const schema = shape[key];
      const isOptionalIn = schema?._zod?.optin === "optional";
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(key)};`);
      if (isOptionalIn && isOptionalOut) {
        doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ?? (unrecIssue = iss);
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).l = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).r = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length && unrecIssue) {
    result.issues.push({ ...unrecIssue, keys: bothKeys });
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        payload.fallback = true;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    payload.fallback = true;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (input === undefined && (result.issues.length || result.fallback)) {
    return { issues: [], value: undefined };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, undefined]) : undefined;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const input = payload.value;
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, input));
      return handleOptionalResult(result, input);
    }
    if (payload.value === undefined) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => {
        payload.value = result.value;
        if (result.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
          payload.fallback = true;
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
      payload.fallback = true;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues, fallback: left.fallback }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
  defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// ../node_modules/zod/v4/core/registries.js
var _a2;
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");

class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// ../node_modules/zod/v4/core/api.js
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// ../node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    external: params?.external ?? undefined
  };
}
function process(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      process(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    Object.assign(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) {
      return { ref: "#" };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + defId };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
        continue;
      }
    }
  }
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        Object.assign(schema, refSchema);
      }
      Object.assign(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  Object.assign(result, root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      if (seen.def.id === seen.defId)
        delete seen.def.id;
      defs[seen.defId] = seen.def;
    }
  }
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  process(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  process(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// ../node_modules/zod/v4/core/json-schema-processors.js
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time") {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const regexes = [...patterns];
    if (regexes.length === 1)
      json.pattern = regexes[0].source;
    else if (regexes.length > 1) {
      json.allOf = [
        ...regexes.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
  if (typeof format === "string" && format.includes("int"))
    json.type = "integer";
  else
    json.type = "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (typeof multipleOf === "number")
    json.multipleOf = multipleOf;
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, _params) => {
  const def = schema._zod.def;
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (ctx.unrepresentable === "throw") {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      }
    } else if (typeof val === "bigint") {
      if (ctx.unrepresentable === "throw") {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      } else {
        vals.push(Number(val));
      }
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Custom types cannot be represented in JSON Schema");
  }
};
var transformProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Transforms cannot be represented in JSON Schema");
  }
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = process(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  json.properties = {};
  const shape = def.shape;
  for (const key in shape) {
    json.properties[key] = process(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    });
  }
  const allKeys = new Set(Object.keys(shape));
  const requiredKeys = new Set([...allKeys].filter((key) => {
    const v = def.shape[key]._zod;
    if (ctx.io === "input") {
      return v.optin === undefined;
    } else {
      return v.optout === undefined;
    }
  }));
  if (requiredKeys.size > 0) {
    json.required = Array.from(requiredKeys);
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = process(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => process(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = process(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = process(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io === "input")
    json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  process(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
// ../node_modules/zod/v4/classic/iso.js
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// ../node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
    },
    addIssue: {
      value: (issue) => {
        inst.issues.push(issue);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    addIssues: {
      value: (issues) => {
        inst.issues.push(...issues);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, {
  Parent: Error
});

// ../node_modules/zod/v4/classic/parse.js
var parse3 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// ../node_modules/zod/v4/classic/schemas.js
var _installedGroups = /* @__PURE__ */ new WeakMap;
function _installLazyMethods(inst, group, methods) {
  const proto = Object.getPrototypeOf(inst);
  let installed = _installedGroups.get(proto);
  if (!installed) {
    installed = new Set;
    _installedGroups.set(proto, installed);
  }
  if (installed.has(group))
    return;
  installed.add(group);
  for (const key in methods) {
    const fn = methods[key];
    Object.defineProperty(proto, key, {
      configurable: true,
      enumerable: false,
      get() {
        const bound = fn.bind(this);
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: bound
        });
        return bound;
      },
      set(v) {
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: v
        });
      }
    });
  }
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  Object.assign(inst["~standard"], {
    jsonSchema: {
      input: createStandardJSONSchemaMethod(inst, "input"),
      output: createStandardJSONSchemaMethod(inst, "output")
    }
  });
  inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.parse = (data, params) => parse3(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode(inst, data, params);
  inst.decode = (data, params) => decode(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
  _installLazyMethods(inst, "ZodType", {
    check(...chks) {
      const def = this.def;
      return this.clone(mergeDefs(def, {
        checks: [
          ...def.checks ?? [],
          ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
        ]
      }), { parent: true });
    },
    with(...chks) {
      return this.check(...chks);
    },
    clone(def, params) {
      return clone(this, def, params);
    },
    brand() {
      return this;
    },
    register(reg, meta) {
      reg.add(this, meta);
      return this;
    },
    refine(check, params) {
      return this.check(refine(check, params));
    },
    superRefine(refinement, params) {
      return this.check(superRefine(refinement, params));
    },
    overwrite(fn) {
      return this.check(_overwrite(fn));
    },
    optional() {
      return optional(this);
    },
    exactOptional() {
      return exactOptional(this);
    },
    nullable() {
      return nullable(this);
    },
    nullish() {
      return optional(nullable(this));
    },
    nonoptional(params) {
      return nonoptional(this, params);
    },
    array() {
      return array(this);
    },
    or(arg) {
      return union([this, arg]);
    },
    and(arg) {
      return intersection(this, arg);
    },
    transform(tx) {
      return pipe(this, transform(tx));
    },
    default(d) {
      return _default(this, d);
    },
    prefault(d) {
      return prefault(this, d);
    },
    catch(params) {
      return _catch(this, params);
    },
    pipe(target) {
      return pipe(this, target);
    },
    readonly() {
      return readonly(this);
    },
    describe(description) {
      const cl = this.clone();
      globalRegistry.add(cl, { description });
      return cl;
    },
    meta(...args) {
      if (args.length === 0)
        return globalRegistry.get(this);
      const cl = this.clone();
      globalRegistry.add(cl, args[0]);
      return cl;
    },
    isOptional() {
      return this.safeParse(undefined).success;
    },
    isNullable() {
      return this.safeParse(null).success;
    },
    apply(fn) {
      return fn(this);
    }
  });
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  _installLazyMethods(inst, "_ZodString", {
    regex(...args) {
      return this.check(_regex(...args));
    },
    includes(...args) {
      return this.check(_includes(...args));
    },
    startsWith(...args) {
      return this.check(_startsWith(...args));
    },
    endsWith(...args) {
      return this.check(_endsWith(...args));
    },
    min(...args) {
      return this.check(_minLength(...args));
    },
    max(...args) {
      return this.check(_maxLength(...args));
    },
    length(...args) {
      return this.check(_length(...args));
    },
    nonempty(...args) {
      return this.check(_minLength(1, ...args));
    },
    lowercase(params) {
      return this.check(_lowercase(params));
    },
    uppercase(params) {
      return this.check(_uppercase(params));
    },
    trim() {
      return this.check(_trim());
    },
    normalize(...args) {
      return this.check(_normalize(...args));
    },
    toLowerCase() {
      return this.check(_toLowerCase());
    },
    toUpperCase() {
      return this.check(_toUpperCase());
    },
    slugify() {
      return this.check(_slugify());
    }
  });
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  _installLazyMethods(inst, "ZodNumber", {
    gt(value, params) {
      return this.check(_gt(value, params));
    },
    gte(value, params) {
      return this.check(_gte(value, params));
    },
    min(value, params) {
      return this.check(_gte(value, params));
    },
    lt(value, params) {
      return this.check(_lt(value, params));
    },
    lte(value, params) {
      return this.check(_lte(value, params));
    },
    max(value, params) {
      return this.check(_lte(value, params));
    },
    int(params) {
      return this.check(int(params));
    },
    safe(params) {
      return this.check(int(params));
    },
    positive(params) {
      return this.check(_gt(0, params));
    },
    nonnegative(params) {
      return this.check(_gte(0, params));
    },
    negative(params) {
      return this.check(_lt(0, params));
    },
    nonpositive(params) {
      return this.check(_lte(0, params));
    },
    multipleOf(value, params) {
      return this.check(_multipleOf(value, params));
    },
    step(value, params) {
      return this.check(_multipleOf(value, params));
    },
    finite() {
      return this;
    }
  });
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
  _installLazyMethods(inst, "ZodArray", {
    min(n, params) {
      return this.check(_minLength(n, params));
    },
    nonempty(params) {
      return this.check(_minLength(1, params));
    },
    max(n, params) {
      return this.check(_maxLength(n, params));
    },
    length(n, params) {
      return this.check(_length(n, params));
    },
    unwrap() {
      return this.element;
    }
  });
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  defineLazy(inst, "shape", () => {
    return def.shape;
  });
  _installLazyMethods(inst, "ZodObject", {
    keyof() {
      return _enum(Object.keys(this._zod.def.shape));
    },
    catchall(catchall) {
      return this.clone({ ...this._zod.def, catchall });
    },
    passthrough() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    loose() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    strict() {
      return this.clone({ ...this._zod.def, catchall: never() });
    },
    strip() {
      return this.clone({ ...this._zod.def, catchall: undefined });
    },
    extend(incoming) {
      return extend(this, incoming);
    },
    safeExtend(incoming) {
      return safeExtend(this, incoming);
    },
    merge(other) {
      return merge(this, other);
    },
    pick(mask) {
      return pick(this, mask);
    },
    omit(mask) {
      return omit(this, mask);
    },
    partial(...args) {
      return partial(ZodOptional, this, args[0]);
    },
    required(...args) {
      return required(ZodNonOptional, this, args[0]);
    }
  });
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        payload.fallback = true;
        return payload;
      });
    }
    payload.value = output;
    payload.fallback = true;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
// ../node_modules/@hatch/space-sdk/dist/server-contract.js
var ACTION_BRAND = "@hatch/space-sdk/action/v1";
var LEGACY_ACTION_BRAND = Symbol.for("@hatch/space-sdk/action");
function createDefineAction() {
  return function defineAction(spec) {
    return {
      __brand: ACTION_BRAND,
      request: spec.request,
      response: spec.response,
      ...spec.description !== undefined ? { description: spec.description } : {},
      ...spec.privileged !== undefined ? { privileged: spec.privileged } : {},
      handler: spec.handler
    };
  };
}
// ../node_modules/@hatch/space-sdk/dist/index.js
var defineAction = createDefineAction();

// ../node_modules/drizzle-orm/entity.js
var entityKind = Symbol.for("drizzle:entityKind");
var hasOwnEntityKind = Symbol.for("drizzle:hasOwnEntityKind");
function is(value, type) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof type) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(type, entityKind)) {
    throw new Error(`Class "${type.name ?? "<unknown>"}" doesn't look like a Drizzle entity. If this is incorrect and the class is provided by Drizzle, please report this as a bug.`);
  }
  let cls = Object.getPrototypeOf(value).constructor;
  if (cls) {
    while (cls) {
      if (entityKind in cls && cls[entityKind] === type[entityKind]) {
        return true;
      }
      cls = Object.getPrototypeOf(cls);
    }
  }
  return false;
}

// ../node_modules/drizzle-orm/column.js
class Column {
  constructor(table, config) {
    this.table = table;
    this.config = config;
    this.name = config.name;
    this.keyAsName = config.keyAsName;
    this.notNull = config.notNull;
    this.default = config.default;
    this.defaultFn = config.defaultFn;
    this.onUpdateFn = config.onUpdateFn;
    this.hasDefault = config.hasDefault;
    this.primary = config.primaryKey;
    this.isUnique = config.isUnique;
    this.uniqueName = config.uniqueName;
    this.uniqueType = config.uniqueType;
    this.dataType = config.dataType;
    this.columnType = config.columnType;
    this.generated = config.generated;
    this.generatedIdentity = config.generatedIdentity;
  }
  static [entityKind] = "Column";
  name;
  keyAsName;
  primary;
  notNull;
  default;
  defaultFn;
  onUpdateFn;
  hasDefault;
  isUnique;
  uniqueName;
  uniqueType;
  dataType;
  columnType;
  enumValues = undefined;
  generated = undefined;
  generatedIdentity = undefined;
  config;
  mapFromDriverValue(value) {
    return value;
  }
  mapToDriverValue(value) {
    return value;
  }
  shouldDisableInsert() {
    return this.config.generated !== undefined && this.config.generated.type !== "byDefault";
  }
}

// ../node_modules/drizzle-orm/column-builder.js
class ColumnBuilder {
  static [entityKind] = "ColumnBuilder";
  config;
  constructor(name, dataType, columnType) {
    this.config = {
      name,
      keyAsName: name === "",
      notNull: false,
      default: undefined,
      hasDefault: false,
      primaryKey: false,
      isUnique: false,
      uniqueName: undefined,
      uniqueType: undefined,
      dataType,
      columnType,
      generated: undefined
    };
  }
  $type() {
    return this;
  }
  notNull() {
    this.config.notNull = true;
    return this;
  }
  default(value) {
    this.config.default = value;
    this.config.hasDefault = true;
    return this;
  }
  $defaultFn(fn) {
    this.config.defaultFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  $default = this.$defaultFn;
  $onUpdateFn(fn) {
    this.config.onUpdateFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  $onUpdate = this.$onUpdateFn;
  primaryKey() {
    this.config.primaryKey = true;
    this.config.notNull = true;
    return this;
  }
  setName(name) {
    if (this.config.name !== "")
      return;
    this.config.name = name;
  }
}

// ../node_modules/drizzle-orm/table.utils.js
var TableName = Symbol.for("drizzle:Name");

// ../node_modules/drizzle-orm/tracing-utils.js
function iife(fn, ...args) {
  return fn(...args);
}

// ../node_modules/drizzle-orm/pg-core/columns/enum.js
var isPgEnumSym = Symbol.for("drizzle:isPgEnum");
function isPgEnum(obj) {
  return !!obj && typeof obj === "function" && isPgEnumSym in obj && obj[isPgEnumSym] === true;
}

// ../node_modules/drizzle-orm/subquery.js
class Subquery {
  static [entityKind] = "Subquery";
  constructor(sql, fields, alias, isWith = false, usedTables = []) {
    this._ = {
      brand: "Subquery",
      sql,
      selectedFields: fields,
      alias,
      isWith,
      usedTables
    };
  }
}

// ../node_modules/drizzle-orm/version.js
var version2 = "0.45.2";

// ../node_modules/drizzle-orm/tracing.js
var otel;
var rawTracer;
var tracer = {
  startActiveSpan(name, fn) {
    if (!otel) {
      return fn();
    }
    if (!rawTracer) {
      rawTracer = otel.trace.getTracer("drizzle-orm", version2);
    }
    return iife((otel2, rawTracer2) => rawTracer2.startActiveSpan(name, (span) => {
      try {
        return fn(span);
      } catch (e) {
        span.setStatus({
          code: otel2.SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : "Unknown error"
        });
        throw e;
      } finally {
        span.end();
      }
    }), otel, rawTracer);
  }
};

// ../node_modules/drizzle-orm/view-common.js
var ViewBaseConfig = Symbol.for("drizzle:ViewBaseConfig");

// ../node_modules/drizzle-orm/table.js
var Schema = Symbol.for("drizzle:Schema");
var Columns = Symbol.for("drizzle:Columns");
var ExtraConfigColumns = Symbol.for("drizzle:ExtraConfigColumns");
var OriginalName = Symbol.for("drizzle:OriginalName");
var BaseName = Symbol.for("drizzle:BaseName");
var IsAlias = Symbol.for("drizzle:IsAlias");
var ExtraConfigBuilder = Symbol.for("drizzle:ExtraConfigBuilder");
var IsDrizzleTable = Symbol.for("drizzle:IsDrizzleTable");

class Table {
  static [entityKind] = "Table";
  static Symbol = {
    Name: TableName,
    Schema,
    OriginalName,
    Columns,
    ExtraConfigColumns,
    BaseName,
    IsAlias,
    ExtraConfigBuilder
  };
  [TableName];
  [OriginalName];
  [Schema];
  [Columns];
  [ExtraConfigColumns];
  [BaseName];
  [IsAlias] = false;
  [IsDrizzleTable] = true;
  [ExtraConfigBuilder] = undefined;
  constructor(name, schema, baseName) {
    this[TableName] = this[OriginalName] = name;
    this[Schema] = schema;
    this[BaseName] = baseName;
  }
}

// ../node_modules/drizzle-orm/sql/sql.js
function isSQLWrapper(value) {
  return value !== null && value !== undefined && typeof value.getSQL === "function";
}
function mergeQueries(queries) {
  const result = { sql: "", params: [] };
  for (const query of queries) {
    result.sql += query.sql;
    result.params.push(...query.params);
    if (query.typings?.length) {
      if (!result.typings) {
        result.typings = [];
      }
      result.typings.push(...query.typings);
    }
  }
  return result;
}

class StringChunk {
  static [entityKind] = "StringChunk";
  value;
  constructor(value) {
    this.value = Array.isArray(value) ? value : [value];
  }
  getSQL() {
    return new SQL([this]);
  }
}

class SQL {
  constructor(queryChunks) {
    this.queryChunks = queryChunks;
    for (const chunk of queryChunks) {
      if (is(chunk, Table)) {
        const schemaName = chunk[Table.Symbol.Schema];
        this.usedTables.push(schemaName === undefined ? chunk[Table.Symbol.Name] : schemaName + "." + chunk[Table.Symbol.Name]);
      }
    }
  }
  static [entityKind] = "SQL";
  decoder = noopDecoder;
  shouldInlineParams = false;
  usedTables = [];
  append(query) {
    this.queryChunks.push(...query.queryChunks);
    return this;
  }
  toQuery(config) {
    return tracer.startActiveSpan("drizzle.buildSQL", (span) => {
      const query = this.buildQueryFromSourceParams(this.queryChunks, config);
      span?.setAttributes({
        "drizzle.query.text": query.sql,
        "drizzle.query.params": JSON.stringify(query.params)
      });
      return query;
    });
  }
  buildQueryFromSourceParams(chunks, _config) {
    const config = Object.assign({}, _config, {
      inlineParams: _config.inlineParams || this.shouldInlineParams,
      paramStartIndex: _config.paramStartIndex || { value: 0 }
    });
    const {
      casing,
      escapeName,
      escapeParam,
      prepareTyping,
      inlineParams,
      paramStartIndex
    } = config;
    return mergeQueries(chunks.map((chunk) => {
      if (is(chunk, StringChunk)) {
        return { sql: chunk.value.join(""), params: [] };
      }
      if (is(chunk, Name)) {
        return { sql: escapeName(chunk.value), params: [] };
      }
      if (chunk === undefined) {
        return { sql: "", params: [] };
      }
      if (Array.isArray(chunk)) {
        const result = [new StringChunk("(")];
        for (const [i, p] of chunk.entries()) {
          result.push(p);
          if (i < chunk.length - 1) {
            result.push(new StringChunk(", "));
          }
        }
        result.push(new StringChunk(")"));
        return this.buildQueryFromSourceParams(result, config);
      }
      if (is(chunk, SQL)) {
        return this.buildQueryFromSourceParams(chunk.queryChunks, {
          ...config,
          inlineParams: inlineParams || chunk.shouldInlineParams
        });
      }
      if (is(chunk, Table)) {
        const schemaName = chunk[Table.Symbol.Schema];
        const tableName = chunk[Table.Symbol.Name];
        return {
          sql: schemaName === undefined || chunk[IsAlias] ? escapeName(tableName) : escapeName(schemaName) + "." + escapeName(tableName),
          params: []
        };
      }
      if (is(chunk, Column)) {
        const columnName = casing.getColumnCasing(chunk);
        if (_config.invokeSource === "indexes") {
          return { sql: escapeName(columnName), params: [] };
        }
        const schemaName = chunk.table[Table.Symbol.Schema];
        return {
          sql: chunk.table[IsAlias] || schemaName === undefined ? escapeName(chunk.table[Table.Symbol.Name]) + "." + escapeName(columnName) : escapeName(schemaName) + "." + escapeName(chunk.table[Table.Symbol.Name]) + "." + escapeName(columnName),
          params: []
        };
      }
      if (is(chunk, View)) {
        const schemaName = chunk[ViewBaseConfig].schema;
        const viewName = chunk[ViewBaseConfig].name;
        return {
          sql: schemaName === undefined || chunk[ViewBaseConfig].isAlias ? escapeName(viewName) : escapeName(schemaName) + "." + escapeName(viewName),
          params: []
        };
      }
      if (is(chunk, Param)) {
        if (is(chunk.value, Placeholder)) {
          return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
        }
        const mappedValue = chunk.value === null ? null : chunk.encoder.mapToDriverValue(chunk.value);
        if (is(mappedValue, SQL)) {
          return this.buildQueryFromSourceParams([mappedValue], config);
        }
        if (inlineParams) {
          return { sql: this.mapInlineParam(mappedValue, config), params: [] };
        }
        let typings = ["none"];
        if (prepareTyping) {
          typings = [prepareTyping(chunk.encoder)];
        }
        return { sql: escapeParam(paramStartIndex.value++, mappedValue), params: [mappedValue], typings };
      }
      if (is(chunk, Placeholder)) {
        return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
      }
      if (is(chunk, SQL.Aliased) && chunk.fieldAlias !== undefined) {
        return { sql: escapeName(chunk.fieldAlias), params: [] };
      }
      if (is(chunk, Subquery)) {
        if (chunk._.isWith) {
          return { sql: escapeName(chunk._.alias), params: [] };
        }
        return this.buildQueryFromSourceParams([
          new StringChunk("("),
          chunk._.sql,
          new StringChunk(") "),
          new Name(chunk._.alias)
        ], config);
      }
      if (isPgEnum(chunk)) {
        if (chunk.schema) {
          return { sql: escapeName(chunk.schema) + "." + escapeName(chunk.enumName), params: [] };
        }
        return { sql: escapeName(chunk.enumName), params: [] };
      }
      if (isSQLWrapper(chunk)) {
        if (chunk.shouldOmitSQLParens?.()) {
          return this.buildQueryFromSourceParams([chunk.getSQL()], config);
        }
        return this.buildQueryFromSourceParams([
          new StringChunk("("),
          chunk.getSQL(),
          new StringChunk(")")
        ], config);
      }
      if (inlineParams) {
        return { sql: this.mapInlineParam(chunk, config), params: [] };
      }
      return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
    }));
  }
  mapInlineParam(chunk, { escapeString }) {
    if (chunk === null) {
      return "null";
    }
    if (typeof chunk === "number" || typeof chunk === "boolean") {
      return chunk.toString();
    }
    if (typeof chunk === "string") {
      return escapeString(chunk);
    }
    if (typeof chunk === "object") {
      const mappedValueAsString = chunk.toString();
      if (mappedValueAsString === "[object Object]") {
        return escapeString(JSON.stringify(chunk));
      }
      return escapeString(mappedValueAsString);
    }
    throw new Error("Unexpected param value: " + chunk);
  }
  getSQL() {
    return this;
  }
  as(alias) {
    if (alias === undefined) {
      return this;
    }
    return new SQL.Aliased(this, alias);
  }
  mapWith(decoder) {
    this.decoder = typeof decoder === "function" ? { mapFromDriverValue: decoder } : decoder;
    return this;
  }
  inlineParams() {
    this.shouldInlineParams = true;
    return this;
  }
  if(condition) {
    return condition ? this : undefined;
  }
}

class Name {
  constructor(value) {
    this.value = value;
  }
  static [entityKind] = "Name";
  brand;
  getSQL() {
    return new SQL([this]);
  }
}
function isDriverValueEncoder(value) {
  return typeof value === "object" && value !== null && "mapToDriverValue" in value && typeof value.mapToDriverValue === "function";
}
var noopDecoder = {
  mapFromDriverValue: (value) => value
};
var noopEncoder = {
  mapToDriverValue: (value) => value
};
var noopMapper = {
  ...noopDecoder,
  ...noopEncoder
};

class Param {
  constructor(value, encoder = noopEncoder) {
    this.value = value;
    this.encoder = encoder;
  }
  static [entityKind] = "Param";
  brand;
  getSQL() {
    return new SQL([this]);
  }
}
function sql(strings, ...params) {
  const queryChunks = [];
  if (params.length > 0 || strings.length > 0 && strings[0] !== "") {
    queryChunks.push(new StringChunk(strings[0]));
  }
  for (const [paramIndex, param2] of params.entries()) {
    queryChunks.push(param2, new StringChunk(strings[paramIndex + 1]));
  }
  return new SQL(queryChunks);
}
((sql2) => {
  function empty() {
    return new SQL([]);
  }
  sql2.empty = empty;
  function fromList(list) {
    return new SQL(list);
  }
  sql2.fromList = fromList;
  function raw(str) {
    return new SQL([new StringChunk(str)]);
  }
  sql2.raw = raw;
  function join(chunks, separator) {
    const result = [];
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0 && separator !== undefined) {
        result.push(separator);
      }
      result.push(chunk);
    }
    return new SQL(result);
  }
  sql2.join = join;
  function identifier(value) {
    return new Name(value);
  }
  sql2.identifier = identifier;
  function placeholder2(name2) {
    return new Placeholder(name2);
  }
  sql2.placeholder = placeholder2;
  function param2(value, encoder) {
    return new Param(value, encoder);
  }
  sql2.param = param2;
})(sql || (sql = {}));
((SQL2) => {

  class Aliased {
    constructor(sql2, fieldAlias) {
      this.sql = sql2;
      this.fieldAlias = fieldAlias;
    }
    static [entityKind] = "SQL.Aliased";
    isSelectionField = false;
    getSQL() {
      return this.sql;
    }
    clone() {
      return new Aliased(this.sql, this.fieldAlias);
    }
  }
  SQL2.Aliased = Aliased;
})(SQL || (SQL = {}));

class Placeholder {
  constructor(name2) {
    this.name = name2;
  }
  static [entityKind] = "Placeholder";
  getSQL() {
    return new SQL([this]);
  }
}
var IsDrizzleView = Symbol.for("drizzle:IsDrizzleView");

class View {
  static [entityKind] = "View";
  [ViewBaseConfig];
  [IsDrizzleView] = true;
  constructor({ name: name2, schema, selectedFields, query }) {
    this[ViewBaseConfig] = {
      name: name2,
      originalName: name2,
      schema,
      selectedFields,
      query,
      isExisting: !query,
      isAlias: false
    };
  }
  getSQL() {
    return new SQL([this]);
  }
}
Column.prototype.getSQL = function() {
  return new SQL([this]);
};
Table.prototype.getSQL = function() {
  return new SQL([this]);
};
Subquery.prototype.getSQL = function() {
  return new SQL([this]);
};

// ../node_modules/drizzle-orm/utils.js
function getColumnNameAndConfig(a, b) {
  return {
    name: typeof a === "string" && a.length > 0 ? a : "",
    config: typeof a === "object" ? a : b
  };
}
var textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder;

// ../node_modules/drizzle-orm/sql/expressions/conditions.js
function bindIfParam(value, column) {
  if (isDriverValueEncoder(column) && !isSQLWrapper(value) && !is(value, Param) && !is(value, Placeholder) && !is(value, Column) && !is(value, Table) && !is(value, View)) {
    return new Param(value, column);
  }
  return value;
}
var eq = (left, right) => {
  return sql`${left} = ${bindIfParam(right, left)}`;
};
function and(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter((c) => c !== undefined);
  if (conditions.length === 0) {
    return;
  }
  if (conditions.length === 1) {
    return new SQL(conditions);
  }
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" and ")),
    new StringChunk(")")
  ]);
}
function or(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter((c) => c !== undefined);
  if (conditions.length === 0) {
    return;
  }
  if (conditions.length === 1) {
    return new SQL(conditions);
  }
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" or ")),
    new StringChunk(")")
  ]);
}
function inArray(column, values) {
  if (Array.isArray(values)) {
    if (values.length === 0) {
      return sql`false`;
    }
    return sql`${column} in ${values.map((v) => bindIfParam(v, column))}`;
  }
  return sql`${column} in ${bindIfParam(values, column)}`;
}
function isNull(value) {
  return sql`${value} is null`;
}
function isNotNull(value) {
  return sql`${value} is not null`;
}
function like(column, value) {
  return sql`${column} like ${value}`;
}

// ../node_modules/drizzle-orm/sql/expressions/select.js
function asc(column) {
  return sql`${column} asc`;
}
function desc(column) {
  return sql`${column} desc`;
}

// ../node_modules/drizzle-orm/sql/functions/aggregate.js
function count(expression) {
  return sql`count(${expression || sql.raw("*")})`.mapWith(Number);
}

// ../shared/service-master.ts
function isN02StationId(id) {
  return /^\d{6}$/.test(id);
}
var SERVICE_MASTER_VERSION = "2026-11-24";
var N02_SOURCE = "\u56FD\u571F\u6570\u5024\u60C5\u5831\u300C\u9244\u9053\u30C7\u30FC\u30BF\u300DN02\uFF082025\u5E74\u5EA6\u7248\uFF09";
var LEDGER_SOURCE = "location-trivia/seen_lines.md\uFF08\u53F0\u5E33\u306E\u4E57\u8ECA\u8A18\u9332\uFF09";
var SERVICE_MASTER = [
  {
    id: "jr-musashino",
    pathId: "jr-musashino",
    displayName: "JR\u6B66\u8535\u91CE\u7DDA",
    ledgerNames: ["JR\u6B66\u8535\u91CE\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u6B66\u8535\u91CE\u7DDA",
        formalLineKey: "\u6B66\u8535\u91CE\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003876", name: "\u5E9C\u4E2D\u672C\u753A", lng: 139.47718, lat: 35.66583 },
        to: { id: "003547", name: "\u897F\u8239\u6A4B", lng: 139.95907, lat: 35.70737 }
      }
    ],
    blocks: [
      {
        id: "jr-musashino/b1",
        from: { id: "003876", name: "\u5E9C\u4E2D\u672C\u753A", lng: 139.47718, lat: 35.66583 },
        to: { id: "003004", name: "\u5357\u6D66\u548C", lng: 139.66878, lat: 35.84796 },
        stations: [
          { id: "003771", name: "\u5317\u5E9C\u4E2D", lng: 139.47179, lat: 35.68086 }
        ]
      },
      {
        id: "jr-musashino/b2",
        from: { id: "003004", name: "\u5357\u6D66\u548C", lng: 139.66878, lat: 35.84796 },
        to: { id: "003547", name: "\u897F\u8239\u6A4B", lng: 139.95907, lat: 35.70737 },
        stations: [
          { id: "003187", name: "\u6771\u677E\u6238", lng: 139.94311, lat: 35.77013 }
        ]
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "hokuso",
    pathId: "hokuso",
    displayName: "\u5317\u7DCF\u7DDA",
    ledgerNames: ["\u5317\u7DCF\u7DDA"],
    operator: "\u5317\u7DCF\u9244\u9053",
    segments: [
      {
        formalLineName: "\u5317\u7DCF\u7DDA",
        formalLineKey: "\u5317\u7DCF\u7DDA|\u5317\u7DCF\u9244\u9053",
        from: { id: "003248", name: "\u4EAC\u6210\u9AD8\u7802", lng: 139.86659, lat: 35.75087 },
        to: { id: "003125", name: "\u5370\u65DB\u65E5\u672C\u533B\u5927", lng: 140.20276, lat: 35.78782 }
      }
    ],
    blocks: [
      {
        id: "hokuso/b1",
        from: { id: "003248", name: "\u4EAC\u6210\u9AD8\u7802", lng: 139.86659, lat: 35.75087 },
        to: { id: "003125", name: "\u5370\u65DB\u65E5\u672C\u533B\u5927", lng: 140.20276, lat: 35.78782 },
        stations: [
          { id: "003187", name: "\u6771\u677E\u6238", lng: 139.94311, lat: 35.77013 },
          { id: "003083", name: "\u5370\u897F\u7267\u306E\u539F", lng: 140.16713, lat: 35.80363 }
        ]
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "jr-chuo-rapid",
    pathId: "jr-chuo-rapid",
    displayName: "JR\u4E2D\u592E\u7DDA\uFF08\u5FEB\u901F\uFF09",
    ledgerNames: ["JR\u4E2D\u592E\u7DDA\uFF08\u5FEB\u901F\uFF09", "JR\u4E2D\u592E\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u4E2D\u592E\u7DDA",
        formalLineKey: "\u4E2D\u592E\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "003677", name: "\u795E\u7530", lng: 139.77088, lat: 35.69242 },
        approximate: true,
        note: "N02\u306E\u4E2D\u592E\u7DDA\u5F62\u72B6\u306F\u795E\u7530\u3067\u9014\u5207\u308C\u308B\uFF08\u5F62\u72B6\u306E\u6771\u7AEF\u306F\u795E\u7530\u4ED8\u8FD1\u3067\u3001\u6771\u4EAC\u99C5\u304B\u3089\u7D041.1km\uFF09\u3002\u6771\u4EAC\u301C\u795E\u7530\u306F\u904B\u884C\u533A\u9593\u3068\u3057\u3066\u660E\u793A\u3059\u308B\u304C\u3001N02\u306B\u5F62\u72B6\u304C\u7121\u3044\u305F\u3081\u63CF\u753B\u30FB\u8DDD\u96E2\u306F\u795E\u7530\u4EE5\u897F\u306E\u5F62\u72B6\u306B\u9650\u308B\uFF08\u8FD1\u4F3C\uFF09\u3002\u795E\u7530\u306E\u30B0\u30EB\u30FC\u30D7\u30B3\u30FC\u30C9003677\u306FN02\u306E\uFF08\u795E\u7530, \u4E2D\u592E\u7DDA\uFF09\u884C\u3067\u78BA\u8A8D\u6E08\u307F\u3002"
      },
      {
        formalLineName: "\u4E2D\u592E\u7DDA",
        formalLineKey: "\u4E2D\u592E\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003677", name: "\u795E\u7530", lng: 139.77088, lat: 35.69242 },
        to: { id: "004029", name: "\u9AD8\u5C3E", lng: 139.28217, lat: 35.64202 },
        note: "\u5FEB\u901F\u306E\u904B\u884C\u7BC4\u56F2\u306F\u6771\u4EAC\u301C\u9AD8\u5C3E\u3002N02\u306E\u4E2D\u592E\u7DDA\u5358\u4F4D\u306F\u3055\u3089\u306B\u5148\uFF08\u5869\u5C3B\u65B9\u9762\uFF09\u307E\u3067\u5EF6\u3073\u308B\u304C\u3001\u5FEB\u901F\u3068\u3057\u3066\u306F\u3053\u3053\u307E\u3067\u3002\u306A\u304AN02\u306E\u99C5\u30DD\u30A4\u30F3\u30C8\u306B\uFF08\u6771\u4EAC, \u4E2D\u592E\u7DDA\uFF09\u306E\u884C\u306F\u7121\u3044\uFF08\u6771\u4EAC\u99C5\u306E\u30B0\u30EB\u30FC\u30D7\u30B3\u30FC\u30C9003766\u306F\u4ED6\u306EJR\u7DDA\u306E\u884C\u3067\u78BA\u8A8D\u6E08\u307F\uFF09\u3002\u99C5ID\u306F\u7269\u7406\u99C5\u306E\u30B3\u30FC\u30C9\u3067\u3042\u308A\u3001\u4E2D\u592E\u7DDA\u304C\u6771\u4EAC\u99C5\u306B\u767A\u7740\u3059\u308B\u3053\u3068\u306B\u5909\u308F\u308A\u306F\u306A\u3044\u3002"
      }
    ],
    blocks: [
      {
        id: "jr-chuo-rapid/b1",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 }
      },
      {
        id: "jr-chuo-rapid/b2",
        from: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
        to: { id: "003634", name: "\u7ACB\u5DDD", lng: 139.41396, lat: 35.69793 }
      },
      {
        id: "jr-chuo-rapid/b3",
        from: { id: "003634", name: "\u7ACB\u5DDD", lng: 139.41396, lat: 35.69793 },
        to: { id: "004029", name: "\u9AD8\u5C3E", lng: 139.28217, lat: 35.64202 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "jr-sobu-rapid",
    pathId: "jr-sobu-rapid",
    displayName: "JR\u7DCF\u6B66\u5FEB\u901F\u7DDA",
    ledgerNames: ["JR\u7DCF\u6B66\u5FEB\u901F\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u7DCF\u6B66\u7DDA",
        formalLineKey: "\u7DCF\u6B66\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 }
      }
    ],
    blocks: [
      {
        id: "jr-sobu-rapid/b1",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "003589", name: "\u8239\u6A4B", lng: 139.98422, lat: 35.70195 }
      },
      {
        id: "jr-sobu-rapid/b2",
        from: { id: "003589", name: "\u8239\u6A4B", lng: 139.98422, lat: 35.70195 },
        to: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "jr-sobu-local",
    pathId: "jr-sobu-local",
    displayName: "JR\u7DCF\u6B66\u672C\u7DDA",
    ledgerNames: ["JR\u7DCF\u6B66\u672C\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u7DCF\u6B66\u7DDA",
        formalLineKey: "\u7DCF\u6B66\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "003397", name: "\u929A\u5B50", lng: 140.82747, lat: 35.72933 }
      }
    ],
    blocks: [
      {
        id: "jr-sobu-local/b1",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 }
      },
      {
        id: "jr-sobu-local/b2",
        from: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 },
        to: { id: "003531", name: "\u4F50\u5009", lng: 140.22675, lat: 35.70974 }
      },
      {
        id: "jr-sobu-local/b3",
        from: { id: "003531", name: "\u4F50\u5009", lng: 140.22675, lat: 35.70974 },
        to: { id: "003397", name: "\u929A\u5B50", lng: 140.82747, lat: 35.72933 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "keio",
    pathId: "keio",
    displayName: "\u4EAC\u738B\u7DDA",
    ledgerNames: ["\u4EAC\u738B\u7DDA"],
    operator: "\u4EAC\u738B\u96FB\u9244",
    segments: [
      {
        formalLineName: "\u4EAC\u738B\u7DDA",
        formalLineKey: "\u4EAC\u738B\u7DDA|\u4EAC\u738B\u96FB\u9244",
        from: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
        to: { id: "003934", name: "\u4EAC\u738B\u516B\u738B\u5B50", lng: 139.34298, lat: 35.65805 }
      }
    ],
    blocks: [
      {
        id: "keio/b1",
        from: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
        to: { id: "003966", name: "\u8ABF\u5E03", lng: 139.54474, lat: 35.65177 }
      },
      {
        id: "keio/b2",
        from: { id: "003966", name: "\u8ABF\u5E03", lng: 139.54474, lat: 35.65177 },
        to: { id: "003821", name: "\u5E9C\u4E2D", lng: 139.4801, lat: 35.67219 }
      },
      {
        id: "keio/b3",
        from: { id: "003821", name: "\u5E9C\u4E2D", lng: 139.4801, lat: 35.67219 },
        to: { id: "003934", name: "\u4EAC\u738B\u516B\u738B\u5B50", lng: 139.34298, lat: 35.65805 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "jr-saikyo",
    pathId: "jr-saikyo",
    displayName: "JR\u57FC\u4EAC\u7DDA",
    ledgerNames: ["JR\u57FC\u4EAC\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u5C71\u624B\u7DDA",
        formalLineKey: "\u5C71\u624B\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 },
        to: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        approximate: true,
        direction: "outer",
        note: "\u5C71\u624B\u8CA8\u7269\u7DDA\u306E\u533A\u9593\u3002N02 2025\u306B\u8CA8\u7269\u7DDA\u306E\u8DEF\u7DDA\u5358\u4F4D\u304C\u7121\u3044\u305F\u3081\u5C71\u624B\u7DDA\uFF08\u65C5\u5BA2\uFF09\u306E\u5F62\u72B6\u3067\u4EE3\u7528\u3057\u3001\u6982\u7B97\u3068\u3057\u3066\u6271\u3046\u3002\u5916\u56DE\u308A\u5074\uFF08\u5927\u5D0E\u2192\u4E94\u53CD\u7530\u2192\u76EE\u9ED2\u2192\u6E0B\u8C37\u2192\u65B0\u5BBF\u2192\u6C60\u888B\uFF09\u3092\u901A\u308B\u3002"
      },
      {
        formalLineName: "\u8D64\u7FBD\u7DDA",
        formalLineKey: "\u8D64\u7FBD\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        to: { id: "003155", name: "\u8D64\u7FBD", lng: 139.72105, lat: 35.77754 }
      },
      {
        formalLineName: "\u6771\u5317\u7DDA",
        formalLineKey: "\u6771\u5317\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003155", name: "\u8D64\u7FBD", lng: 139.72105, lat: 35.77754 },
        to: { id: "002914", name: "\u5927\u5BAE", lng: 139.62356, lat: 35.90653 },
        note: "\u901A\u79F0\u30FB\u6771\u5317\u672C\u7DDA\u3002N02\u306E\u8DEF\u7DDA\u5358\u4F4D\u540D\u306F\u6771\u5317\u7DDA\u3002"
      },
      {
        formalLineName: "\u5DDD\u8D8A\u7DDA",
        formalLineKey: "\u5DDD\u8D8A\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "002914", name: "\u5927\u5BAE", lng: 139.62356, lat: 35.90653 },
        to: { id: "002909", name: "\u5DDD\u8D8A", lng: 139.48307, lat: 35.90705 }
      }
    ],
    blocks: [
      {
        id: "jr-saikyo/b1",
        from: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 },
        to: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        direction: "outer"
      },
      {
        id: "jr-saikyo/b2",
        from: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        to: { id: "003155", name: "\u8D64\u7FBD", lng: 139.72105, lat: 35.77754 }
      },
      {
        id: "jr-saikyo/b3",
        from: { id: "003155", name: "\u8D64\u7FBD", lng: 139.72105, lat: 35.77754 },
        to: { id: "002914", name: "\u5927\u5BAE", lng: 139.62356, lat: 35.90653 }
      },
      {
        id: "jr-saikyo/b4",
        from: { id: "002914", name: "\u5927\u5BAE", lng: 139.62356, lat: 35.90653 },
        to: { id: "002909", name: "\u5DDD\u8D8A", lng: 139.48307, lat: 35.90705 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note: "N02 2025\u306B\u57FC\u4EAC\u7DDA\u306E\u8DEF\u7DDA\u5358\u4F4D\u306F\u5B58\u5728\u3057\u306A\u3044\uFF08\u533A\u9593\u30C7\u30FC\u30BF\u306B\u300C\u57FC\u4EAC\u300D\u306E\u6587\u5B57\u5217\u81EA\u4F53\u304C\u7121\u3044\uFF09\u3002\u5408\u6210\u30B8\u30AA\u30E1\u30C8\u30EA\u306F\u4F5C\u3089\u305A\u30014\u3064\u306E\u6B63\u5F0F\u7DDA\u3078\u306E\u5C55\u958B\u3067\u6271\u3046\u3002"
  },
  {
    id: "rinkai",
    pathId: "rinkai",
    displayName: "\u308A\u3093\u304B\u3044\u7DDA",
    ledgerNames: ["\u308A\u3093\u304B\u3044\u7DDA", "\u81E8\u6D77\u526F\u90FD\u5FC3\u7DDA"],
    operator: "\u6771\u4EAC\u81E8\u6D77\u9AD8\u901F\u9244\u9053",
    segments: [
      {
        formalLineName: "\u81E8\u6D77\u526F\u90FD\u5FC3\u7DDA",
        formalLineKey: "\u81E8\u6D77\u526F\u90FD\u5FC3\u7DDA|\u6771\u4EAC\u81E8\u6D77\u9AD8\u901F\u9244\u9053",
        from: { id: "003997", name: "\u65B0\u6728\u5834", lng: 139.82668, lat: 35.64587 },
        to: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 }
      }
    ],
    blocks: [
      {
        id: "rinkai/b1",
        from: { id: "003997", name: "\u65B0\u6728\u5834", lng: 139.82668, lat: 35.64587 },
        to: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 }
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft"
  },
  {
    id: "yamanote",
    pathId: "yamanote",
    displayName: "\u5C71\u624B\u7DDA",
    ledgerNames: ["\u5C71\u624B\u7DDA"],
    operator: "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
    segments: [
      {
        formalLineName: "\u5C71\u624B\u7DDA",
        formalLineKey: "\u5C71\u624B\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "004095", name: "\u54C1\u5DDD", lng: 139.73896, lat: 35.62851 },
        to: { id: "003335", name: "\u7530\u7AEF", lng: 139.76157, lat: 35.73748 },
        direction: "outer",
        note: "\u74B0\u72B6\u7DDA\u306E\u5916\u56DE\u308A\u5074\uFF08\u54C1\u5DDD\u2192\u5927\u5D0E\u2192\u6E0B\u8C37\u2192\u65B0\u5BBF\u2192\u6C60\u888B\u2192\u7530\u7AEF\uFF09\u3002\u7530\u7AEF\u306E\u30B0\u30EB\u30FC\u30D7\u30B3\u30FC\u30C9003335\u306FN02\u306E\uFF08\u7530\u7AEF, \u5C71\u624B\u7DDA\uFF09\u884C\u3067\u78BA\u8A8D\u6E08\u307F\u3002"
      },
      {
        formalLineName: "\u6771\u5317\u7DDA",
        formalLineKey: "\u6771\u5317\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003335", name: "\u7530\u7AEF", lng: 139.76157, lat: 35.73748 },
        to: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        direction: "outer",
        note: "\u901A\u79F0\u30FB\u6771\u5317\u672C\u7DDA\u3002N02\u306E\u8DEF\u7DDA\u5358\u4F4D\u540D\u306F\u6771\u5317\u7DDA\u3002"
      },
      {
        formalLineName: "\u6771\u6D77\u9053\u7DDA",
        formalLineKey: "\u6771\u6D77\u9053\u7DDA|\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "004095", name: "\u54C1\u5DDD", lng: 139.73896, lat: 35.62851 },
        direction: "outer"
      }
    ],
    blocks: [
      {
        id: "yamanote/b1",
        from: { id: "004095", name: "\u54C1\u5DDD", lng: 139.73896, lat: 35.62851 },
        to: { id: "003922", name: "\u6E0B\u8C37", lng: 139.70165, lat: 35.65898 },
        direction: "outer",
        stations: [
          { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 }
        ]
      },
      {
        id: "yamanote/b2",
        from: { id: "003922", name: "\u6E0B\u8C37", lng: 139.70165, lat: 35.65898 },
        to: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
        direction: "outer"
      },
      {
        id: "yamanote/b3",
        from: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
        to: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        direction: "outer"
      },
      {
        id: "yamanote/b4",
        from: { id: "003390", name: "\u6C60\u888B", lng: 139.71108, lat: 35.72981 },
        to: { id: "003335", name: "\u7530\u7AEF", lng: 139.76157, lat: 35.73748 },
        direction: "outer"
      },
      {
        id: "yamanote/b5",
        from: { id: "003335", name: "\u7530\u7AEF", lng: 139.76157, lat: 35.73748 },
        to: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        direction: "outer"
      },
      {
        id: "yamanote/b6",
        from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
        to: { id: "004095", name: "\u54C1\u5DDD", lng: 139.73896, lat: 35.62851 },
        direction: "outer"
      }
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note: "\u74B0\u72B6\u7DDA\u306E\u305F\u30813\u533A\u9593\u3067\u4E00\u5468\u3092\u8868\u3059\uFF08\u54C1\u5DDD\u2192\u7530\u7AEF\u2192\u6771\u4EAC\u2192\u54C1\u5DDD\u3001\u5916\u56DE\u308A\uFF09\u3002\u79FB\u884C\u3057\u305F\u4E57\u8ECA\uFF08\u5927\u5D0E\u2192\u76EE\u9ED2\uFF09\u306F\u5916\u56DE\u308A\u306E\u89B3\u6E2C\u9806\u3067\u3001\u7AEF\u70B9\u306F\u305D\u306E\u307E\u307E\u4F7F\u3048\u308B\u3002"
  }
];
function serviceById(id) {
  return SERVICE_MASTER.find((entry) => entry.id === id);
}
function stationRefById(stationId) {
  for (const entry of SERVICE_MASTER) {
    for (const segment of entry.segments) {
      if (segment.from.id === stationId)
        return segment.from;
      if (segment.to.id === stationId)
        return segment.to;
    }
    for (const block of entry.blocks) {
      if (block.from.id === stationId)
        return block.from;
      if (block.to.id === stationId)
        return block.to;
      for (const station of block.stations ?? []) {
        if (station.id === stationId)
          return station;
      }
    }
  }
  for (const ride of Object.values(MIGRATED_RIDES)) {
    if (ride.from?.id === stationId)
      return ride.from;
    if (ride.to?.id === stationId)
      return ride.to;
  }
  return;
}
function normalizeParenthesisWidth(name) {
  return name.trim().replace(/\(/g, "\uFF08").replace(/\)/g, "\uFF09").replace(/[ \u3000]+\uFF08/g, "\uFF08").replace(/\uFF09[ \u3000]+/g, "\uFF09");
}
function normalizeParentheses(name) {
  return normalizeParenthesisWidth(name).replace(/\uFF08[ \u3000]+/g, "\uFF08").replace(/[ \u3000]+\uFF09/g, "\uFF09");
}
function bareLedgerName(name) {
  return name.trim().replace(/^(?:JR|\uFF2A\uFF32)/, "");
}
function isRedundantQualifierFor(content, candidate) {
  const q = content.trim();
  if (!q)
    return false;
  const names = [candidate.displayName, ...candidate.ledgerNames];
  if (names.some((n) => bareLedgerName(n) === bareLedgerName(q))) {
    return true;
  }
  const company = q.replace(/^(?:JR|\uFF2A\uFF32)/, "");
  if (!company)
    return false;
  return candidate.operator.startsWith(company) || company.startsWith(candidate.operator);
}
function canonicalLedgerName(name) {
  const unified = normalizeParentheses(name).replace(/^(?:JR|\uFF2A\uFF32)/, "");
  const m = unified.match(/\uFF08([^\uFF09]*)\uFF09$/);
  if (!m)
    return unified;
  const outer = unified.slice(0, m.index);
  const candidate = SERVICE_MASTER.find((entry) => [entry.displayName, ...entry.ledgerNames].some((n) => bareLedgerName(n) === bareLedgerName(outer)));
  if (candidate && isRedundantQualifierFor(m[1], candidate)) {
    return outer;
  }
  return unified;
}
var HISTORICAL_JR_OPERATOR = "\u6771\u65E5\u672C\u65C5\u5BA2\u9244\u9053";
var HISTORICAL_SERVICE_ALIASES = [
  { id: "jr-musashino", ledgerNames: ["JR\u6B66\u8535\u91CE\u7DDA"], operator: HISTORICAL_JR_OPERATOR },
  { id: "hokuso", ledgerNames: ["\u5317\u7DCF\u7DDA"], operator: "\u5317\u7DCF\u9244\u9053" },
  { id: "jr-chuo-rapid", ledgerNames: ["JR\u4E2D\u592E\u7DDA\uFF08\u5FEB\u901F\uFF09", "JR\u4E2D\u592E\u7DDA"], operator: HISTORICAL_JR_OPERATOR },
  { id: "jr-sobu-rapid", ledgerNames: ["JR\u7DCF\u6B66\u5FEB\u901F\u7DDA"], operator: HISTORICAL_JR_OPERATOR },
  { id: "jr-sobu-local", ledgerNames: ["JR\u7DCF\u6B66\u672C\u7DDA"], operator: HISTORICAL_JR_OPERATOR },
  { id: "keio", ledgerNames: ["\u4EAC\u738B\u7DDA"], operator: "\u4EAC\u738B\u96FB\u9244" },
  { id: "jr-saikyo", ledgerNames: ["JR\u57FC\u4EAC\u7DDA"], operator: HISTORICAL_JR_OPERATOR },
  { id: "rinkai", ledgerNames: ["\u308A\u3093\u304B\u3044\u7DDA", "\u81E8\u6D77\u526F\u90FD\u5FC3\u7DDA"], operator: "\u6771\u4EAC\u81E8\u6D77\u9AD8\u901F\u9244\u9053" },
  { id: "yamanote", ledgerNames: ["\u5C71\u624B\u7DDA"], operator: HISTORICAL_JR_OPERATOR }
];
function legacyCanonicalLedgerName(name) {
  return name.trim().replace(/\uFF08[^\uFF09]*\uFF09$/, "").replace(/^(?:JR|\uFF2A\uFF32)/, "");
}
function legacyServiceIdByLedgerName(ledgerName) {
  const name = ledgerName.trim();
  const exact = HISTORICAL_SERVICE_ALIASES.find((entry) => entry.ledgerNames.includes(name));
  if (exact)
    return exact.id;
  const stripped = name.replace(/\uFF08[^\uFF09]*\uFF09$/, "");
  if (stripped !== name) {
    const byStripped = HISTORICAL_SERVICE_ALIASES.find((entry) => entry.ledgerNames.includes(stripped));
    if (byStripped)
      return byStripped.id;
  }
  const canonical = legacyCanonicalLedgerName(name);
  return HISTORICAL_SERVICE_ALIASES.find((entry) => entry.ledgerNames.some((ledgerName) => legacyCanonicalLedgerName(ledgerName) === canonical))?.id;
}
function round4CanonicalLedgerName(name) {
  const unified = bareLedgerName(normalizeParenthesisWidth(name));
  const match = unified.match(/\uFF08([^\uFF09]*)\uFF09$/);
  if (!match)
    return unified;
  const qualifier = match[1].trim();
  const company = bareLedgerName(qualifier);
  const knownQualifier = HISTORICAL_SERVICE_ALIASES.some((entry) => entry.ledgerNames.some((alias) => bareLedgerName(alias) === company) || company && (entry.operator.startsWith(company) || company.startsWith(entry.operator)));
  return knownQualifier ? unified.slice(0, match.index) : unified;
}
function round4ServiceIdByLedgerName(ledgerName) {
  const name = normalizeParenthesisWidth(ledgerName);
  const exact = HISTORICAL_SERVICE_ALIASES.find((entry) => entry.ledgerNames.includes(name));
  if (exact)
    return exact.id;
  const canonical = round4CanonicalLedgerName(name);
  return HISTORICAL_SERVICE_ALIASES.find((entry) => entry.ledgerNames.some((alias) => round4CanonicalLedgerName(alias) === canonical))?.id;
}
function serviceByLedgerName(ledgerName) {
  const name = normalizeParentheses(ledgerName);
  const exact = SERVICE_MASTER.find((entry) => entry.ledgerNames.includes(name));
  if (exact)
    return exact;
  const canonical = canonicalLedgerName(name);
  return SERVICE_MASTER.find((entry) => entry.ledgerNames.some((ledgerName) => canonicalLedgerName(ledgerName) === canonical));
}
var SERVICE_MATCH_VERSION = "3";
function resolveRiddenService(row) {
  if (row.serviceId == null) {
    if (row.serviceLinkSource === "explicit") {
      return { service: undefined, needsReview: false };
    }
    return { service: serviceByLedgerName(row.name), needsReview: false };
  }
  const saved = serviceById(row.serviceId);
  if (saved && (row.serviceLinkSource === "explicit" || serviceByLedgerName(row.name)?.id === saved.id)) {
    return { service: saved, needsReview: false };
  }
  const historicalAutoMatchVersions = [];
  if (row.serviceLinkSource !== "explicit") {
    if ((!row.serviceMatchVersion || row.serviceMatchVersion === "1") && legacyServiceIdByLedgerName(row.name) === row.serviceId) {
      historicalAutoMatchVersions.push("1");
    }
    if ((!row.serviceMatchVersion || row.serviceMatchVersion === "2") && round4ServiceIdByLedgerName(row.name) === row.serviceId) {
      historicalAutoMatchVersions.push("2");
    }
  }
  return { service: undefined, needsReview: true, historicalAutoMatchVersions };
}
function usableRiddenService(row) {
  return row.serviceId ? resolveRiddenService(row).service : undefined;
}
function isExplicitlyUnlinked(row) {
  return row.serviceId == null && row.serviceLinkSource === "explicit";
}
function serviceStationIds(serviceId) {
  const ids = new Set;
  const service = serviceById(serviceId);
  if (service) {
    for (const segment of service.segments) {
      ids.add(segment.from.id);
      ids.add(segment.to.id);
    }
    for (const block of service.blocks) {
      ids.add(block.from.id);
      ids.add(block.to.id);
      for (const station of block.stations ?? [])
        ids.add(station.id);
    }
  }
  for (const ride of Object.values(MIGRATED_RIDES)) {
    if (ride.serviceId !== serviceId)
      continue;
    if (ride.from)
      ids.add(ride.from.id);
    if (ride.to)
      ids.add(ride.to.id);
  }
  return ids;
}
function sectionEndpointsKnownToService(serviceId, fromStationId, toStationId) {
  const known = serviceStationIds(serviceId);
  return known.has(fromStationId) && known.has(toStationId);
}
function sectionRoute(service, fromStationId, toStationId, direction) {
  const loop = serviceIsLoop(service.id);
  const distinctKeys = [...new Set(service.segments.map((s) => s.formalLineKey))];
  if (!loop && distinctKeys.length === 1)
    return distinctKeys;
  if (loop && (!direction || distinctKeys.length === 1))
    return null;
  const boundaries = serviceBoundaryStations(service.id);
  const chainLength = loop ? boundaries.length - 1 : boundaries.length;
  const position = new Map;
  for (let i = 0;i < chainLength; i++) {
    const id = boundaries[i].id;
    if (!position.has(id))
      position.set(id, i);
  }
  const fromPos = position.get(fromStationId);
  const toPos = position.get(toStationId);
  if (fromPos == null || toPos == null || fromPos === toPos)
    return null;
  const reverse = loop ? direction === "inner" : toPos < fromPos;
  const [start, end] = reverse ? [toPos, fromPos] : [fromPos, toPos];
  const forward = (a, b) => loop ? (b - a + chainLength) % chainLength : b - a;
  const route = [];
  const steps = forward(start, end);
  for (let step = 0;step < steps; step++) {
    const blockStart = (start + step) % chainLength;
    const blockEnd = loop ? (blockStart + 1) % chainLength : blockStart + 1;
    const covering = new Set;
    for (const segment of service.segments) {
      const segFrom = position.get(segment.from.id);
      const segTo = position.get(segment.to.id);
      if (segFrom == null || segTo == null)
        continue;
      const span = forward(segFrom, segTo);
      const offset = forward(segFrom, blockStart);
      if (offset >= 0 && offset < span && forward(segFrom, blockEnd) === offset + 1) {
        covering.add(segment.formalLineKey);
      }
    }
    if (covering.size !== 1)
      return null;
    const key = [...covering][0];
    if (route.at(-1) !== key) {
      if (route.length > 0)
        route.push(boundaries[blockStart].id);
      route.push(key);
    }
  }
  return reverse ? route.reverse() : route;
}
function sectionRouteAmbiguous(serviceId, fromStationId, toStationId, direction = null) {
  const service = serviceById(serviceId);
  if (!service || fromStationId === toStationId)
    return true;
  if (serviceIsLoop(serviceId) && !direction)
    return true;
  const own = sectionRoute(service, fromStationId, toStationId, direction);
  for (const other of SERVICE_MASTER) {
    if (other.id === serviceId)
      continue;
    if (!sectionEndpointsKnownToService(other.id, fromStationId, toStationId)) {
      continue;
    }
    const rival = sectionRoute(other, fromStationId, toStationId, direction);
    if (!own || !rival || own.length !== rival.length || own.some((part, index) => part !== rival[index])) {
      return true;
    }
  }
  return false;
}
function recordedSectionFitsService(serviceId, section) {
  const { fromStationId, toStationId, direction, blockId, recordedServiceId } = section;
  if (fromStationId === toStationId || !sectionEndpointsKnownToService(serviceId, fromStationId, toStationId)) {
    return false;
  }
  if (blockId != null) {
    const block = blockById(serviceId, blockId);
    return block != null && (block.from.id === fromStationId && block.to.id === toStationId || block.from.id === toStationId && block.to.id === fromStationId);
  }
  return recordedServiceId === serviceId || !sectionRouteAmbiguous(serviceId, fromStationId, toStationId, direction);
}
function isRiddenServiceLinkReviewable(row) {
  if (resolveRiddenService(row).needsReview)
    return true;
  return row.serviceId == null && row.serviceLinkSource === "explicit";
}
function blocksForService(serviceId) {
  return serviceById(serviceId)?.blocks ?? [];
}
function blockById(serviceId, blockId) {
  return blocksForService(serviceId).find((block) => block.id === blockId);
}
function serviceBoundaryStations(serviceId) {
  const blocks = blocksForService(serviceId);
  if (blocks.length === 0)
    return [];
  const stations = [blocks[0].from];
  for (const block of blocks)
    stations.push(block.to);
  return stations;
}
function serviceOrderedStations(serviceId) {
  const blocks = blocksForService(serviceId);
  if (blocks.length === 0)
    return [];
  const stations = [];
  const push = (station) => {
    if (stations[stations.length - 1]?.id !== station.id) {
      stations.push(station);
    }
  };
  for (const block of blocks) {
    push(block.from);
    for (const station of block.stations ?? [])
      push(station);
    push(block.to);
  }
  return stations;
}
function serviceIsLoop(serviceId) {
  const boundaries = serviceBoundaryStations(serviceId);
  return boundaries.length > 1 && boundaries[0].id === boundaries[boundaries.length - 1].id;
}
function validateSectionEndpoints(serviceId, fromStationId, toStationId, direction) {
  const service = serviceById(serviceId);
  if (!service)
    return `unknown service "${serviceId}"`;
  if (fromStationId === toStationId) {
    return "a section needs two different stations";
  }
  const ordered = serviceOrderedStations(serviceId);
  const fromIndex = ordered.findIndex((s) => s.id === fromStationId);
  const toIndex = ordered.findIndex((s) => s.id === toStationId);
  if (fromIndex < 0) {
    return `"${fromStationId}" is not a station of ${service.displayName}`;
  }
  if (toIndex < 0) {
    return `"${toStationId}" is not a station of ${service.displayName}`;
  }
  if (serviceIsLoop(serviceId)) {
    if (!direction) {
      return `${service.displayName} is a loop: a section needs a direction (inner/outer)`;
    }
    return null;
  }
  return null;
}
function serviceFullPathSnapshot(serviceId) {
  const service = serviceById(serviceId);
  if (!service)
    return null;
  return {
    pathId: service.pathId,
    masterVersion: SERVICE_MASTER_VERSION,
    segments: service.segments.map((segment) => ({
      formalLineKey: segment.formalLineKey,
      from: segment.from,
      to: segment.to,
      ...segment.direction ? { direction: segment.direction } : {},
      ...segment.approximate ? { approximate: true } : {}
    }))
  };
}
var MIGRATED_MASTER_VERSION = "2026-11-24";
function isKnownMasterVersion(version) {
  const v = version.trim();
  return v === SERVICE_MASTER_VERSION || v === MIGRATED_MASTER_VERSION;
}
var MIGRATED_RIDES = {
  "JR\u6B66\u8535\u91CE\u7DDA": {
    serviceId: "jr-musashino",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "\u5317\u7DCF\u7DDA": {
    serviceId: "hokuso",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "JR\u4E2D\u592E\u7DDA\uFF08\u5FEB\u901F\uFF09": {
    serviceId: "jr-chuo-rapid",
    rideState: "partial",
    from: { id: "003606", name: "\u56FD\u5206\u5BFA", lng: 139.48013, lat: 35.70045 },
    to: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "JR\u7DCF\u6B66\u5FEB\u901F\u7DDA": {
    serviceId: "jr-sobu-rapid",
    rideState: "partial",
    from: { id: "003766", name: "\u6771\u4EAC", lng: 139.76675, lat: 35.68128 },
    to: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "JR\u7DCF\u6B66\u672C\u7DDA": {
    serviceId: "jr-sobu-local",
    rideState: "partial",
    from: { id: "003531", name: "\u4F50\u5009", lng: 140.22675, lat: 35.70974 },
    to: { id: "004173", name: "\u5343\u8449", lng: 140.1136, lat: 35.61275 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "\u4EAC\u738B\u7DDA": {
    serviceId: "keio",
    rideState: "partial",
    from: { id: "003821", name: "\u5E9C\u4E2D", lng: 139.4801, lat: 35.67219 },
    to: { id: "003971", name: "\u8056\u8E5F\u685C\u30F6\u4E18", lng: 139.44687, lat: 35.65079 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "JR\u57FC\u4EAC\u7DDA": {
    serviceId: "jr-saikyo",
    rideState: "partial",
    from: { id: "003700", name: "\u65B0\u5BBF", lng: 139.69993, lat: 35.6898 },
    to: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "\u308A\u3093\u304B\u3044\u7DDA": {
    serviceId: "rinkai",
    rideState: "partial",
    from: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 },
    to: { id: "004182", name: "\u54C1\u5DDD\u30B7\u30FC\u30B5\u30A4\u30C9", lng: 139.7498, lat: 35.60979 },
    masterVersion: MIGRATED_MASTER_VERSION
  },
  "\u5C71\u624B\u7DDA": {
    serviceId: "yamanote",
    rideState: "partial",
    from: { id: "004135", name: "\u5927\u5D0E", lng: 139.72807, lat: 35.61985 },
    to: { id: "004072", name: "\u76EE\u9ED2", lng: 139.71568, lat: 35.63272 },
    masterVersion: MIGRATED_MASTER_VERSION
  }
};

// ../node_modules/drizzle-orm/sqlite-core/foreign-keys.js
class ForeignKeyBuilder {
  static [entityKind] = "SQLiteForeignKeyBuilder";
  reference;
  _onUpdate;
  _onDelete;
  constructor(config, actions) {
    this.reference = () => {
      const { name, columns, foreignColumns } = config();
      return { name, columns, foreignTable: foreignColumns[0].table, foreignColumns };
    };
    if (actions) {
      this._onUpdate = actions.onUpdate;
      this._onDelete = actions.onDelete;
    }
  }
  onUpdate(action) {
    this._onUpdate = action;
    return this;
  }
  onDelete(action) {
    this._onDelete = action;
    return this;
  }
  build(table) {
    return new ForeignKey(table, this);
  }
}

class ForeignKey {
  constructor(table, builder) {
    this.table = table;
    this.reference = builder.reference;
    this.onUpdate = builder._onUpdate;
    this.onDelete = builder._onDelete;
  }
  static [entityKind] = "SQLiteForeignKey";
  reference;
  onUpdate;
  onDelete;
  getName() {
    const { name, columns, foreignColumns } = this.reference();
    const columnNames = columns.map((column) => column.name);
    const foreignColumnNames = foreignColumns.map((column) => column.name);
    const chunks = [
      this.table[TableName],
      ...columnNames,
      foreignColumns[0].table[TableName],
      ...foreignColumnNames
    ];
    return name ?? `${chunks.join("_")}_fk`;
  }
}

// ../node_modules/drizzle-orm/sqlite-core/unique-constraint.js
function uniqueKeyName(table, columns) {
  return `${table[TableName]}_${columns.join("_")}_unique`;
}

// ../node_modules/drizzle-orm/sqlite-core/columns/common.js
class SQLiteColumnBuilder extends ColumnBuilder {
  static [entityKind] = "SQLiteColumnBuilder";
  foreignKeyConfigs = [];
  references(ref, actions = {}) {
    this.foreignKeyConfigs.push({ ref, actions });
    return this;
  }
  unique(name) {
    this.config.isUnique = true;
    this.config.uniqueName = name;
    return this;
  }
  generatedAlwaysAs(as, config) {
    this.config.generated = {
      as,
      type: "always",
      mode: config?.mode ?? "virtual"
    };
    return this;
  }
  buildForeignKeys(column, table) {
    return this.foreignKeyConfigs.map(({ ref, actions }) => {
      return ((ref2, actions2) => {
        const builder = new ForeignKeyBuilder(() => {
          const foreignColumn = ref2();
          return { columns: [column], foreignColumns: [foreignColumn] };
        });
        if (actions2.onUpdate) {
          builder.onUpdate(actions2.onUpdate);
        }
        if (actions2.onDelete) {
          builder.onDelete(actions2.onDelete);
        }
        return builder.build(table);
      })(ref, actions);
    });
  }
}

class SQLiteColumn extends Column {
  constructor(table, config) {
    if (!config.uniqueName) {
      config.uniqueName = uniqueKeyName(table, [config.name]);
    }
    super(table, config);
    this.table = table;
  }
  static [entityKind] = "SQLiteColumn";
}

// ../node_modules/drizzle-orm/sqlite-core/columns/blob.js
class SQLiteBigIntBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBigIntBuilder";
  constructor(name) {
    super(name, "bigint", "SQLiteBigInt");
  }
  build(table) {
    return new SQLiteBigInt(table, this.config);
  }
}

class SQLiteBigInt extends SQLiteColumn {
  static [entityKind] = "SQLiteBigInt";
  getSQLType() {
    return "blob";
  }
  mapFromDriverValue(value) {
    if (typeof Buffer !== "undefined" && Buffer.from) {
      const buf = Buffer.isBuffer(value) ? value : value instanceof ArrayBuffer ? Buffer.from(value) : value.buffer ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      return BigInt(buf.toString("utf8"));
    }
    return BigInt(textDecoder.decode(value));
  }
  mapToDriverValue(value) {
    return Buffer.from(value.toString());
  }
}

class SQLiteBlobJsonBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBlobJsonBuilder";
  constructor(name) {
    super(name, "json", "SQLiteBlobJson");
  }
  build(table) {
    return new SQLiteBlobJson(table, this.config);
  }
}

class SQLiteBlobJson extends SQLiteColumn {
  static [entityKind] = "SQLiteBlobJson";
  getSQLType() {
    return "blob";
  }
  mapFromDriverValue(value) {
    if (typeof Buffer !== "undefined" && Buffer.from) {
      const buf = Buffer.isBuffer(value) ? value : value instanceof ArrayBuffer ? Buffer.from(value) : value.buffer ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      return JSON.parse(buf.toString("utf8"));
    }
    return JSON.parse(textDecoder.decode(value));
  }
  mapToDriverValue(value) {
    return Buffer.from(JSON.stringify(value));
  }
}

class SQLiteBlobBufferBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBlobBufferBuilder";
  constructor(name) {
    super(name, "buffer", "SQLiteBlobBuffer");
  }
  build(table) {
    return new SQLiteBlobBuffer(table, this.config);
  }
}

class SQLiteBlobBuffer extends SQLiteColumn {
  static [entityKind] = "SQLiteBlobBuffer";
  mapFromDriverValue(value) {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    return Buffer.from(value);
  }
  getSQLType() {
    return "blob";
  }
}
function blob(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config?.mode === "json") {
    return new SQLiteBlobJsonBuilder(name);
  }
  if (config?.mode === "bigint") {
    return new SQLiteBigIntBuilder(name);
  }
  return new SQLiteBlobBufferBuilder(name);
}

// ../node_modules/drizzle-orm/sqlite-core/columns/custom.js
class SQLiteCustomColumnBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteCustomColumnBuilder";
  constructor(name, fieldConfig, customTypeParams) {
    super(name, "custom", "SQLiteCustomColumn");
    this.config.fieldConfig = fieldConfig;
    this.config.customTypeParams = customTypeParams;
  }
  build(table) {
    return new SQLiteCustomColumn(table, this.config);
  }
}

class SQLiteCustomColumn extends SQLiteColumn {
  static [entityKind] = "SQLiteCustomColumn";
  sqlName;
  mapTo;
  mapFrom;
  constructor(table, config) {
    super(table, config);
    this.sqlName = config.customTypeParams.dataType(config.fieldConfig);
    this.mapTo = config.customTypeParams.toDriver;
    this.mapFrom = config.customTypeParams.fromDriver;
  }
  getSQLType() {
    return this.sqlName;
  }
  mapFromDriverValue(value) {
    return typeof this.mapFrom === "function" ? this.mapFrom(value) : value;
  }
  mapToDriverValue(value) {
    return typeof this.mapTo === "function" ? this.mapTo(value) : value;
  }
}
function customType(customTypeParams) {
  return (a, b) => {
    const { name, config } = getColumnNameAndConfig(a, b);
    return new SQLiteCustomColumnBuilder(name, config, customTypeParams);
  };
}

// ../node_modules/drizzle-orm/sqlite-core/columns/integer.js
class SQLiteBaseIntegerBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteBaseIntegerBuilder";
  constructor(name, dataType, columnType) {
    super(name, dataType, columnType);
    this.config.autoIncrement = false;
  }
  primaryKey(config) {
    if (config?.autoIncrement) {
      this.config.autoIncrement = true;
    }
    this.config.hasDefault = true;
    return super.primaryKey();
  }
}

class SQLiteBaseInteger extends SQLiteColumn {
  static [entityKind] = "SQLiteBaseInteger";
  autoIncrement = this.config.autoIncrement;
  getSQLType() {
    return "integer";
  }
}

class SQLiteIntegerBuilder extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteIntegerBuilder";
  constructor(name) {
    super(name, "number", "SQLiteInteger");
  }
  build(table) {
    return new SQLiteInteger(table, this.config);
  }
}

class SQLiteInteger extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteInteger";
}

class SQLiteTimestampBuilder extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteTimestampBuilder";
  constructor(name, mode) {
    super(name, "date", "SQLiteTimestamp");
    this.config.mode = mode;
  }
  defaultNow() {
    return this.default(sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`);
  }
  build(table) {
    return new SQLiteTimestamp(table, this.config);
  }
}

class SQLiteTimestamp extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteTimestamp";
  mode = this.config.mode;
  mapFromDriverValue(value) {
    if (this.config.mode === "timestamp") {
      return new Date(value * 1000);
    }
    return new Date(value);
  }
  mapToDriverValue(value) {
    const unix = value.getTime();
    if (this.config.mode === "timestamp") {
      return Math.floor(unix / 1000);
    }
    return unix;
  }
}

class SQLiteBooleanBuilder extends SQLiteBaseIntegerBuilder {
  static [entityKind] = "SQLiteBooleanBuilder";
  constructor(name, mode) {
    super(name, "boolean", "SQLiteBoolean");
    this.config.mode = mode;
  }
  build(table) {
    return new SQLiteBoolean(table, this.config);
  }
}

class SQLiteBoolean extends SQLiteBaseInteger {
  static [entityKind] = "SQLiteBoolean";
  mode = this.config.mode;
  mapFromDriverValue(value) {
    return Number(value) === 1;
  }
  mapToDriverValue(value) {
    return value ? 1 : 0;
  }
}
function integer2(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config?.mode === "timestamp" || config?.mode === "timestamp_ms") {
    return new SQLiteTimestampBuilder(name, config.mode);
  }
  if (config?.mode === "boolean") {
    return new SQLiteBooleanBuilder(name, config.mode);
  }
  return new SQLiteIntegerBuilder(name);
}

// ../node_modules/drizzle-orm/sqlite-core/columns/numeric.js
class SQLiteNumericBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericBuilder";
  constructor(name) {
    super(name, "string", "SQLiteNumeric");
  }
  build(table) {
    return new SQLiteNumeric(table, this.config);
  }
}

class SQLiteNumeric extends SQLiteColumn {
  static [entityKind] = "SQLiteNumeric";
  mapFromDriverValue(value) {
    if (typeof value === "string")
      return value;
    return String(value);
  }
  getSQLType() {
    return "numeric";
  }
}

class SQLiteNumericNumberBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericNumberBuilder";
  constructor(name) {
    super(name, "number", "SQLiteNumericNumber");
  }
  build(table) {
    return new SQLiteNumericNumber(table, this.config);
  }
}

class SQLiteNumericNumber extends SQLiteColumn {
  static [entityKind] = "SQLiteNumericNumber";
  mapFromDriverValue(value) {
    if (typeof value === "number")
      return value;
    return Number(value);
  }
  mapToDriverValue = String;
  getSQLType() {
    return "numeric";
  }
}

class SQLiteNumericBigIntBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteNumericBigIntBuilder";
  constructor(name) {
    super(name, "bigint", "SQLiteNumericBigInt");
  }
  build(table) {
    return new SQLiteNumericBigInt(table, this.config);
  }
}

class SQLiteNumericBigInt extends SQLiteColumn {
  static [entityKind] = "SQLiteNumericBigInt";
  mapFromDriverValue = BigInt;
  mapToDriverValue = String;
  getSQLType() {
    return "numeric";
  }
}
function numeric(a, b) {
  const { name, config } = getColumnNameAndConfig(a, b);
  const mode = config?.mode;
  return mode === "number" ? new SQLiteNumericNumberBuilder(name) : mode === "bigint" ? new SQLiteNumericBigIntBuilder(name) : new SQLiteNumericBuilder(name);
}

// ../node_modules/drizzle-orm/sqlite-core/columns/real.js
class SQLiteRealBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteRealBuilder";
  constructor(name) {
    super(name, "number", "SQLiteReal");
  }
  build(table) {
    return new SQLiteReal(table, this.config);
  }
}

class SQLiteReal extends SQLiteColumn {
  static [entityKind] = "SQLiteReal";
  getSQLType() {
    return "real";
  }
}
function real(name) {
  return new SQLiteRealBuilder(name ?? "");
}

// ../node_modules/drizzle-orm/sqlite-core/columns/text.js
class SQLiteTextBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteTextBuilder";
  constructor(name, config) {
    super(name, "string", "SQLiteText");
    this.config.enumValues = config.enum;
    this.config.length = config.length;
  }
  build(table) {
    return new SQLiteText(table, this.config);
  }
}

class SQLiteText extends SQLiteColumn {
  static [entityKind] = "SQLiteText";
  enumValues = this.config.enumValues;
  length = this.config.length;
  constructor(table, config) {
    super(table, config);
  }
  getSQLType() {
    return `text${this.config.length ? `(${this.config.length})` : ""}`;
  }
}

class SQLiteTextJsonBuilder extends SQLiteColumnBuilder {
  static [entityKind] = "SQLiteTextJsonBuilder";
  constructor(name) {
    super(name, "json", "SQLiteTextJson");
  }
  build(table) {
    return new SQLiteTextJson(table, this.config);
  }
}

class SQLiteTextJson extends SQLiteColumn {
  static [entityKind] = "SQLiteTextJson";
  getSQLType() {
    return "text";
  }
  mapFromDriverValue(value) {
    return JSON.parse(value);
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
}
function text(a, b = {}) {
  const { name, config } = getColumnNameAndConfig(a, b);
  if (config.mode === "json") {
    return new SQLiteTextJsonBuilder(name);
  }
  return new SQLiteTextBuilder(name, config);
}

// ../node_modules/drizzle-orm/sqlite-core/columns/all.js
function getSQLiteColumnBuilders() {
  return {
    blob,
    customType,
    integer: integer2,
    numeric,
    real,
    text
  };
}

// ../node_modules/drizzle-orm/sqlite-core/table.js
var InlineForeignKeys = Symbol.for("drizzle:SQLiteInlineForeignKeys");

class SQLiteTable extends Table {
  static [entityKind] = "SQLiteTable";
  static Symbol = Object.assign({}, Table.Symbol, {
    InlineForeignKeys
  });
  [Table.Symbol.Columns];
  [InlineForeignKeys] = [];
  [Table.Symbol.ExtraConfigBuilder] = undefined;
}
function sqliteTableBase(name, columns, extraConfig, schema, baseName = name) {
  const rawTable = new SQLiteTable(name, schema, baseName);
  const parsedColumns = typeof columns === "function" ? columns(getSQLiteColumnBuilders()) : columns;
  const builtColumns = Object.fromEntries(Object.entries(parsedColumns).map(([name2, colBuilderBase]) => {
    const colBuilder = colBuilderBase;
    colBuilder.setName(name2);
    const column = colBuilder.build(rawTable);
    rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
    return [name2, column];
  }));
  const table = Object.assign(rawTable, builtColumns);
  table[Table.Symbol.Columns] = builtColumns;
  table[Table.Symbol.ExtraConfigColumns] = builtColumns;
  if (extraConfig) {
    table[SQLiteTable.Symbol.ExtraConfigBuilder] = extraConfig;
  }
  return table;
}
var sqliteTable = (name, columns, extraConfig) => {
  return sqliteTableBase(name, columns, extraConfig);
};

// ../node_modules/drizzle-orm/sqlite-core/indexes.js
class IndexBuilderOn {
  constructor(name, unique) {
    this.name = name;
    this.unique = unique;
  }
  static [entityKind] = "SQLiteIndexBuilderOn";
  on(...columns) {
    return new IndexBuilder(this.name, columns, this.unique);
  }
}

class IndexBuilder {
  static [entityKind] = "SQLiteIndexBuilder";
  config;
  constructor(name, columns, unique) {
    this.config = {
      name,
      columns,
      unique,
      where: undefined
    };
  }
  where(condition) {
    this.config.where = condition;
    return this;
  }
  build(table) {
    return new Index(this.config, table);
  }
}

class Index {
  static [entityKind] = "SQLiteIndex";
  config;
  constructor(config, table) {
    this.config = { ...config, table };
  }
}
function uniqueIndex(name) {
  return new IndexBuilderOn(name, true);
}

// src/schema.ts
var spots = sqliteTable("spots", {
  id: integer2("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  url: text("url"),
  address: text("address"),
  category: text("category").notNull().default("\u884C\u3063\u3066\u307F\u305F\u3044"),
  tags: text("tags").notNull().default("[]"),
  lat: real("lat"),
  lng: real("lng"),
  visited: integer2("visited").notNull().default(0),
  visitedAt: integer2("visited_at", { mode: "timestamp_ms" }),
  createdAt: integer2("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date)
});
var visitedMunicipalities = sqliteTable("visited_municipalities", {
  id: integer2("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  prefecture: text("prefecture").notNull(),
  area: text("area"),
  context: text("context"),
  visitedOn: text("visited_on").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  geometry: text("geometry"),
  createdAt: integer2("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date)
});
var riddenLines = sqliteTable("ridden_lines", {
  id: integer2("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  firstRiddenOn: text("first_ridden_on").notNull(),
  note: text("note"),
  context: text("context"),
  serviceId: text("service_id"),
  recordedServiceId: text("recorded_service_id"),
  serviceLinkSource: text("service_link_source", { enum: ["auto", "explicit"] }),
  serviceMatchVersion: text("service_match_version"),
  rideState: text("ride_state").notNull().default("unknown"),
  fromStationId: text("from_station_id"),
  fromStationName: text("from_station_name"),
  toStationId: text("to_station_id"),
  toStationName: text("to_station_name"),
  masterVersion: text("master_version"),
  pathSnapshot: text("path_snapshot"),
  createdAt: integer2("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date)
});
var riddenLineSections = sqliteTable("ridden_line_sections", {
  id: integer2("id").primaryKey({ autoIncrement: true }),
  riddenLineId: integer2("ridden_line_id").notNull(),
  fromStationId: text("from_station_id").notNull(),
  fromStationName: text("from_station_name"),
  toStationId: text("to_station_id").notNull(),
  toStationName: text("to_station_name"),
  direction: text("direction"),
  blockId: text("block_id"),
  recordedServiceId: text("recorded_service_id"),
  createdAt: integer2("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date)
}, (t) => [
  uniqueIndex("ridden_line_sections_unique_section").on(t.riddenLineId, t.fromStationId, t.toStationId, sql`COALESCE(${t.direction}, '')`)
]);
var settings = sqliteTable("settings", {
  id: integer2("id").primaryKey(),
  radiusM: integer2("radius_m").notNull().default(500),
  memoTeaseEnabled: integer2("memo_tease_enabled").notNull().default(1),
  memoTeaseTemplate: text("memo_tease_template").notNull().default("\u300C{\u30E1\u30E2}\u300D\u3063\u3066\u66F8\u3044\u3066\u3042\u3063\u305F\u3051\u3069\u3001\u3053\u3093\u306A\u306E\u6C17\u306B\u306A\u3063\u3061\u3083\u3063\u3066\u308B\u306E\u301C\uFF1F\u3056\u3041\u3053\u2661"),
  deviceLat: real("device_lat"),
  deviceLng: real("device_lng"),
  deviceLocAt: integer2("device_loc_at", { mode: "timestamp_ms" })
});

// src/actions.ts
var rideStateSchema = _enum(["unknown", "partial", "full"]);
var riddenSectionSchema = object({
  id: number2(),
  fromStationId: string2(),
  fromStationName: string2().nullable(),
  toStationId: string2(),
  toStationName: string2().nullable(),
  direction: _enum(["inner", "outer"]).nullable(),
  blockId: string2().nullable(),
  recordedServiceId: string2().nullable()
});
var rideFieldsSchema = object({
  serviceId: string2().max(100).nullable().optional(),
  rideState: rideStateSchema.nullable().optional(),
  fromStationId: string2().max(20).nullable().optional(),
  fromStationName: string2().max(100).nullable().optional(),
  toStationId: string2().max(20).nullable().optional(),
  toStationName: string2().max(100).nullable().optional(),
  masterVersion: string2().max(50).nullable().optional()
});
function resolveRideFields(name, supplied) {
  const { service } = resolveRiddenService({
    name,
    serviceId: supplied.serviceId
  });
  if (supplied.serviceId != null && !service) {
    if (!serviceById(supplied.serviceId)) {
      throw new Error(`resolveRideFields: unknown serviceId "${supplied.serviceId}" for "${name}"`);
    }
    throw new Error(`resolveRideFields: serviceId "${supplied.serviceId}" does not match "${name}"`);
  }
  const link = {
    serviceId: service?.id ?? null,
    serviceLinkSource: supplied.serviceId != null ? "explicit" : "auto",
    serviceMatchVersion: supplied.serviceId != null ? null : SERVICE_MATCH_VERSION
  };
  const rideState = supplied.rideState ?? (supplied.fromStationId?.trim() && supplied.toStationId?.trim() ? "partial" : "unknown");
  const masterVersion = supplied.masterVersion != null ? supplied.masterVersion.trim() : service ? SERVICE_MASTER_VERSION : null;
  if (rideState === "unknown") {
    return {
      ...link,
      recordedServiceId: null,
      rideState: "unknown",
      fromStationId: null,
      fromStationName: null,
      toStationId: null,
      toStationName: null,
      masterVersion,
      pathSnapshot: null
    };
  }
  if (rideState === "partial") {
    if (!service) {
      throw new Error(`resolveRideFields: partial ride for "${name}" needs a known service`);
    }
    if (!supplied.fromStationId?.trim() || !supplied.toStationId?.trim()) {
      throw new Error(`resolveRideFields: partial ride for "${name}" needs both endpoint station IDs`);
    }
    const fromStationId = supplied.fromStationId.trim();
    const toStationId = supplied.toStationId.trim();
    if (!isN02StationId(fromStationId) || !isN02StationId(toStationId)) {
      throw new Error(`resolveRideFields: partial ride for "${name}" needs N02 station IDs (six-digit group codes)`);
    }
    if (fromStationId === toStationId) {
      throw new Error(`resolveRideFields: partial ride for "${name}" needs two different stations`);
    }
    return {
      ...link,
      recordedServiceId: service.id,
      rideState: "partial",
      fromStationId,
      fromStationName: supplied.fromStationName?.trim() || null,
      toStationId,
      toStationName: supplied.toStationName?.trim() || null,
      masterVersion,
      pathSnapshot: null
    };
  }
  if (!service) {
    throw new Error(`resolveRideFields: full ride for "${name}" needs a known service`);
  }
  if (!masterVersion || !isKnownMasterVersion(masterVersion)) {
    throw new Error(`resolveRideFields: full ride for "${name}" needs a known master version (got ${JSON.stringify(masterVersion)})`);
  }
  const snapshot = masterVersion === SERVICE_MASTER_VERSION ? serviceFullPathSnapshot(service.id) : null;
  return {
    ...link,
    recordedServiceId: service.id,
    rideState: "full",
    fromStationId: null,
    fromStationName: null,
    toStationId: null,
    toStationName: null,
    masterVersion,
    pathSnapshot: snapshot ? JSON.stringify(snapshot) : null
  };
}
function riddenServiceBackfill(name) {
  const link = resolveRideFields(name, {});
  if (!link.serviceId)
    return;
  return {
    serviceId: link.serviceId,
    serviceLinkSource: link.serviceLinkSource,
    serviceMatchVersion: link.serviceMatchVersion,
    masterVersion: sql`coalesce(${riddenLines.masterVersion}, ${link.masterVersion})`
  };
}
function isUniqueConstraintError(error) {
  let current = error;
  for (let depth = 0;depth < 8 && current != null; depth++) {
    if (current instanceof Error && current.message.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
function riddenLinkFitProblem(line, sections, targetServiceId) {
  if (targetServiceId == null)
    return null;
  const target = serviceById(targetServiceId);
  if (!target)
    return null;
  const state = normalizeRideState(line.rideState);
  if (state === "full") {
    let snapshotPathId = null;
    if (line.pathSnapshot) {
      try {
        const parsed = JSON.parse(line.pathSnapshot);
        if (typeof parsed?.pathId === "string")
          snapshotPathId = parsed.pathId;
      } catch {}
    }
    const fits = snapshotPathId ? snapshotPathId === target.pathId : (line.recordedServiceId ?? line.serviceId) === target.id;
    return fits ? null : `the recorded full ride's path cannot be attributed to ${target.displayName}`;
  }
  const pairs = sections.map((section) => ({
    ...section,
    direction: normalizeSectionDirection(section.direction)
  }));
  if (state === "partial" && line.fromStationId && line.toStationId) {
    pairs.unshift({
      fromStationId: line.fromStationId,
      toStationId: line.toStationId,
      direction: null,
      blockId: null,
      recordedServiceId: line.recordedServiceId
    });
  }
  for (const section of pairs) {
    if (recordedSectionFitsService(target.id, section))
      continue;
    if (!sectionEndpointsKnownToService(target.id, section.fromStationId, section.toStationId)) {
      return `the recorded section's endpoints are not known stations of ${target.displayName}`;
    }
    if (section.blockId != null) {
      return `the recorded section's block ${section.blockId} does not fit ${target.displayName}`;
    }
    return `the recorded section's route cannot be determined for ${target.displayName} from its endpoints and direction`;
  }
  return null;
}
function normalizeRideState(raw) {
  if (raw === "partial" || raw === "full")
    return raw;
  return "unknown";
}
function normalizeSectionDirection(raw) {
  return raw === "inner" || raw === "outer" ? raw : null;
}
var spotSchema = object({
  id: number2(),
  name: string2(),
  note: string2().nullable(),
  url: string2().nullable(),
  address: string2().nullable(),
  category: string2(),
  tags: array(string2()),
  lat: number2().nullable(),
  lng: number2().nullable(),
  visited: boolean2(),
  visited_at: string2().nullable(),
  created_at: string2()
});
function parseTags(raw) {
  if (!raw)
    return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
      return [];
    return parsed.filter((t) => typeof t === "string" && t.trim() !== "");
  } catch {
    return [];
  }
}
function normalizeTags(tags) {
  if (!tags)
    return [];
  const seen = new Set;
  const out = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function encodeTags(tags) {
  return JSON.stringify(normalizeTags(tags));
}
function sameTags(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
var tagsInput = array(string2().min(1).max(100)).max(50);
var geoPosition = array(number2().min(-180).max(180)).min(2).max(2);
var geoRing = array(geoPosition).min(4).max(20000);
var geoPolygon = array(geoRing).min(1).max(100);
var geoJsonGeometrySchema = union([
  object({ type: literal("Polygon"), coordinates: geoPolygon }),
  object({ type: literal("MultiPolygon"), coordinates: array(geoPolygon).min(1).max(500) })
]);
function parseGeometry(raw) {
  if (!raw)
    return null;
  try {
    const parsed = geoJsonGeometrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function encodeGeometry(geometry) {
  return geometry ? JSON.stringify(geometry) : null;
}
async function resolveMunicipalityPoint(prefecture, name) {
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ja&q=" + encodeURIComponent(`${prefecture} ${name}`);
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-want-to-go-spots/1.0" }
    });
    if (!res.ok)
      return null;
    const data = await res.json();
    if (!Array.isArray(data))
      return null;
    const first = data[0];
    if (typeof first !== "object" || first === null)
      return null;
    const rec = first;
    const lat = Number(rec.lat);
    const lng = Number(rec.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return null;
    return { lat, lng };
  } catch {
    return null;
  }
}
var listSpotSchema = spotSchema.extend({
  distance_km: number2().nullable().optional()
});
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function toSpot(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    url: row.url,
    address: row.address,
    category: row.category,
    tags: parseTags(row.tags),
    lat: row.lat,
    lng: row.lng,
    visited: row.visited === 1,
    visited_at: row.visitedAt ? row.visitedAt.toISOString() : null,
    created_at: row.createdAt.toISOString()
  };
}
var okResponse = object({ ok: literal(true) });
var DEFAULT_LIST = "\u884C\u3063\u3066\u307F\u305F\u3044";
function normalizeList(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_LIST;
}
var Actions = {
  getStats: defineAction({
    description: "Returns spot totals: all spots, visited count, remaining count, and how many have coordinates for proximity checks.",
    request: object({}),
    response: object({
      total: number2(),
      visited: number2(),
      remaining: number2(),
      withCoords: number2(),
      withMemo: number2()
    }),
    async handler(ctx) {
      const db = ctx.db();
      const totalRows = await db.select({ n: count() }).from(spots);
      const visitedRows = await db.select({ n: count() }).from(spots).where(eq(spots.visited, 1));
      const coordRows = await db.select({ n: count() }).from(spots).where(and(isNotNull(spots.lat), isNotNull(spots.lng)));
      const memoRows = await db.select({ n: count() }).from(spots).where(and(isNotNull(spots.note), sql`${spots.note} <> ''`));
      const total = totalRows[0]?.n ?? 0;
      const visited = visitedRows[0]?.n ?? 0;
      return {
        total,
        visited,
        remaining: total - visited,
        withCoords: coordRows[0]?.n ?? 0,
        withMemo: memoRows[0]?.n ?? 0
      };
    }
  }),
  listSpotPoints: defineAction({
    description: "Returns every spot that has coordinates for the spot list's pinned map, with the detail fields that identify each plotted spot (id, name, list name, memo truncated to 200 chars, url, address, tags, visited).",
    request: object({}),
    response: object({
      points: array(object({
        id: number2(),
        lat: number2(),
        lng: number2(),
        name: string2(),
        category: string2(),
        note: string2().nullable(),
        url: string2().nullable(),
        address: string2().nullable(),
        tags: array(string2()),
        visited: boolean2()
      }))
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(spots).where(and(isNotNull(spots.lat), isNotNull(spots.lng)));
      return {
        points: rows.filter((r) => r.lat !== null && r.lng !== null).map((r) => ({
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          name: r.name,
          note: r.note ? r.note.slice(0, 200) : null,
          url: r.url,
          address: r.address,
          category: r.category,
          tags: parseTags(r.tags),
          visited: r.visited === 1
        }))
      };
    }
  }),
  listLists: defineAction({
    description: "Lists every spot list (Google Maps list name) with its total and visited counts, biggest first.",
    request: object({}),
    response: object({
      lists: array(object({
        name: string2(),
        total: number2(),
        visited: number2()
      }))
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select({
        name: spots.category,
        total: count(),
        visited: sql`coalesce(sum(case when ${spots.visited} = 1 then 1 else 0 end), 0)`
      }).from(spots).groupBy(spots.category).orderBy(desc(count()));
      return {
        lists: rows.map((r) => ({
          name: r.name,
          total: r.total,
          visited: Number(r.visited)
        }))
      };
    }
  }),
  listTags: defineAction({
    description: "Lists every tag in use across all spots with the number of spots carrying it, most-used first.",
    request: object({}),
    response: object({
      tags: array(object({
        name: string2(),
        total: number2()
      }))
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select({ tags: spots.tags }).from(spots);
      const counts = new Map;
      for (const row of rows) {
        for (const tag of parseTags(row.tags)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const tags = [...counts.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ja"));
      return { tags };
    }
  }),
  listSpots: defineAction({
    description: "Lists spots with search (name, memo, address, list, and tags), visited filter, optional list filter, optional tag filter, and an optional memo-only filter. Default sort: unvisited spots first, then alphabetical by name. With sort='distance' and a valid originLat/originLng, the same filtered set is ordered by Haversine distance from the origin (spots without coordinates last, name order breaks ties), each row carrying distance_km; the origin is used only for that request and never stored. A distance sort without a valid origin falls back to the default order.",
    request: object({
      query: string2().default(""),
      filter: _enum(["all", "unvisited", "visited"]).default("unvisited"),
      list: string2().nullable().default(null),
      tag: string2().nullable().default(null),
      memoOnly: boolean2().default(false),
      limit: number2().int().positive().max(200).default(100),
      offset: number2().int().min(0).default(0),
      sort: _enum(["default", "distance"]).default("default"),
      originLat: number2().nullable().default(null),
      originLng: number2().nullable().default(null)
    }),
    response: object({
      spots: array(listSpotSchema),
      total: number2()
    }),
    async handler(ctx, args) {
      const db = ctx.db();
      const conditions = [];
      if (args.filter === "unvisited") {
        conditions.push(eq(spots.visited, 0));
      } else if (args.filter === "visited") {
        conditions.push(eq(spots.visited, 1));
      }
      if (args.list) {
        conditions.push(eq(spots.category, args.list));
      }
      if (args.tag) {
        conditions.push(like(spots.tags, `%${JSON.stringify(args.tag)}%`));
      }
      if (args.memoOnly) {
        conditions.push(and(isNotNull(spots.note), sql`${spots.note} <> ''`));
      }
      const q = args.query.trim();
      if (q) {
        const pattern = `%${q}%`;
        conditions.push(or(like(spots.name, pattern), like(spots.note, pattern), like(spots.address, pattern), like(spots.category, pattern), like(spots.tags, pattern)));
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const totalRows = await db.select({ n: count() }).from(spots).where(where);
      const total = totalRows[0]?.n ?? 0;
      const origin = args.sort === "distance" && args.originLat !== null && args.originLng !== null && Number.isFinite(args.originLat) && Number.isFinite(args.originLng) && Math.abs(args.originLat) <= 90 && Math.abs(args.originLng) <= 180 ? { lat: args.originLat, lng: args.originLng } : null;
      if (!origin) {
        const rows = await db.select().from(spots).where(where).orderBy(asc(spots.visited), asc(spots.name)).limit(args.limit).offset(args.offset);
        return { spots: rows.map(toSpot), total };
      }
      const allRows = await db.select().from(spots).where(where);
      const byName = (a, b) => a.name.localeCompare(b.name, "ja") || a.id - b.id;
      const decorated = allRows.map((row) => ({
        row,
        distanceKm: row.lat !== null && row.lng !== null ? haversineKm(origin.lat, origin.lng, row.lat, row.lng) : null
      }));
      decorated.sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) {
          return byName(a.row, b.row);
        }
        if (a.distanceKm === null)
          return 1;
        if (b.distanceKm === null)
          return -1;
        if (a.distanceKm !== b.distanceKm)
          return a.distanceKm - b.distanceKm;
        return byName(a.row, b.row);
      });
      const pageRows = decorated.slice(args.offset, args.offset + args.limit);
      return {
        spots: pageRows.map(({ row, distanceKm }) => ({
          ...toSpot(row),
          distance_km: distanceKm
        })),
        total
      };
    }
  }),
  getSpot: defineAction({
    description: "Returns one spot by id (null when it does not exist). The spot list's pinned map plots only the lean point payload, so a tap on a plotted spot resolves its full row through here before the detail opens \u2014 the detail's edit form must never be seeded from the point payload, whose memo is truncated.",
    request: object({ id: number2().int() }),
    response: object({ spot: spotSchema.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const rows = await db.select().from(spots).where(eq(spots.id, args.id));
      const row = rows[0];
      return { spot: row ? toSpot(row) : null };
    }
  }),
  listWatchSpots: defineAction({
    description: "Returns every unvisited spot that has coordinates, for the client's live proximity watch.",
    request: object({}),
    response: object({ spots: array(spotSchema) }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(spots).where(and(eq(spots.visited, 0), isNotNull(spots.lat), isNotNull(spots.lng))).orderBy(asc(spots.name));
      return { spots: rows.map(toSpot) };
    }
  }),
  addSpot: defineAction({
    description: "Adds one spot by hand (with optional tags) and returns the created spot.",
    request: object({
      name: string2().min(1).max(300),
      note: string2().max(2000).nullable().optional(),
      url: string2().max(2000).nullable().optional(),
      address: string2().max(500).nullable().optional(),
      category: string2().max(200).nullable().optional(),
      tags: tagsInput.optional(),
      lat: number2().min(-90).max(90).nullable().optional(),
      lng: number2().min(-180).max(180).nullable().optional()
    }),
    response: object({ spot: spotSchema }),
    async handler(ctx, args) {
      const db = ctx.db();
      const result = await db.insert(spots).values({
        name: args.name.trim(),
        note: args.note?.trim() || null,
        url: args.url?.trim() || null,
        address: args.address?.trim() || null,
        category: normalizeList(args.category),
        tags: encodeTags(args.tags),
        lat: args.lat ?? null,
        lng: args.lng ?? null
      }).returning();
      const inserted = result[0];
      if (!inserted)
        throw new Error("addSpot: insert returned no rows");
      ctx.invalidateQueries();
      return { spot: toSpot(inserted) };
    }
  }),
  updateSpot: defineAction({
    description: "Edits one spot's fields (name, note, URL, address, category, tags, coordinates). Tags are replaced only when the tags field is sent.",
    request: object({
      id: number2().int().positive(),
      name: string2().min(1).max(300).optional(),
      note: string2().max(2000).nullable().optional(),
      url: string2().max(2000).nullable().optional(),
      address: string2().max(500).nullable().optional(),
      category: string2().max(200).nullable().optional(),
      tags: tagsInput.optional(),
      lat: number2().min(-90).max(90).nullable().optional(),
      lng: number2().min(-180).max(180).nullable().optional()
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      const patch = {};
      if (args.name !== undefined)
        patch.name = args.name.trim();
      if (args.note !== undefined)
        patch.note = args.note?.trim() || null;
      if (args.url !== undefined)
        patch.url = args.url?.trim() || null;
      if (args.address !== undefined)
        patch.address = args.address?.trim() || null;
      if (args.category !== undefined)
        patch.category = normalizeList(args.category);
      if (args.tags !== undefined)
        patch.tags = encodeTags(args.tags);
      if (args.lat !== undefined)
        patch.lat = args.lat;
      if (args.lng !== undefined)
        patch.lng = args.lng;
      if (Object.keys(patch).length > 0) {
        await db.update(spots).set(patch).where(eq(spots.id, args.id));
        ctx.invalidateQueries();
      }
      return { ok: true };
    }
  }),
  setVisited: defineAction({
    description: "Marks a spot as visited (stamping the date) or back to unvisited.",
    request: object({
      id: number2().int().positive(),
      visited: boolean2()
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.update(spots).set({
        visited: args.visited ? 1 : 0,
        visitedAt: args.visited ? new Date : null
      }).where(eq(spots.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  deleteSpot: defineAction({
    description: "Deletes one spot permanently.",
    request: object({ id: number2().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.delete(spots).where(eq(spots.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  bulkImportSpots: defineAction({
    description: "Imports a chunk of spots parsed from the user's Google Takeout / Maps export. Rows whose URL (or name + coordinates) already exists are skipped as duplicates, except that their memo (note) and tags are refreshed independently: when the imported row carries a memo that differs from the stored one, the stored memo is overwritten with the imported one; when the imported row carries a non-empty tag list that differs from the stored one, the stored tags are replaced with the imported ones. An imported row with no memo never erases a stored memo, and an imported row with no tags never erases stored tags; no other field of an existing spot is touched.",
    request: object({
      spots: array(object({
        name: string2().min(1).max(300),
        note: string2().max(2000).nullable().optional(),
        url: string2().max(2000).nullable().optional(),
        address: string2().max(500).nullable().optional(),
        category: string2().max(200).nullable().optional(),
        tags: tagsInput.optional(),
        lat: number2().min(-90).max(90).nullable().optional(),
        lng: number2().min(-180).max(180).nullable().optional()
      })).min(1).max(400)
    }),
    response: object({
      inserted: number2(),
      updated: number2(),
      tagsUpdated: number2(),
      skipped: number2()
    }),
    async handler(ctx, args) {
      const db = ctx.db();
      const existing = await db.select({
        id: spots.id,
        url: spots.url,
        name: spots.name,
        note: spots.note,
        tags: spots.tags,
        lat: spots.lat,
        lng: spots.lng
      }).from(spots);
      const byUrl = new Map;
      const byNameCoords = new Map;
      for (const row of existing) {
        const ref = {
          id: row.id,
          freshIndex: null,
          note: row.note,
          tags: parseTags(row.tags)
        };
        if (row.url)
          byUrl.set(row.url, ref);
        if (row.lat != null && row.lng != null) {
          byNameCoords.set(`${row.name}|${row.lat.toFixed(5)}|${row.lng.toFixed(5)}`, ref);
        }
      }
      const fresh = [];
      const memoUpdates = [];
      const tagUpdates = [];
      let updated = 0;
      let tagsUpdated = 0;
      let skipped = 0;
      for (const spot of args.spots) {
        const url = spot.url?.trim() || null;
        const name = spot.name.trim();
        if (!name) {
          skipped++;
          continue;
        }
        const coordKey = spot.lat != null && spot.lng != null ? `${name}|${spot.lat.toFixed(5)}|${spot.lng.toFixed(5)}` : null;
        const match = (url ? byUrl.get(url) : undefined) ?? (coordKey ? byNameCoords.get(coordKey) : undefined);
        if (match) {
          let changed = false;
          const incomingNote = spot.note?.trim() || null;
          if (incomingNote && incomingNote !== match.note) {
            if (match.id !== null) {
              memoUpdates.push(db.update(spots).set({ note: incomingNote }).where(eq(spots.id, match.id)));
              updated++;
            } else if (match.freshIndex !== null) {
              const queued = fresh[match.freshIndex];
              if (queued)
                queued.note = incomingNote;
            }
            match.note = incomingNote;
            changed = true;
          }
          const incomingTags = normalizeTags(spot.tags);
          if (incomingTags.length > 0 && !sameTags(incomingTags, match.tags)) {
            if (match.id !== null) {
              tagUpdates.push(db.update(spots).set({ tags: encodeTags(incomingTags) }).where(eq(spots.id, match.id)));
              tagsUpdated++;
            } else if (match.freshIndex !== null) {
              const queued = fresh[match.freshIndex];
              if (queued)
                queued.tags = encodeTags(incomingTags);
            }
            match.tags = incomingTags;
            changed = true;
          }
          if (!changed)
            skipped++;
          continue;
        }
        const ref = {
          id: null,
          freshIndex: fresh.length,
          note: spot.note?.trim() || null,
          tags: normalizeTags(spot.tags)
        };
        if (url)
          byUrl.set(url, ref);
        if (coordKey)
          byNameCoords.set(coordKey, ref);
        fresh.push({
          name,
          note: spot.note?.trim() || null,
          url,
          address: spot.address?.trim() || null,
          category: normalizeList(spot.category),
          tags: encodeTags(spot.tags),
          lat: spot.lat ?? null,
          lng: spot.lng ?? null
        });
      }
      const statements = [
        ...fresh.map((row) => db.insert(spots).values(row)),
        ...memoUpdates,
        ...tagUpdates
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first)
          await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { inserted: fresh.length, updated, tagsUpdated, skipped };
    }
  }),
  getSettings: defineAction({
    description: "Returns the proximity alert radius and the memo callout settings (whether the main-chat proximity alert quotes the spot's memo with a teasing line, and the template it uses).",
    request: object({}),
    response: object({
      radiusM: number2(),
      memoTeaseEnabled: boolean2(),
      memoTeaseTemplate: string2()
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(settings).where(eq(settings.id, 1));
      return {
        radiusM: rows[0]?.radiusM ?? 500,
        memoTeaseEnabled: (rows[0]?.memoTeaseEnabled ?? 1) === 1,
        memoTeaseTemplate: rows[0]?.memoTeaseTemplate ?? "\u300C{\u30E1\u30E2}\u300D\u3063\u3066\u66F8\u3044\u3066\u3042\u3063\u305F\u3051\u3069\u3001\u3053\u3093\u306A\u306E\u6C17\u306B\u306A\u3063\u3061\u3083\u3063\u3066\u308B\u306E\u301C\uFF1F\u3056\u3041\u3053\u2661"
      };
    }
  }),
  updateSettings: defineAction({
    description: "Updates settings: the proximity alert radius (50\u20135000m) and/or the memo callout toggle and template ({\u30E1\u30E2} and {\u30B9\u30DD\u30C3\u30C8\u540D} are placeholders).",
    request: object({
      radiusM: number2().int().min(50).max(5000).optional(),
      memoTeaseEnabled: boolean2().optional(),
      memoTeaseTemplate: string2().min(1).max(500).optional()
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      const patch = {};
      if (args.radiusM !== undefined)
        patch.radiusM = args.radiusM;
      if (args.memoTeaseEnabled !== undefined) {
        patch.memoTeaseEnabled = args.memoTeaseEnabled ? 1 : 0;
      }
      if (args.memoTeaseTemplate !== undefined) {
        patch.memoTeaseTemplate = args.memoTeaseTemplate.trim();
      }
      if (Object.keys(patch).length > 0) {
        await db.insert(settings).values({ id: 1, ...patch }).onConflictDoUpdate({
          target: settings.id,
          set: patch
        });
        ctx.invalidateQueries();
      }
      return { ok: true };
    }
  }),
  updateDeviceLocation: defineAction({
    description: "Stores the Pixel's latest known position in the settings row. The external location-check job calls this about once a minute; the page reads it back via getDeviceLocation as the fallback origin for the distance sort and the maps' current-location marker when browser geolocation is unavailable. capturedAtMs is when the position was captured; when omitted, the server's receive time is stored.",
    request: object({
      lat: number2().min(-90).max(90),
      lng: number2().min(-180).max(180),
      capturedAtMs: number2().int().positive().optional()
    }),
    response: object({ ok: literal(true), storedAtMs: number2() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const storedAtMs = args.capturedAtMs ?? Date.now();
      const patch = {
        deviceLat: args.lat,
        deviceLng: args.lng,
        deviceLocAt: new Date(storedAtMs)
      };
      await db.insert(settings).values({ id: 1, ...patch }).onConflictDoUpdate({
        target: settings.id,
        set: patch
      });
      return { ok: true, storedAtMs };
    }
  }),
  getDeviceLocation: defineAction({
    description: "Returns the Pixel position stored by updateDeviceLocation: lat/lng, when it was captured (capturedAtMs), and its age in whole minutes. All fields are null when no position has been stored yet.",
    request: object({}),
    response: object({
      lat: number2().nullable(),
      lng: number2().nullable(),
      capturedAtMs: number2().nullable(),
      ageMinutes: number2().nullable()
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(settings).where(eq(settings.id, 1));
      const row = rows[0];
      const deviceLat = row?.deviceLat ?? null;
      const deviceLng = row?.deviceLng ?? null;
      const deviceLocAt = row?.deviceLocAt ?? null;
      if (deviceLat === null || deviceLng === null || !deviceLocAt) {
        return { lat: null, lng: null, capturedAtMs: null, ageMinutes: null };
      }
      const capturedAtMs = deviceLocAt.getTime();
      return {
        lat: deviceLat,
        lng: deviceLng,
        capturedAtMs,
        ageMinutes: Math.max(0, Math.floor((Date.now() - capturedAtMs) / 60000))
      };
    }
  }),
  getProximityCallout: defineAction({
    description: "Builds the main-chat proximity callout for one spot: when the spot has a memo and the memo callout is enabled, returns the teasing line with the memo quoted (template applied); otherwise callout is null. The chat-side location job calls this when a spot is detected nearby.",
    request: object({ id: number2().int().positive() }),
    response: object({
      spotName: string2().nullable(),
      memo: string2().nullable(),
      callout: string2().nullable()
    }),
    async handler(ctx, args) {
      const db = ctx.db();
      const spotRows = await db.select().from(spots).where(eq(spots.id, args.id));
      const spot = spotRows[0];
      if (!spot)
        return { spotName: null, memo: null, callout: null };
      const memo = spot.note?.trim() ? spot.note : null;
      if (!memo)
        return { spotName: spot.name, memo: null, callout: null };
      const settingRows = await db.select().from(settings).where(eq(settings.id, 1));
      const enabled = (settingRows[0]?.memoTeaseEnabled ?? 1) === 1;
      if (!enabled)
        return { spotName: spot.name, memo, callout: null };
      const template = settingRows[0]?.memoTeaseTemplate ?? "\u300C{\u30E1\u30E2}\u300D\u3063\u3066\u66F8\u3044\u3066\u3042\u3063\u305F\u3051\u3069\u3001\u3053\u3093\u306A\u306E\u6C17\u306B\u306A\u3063\u3061\u3083\u3063\u3066\u308B\u306E\u301C\uFF1F\u3056\u3041\u3053\u2661";
      const callout = template.replaceAll("{\u30E1\u30E2}", memo).replaceAll("{\u30B9\u30DD\u30C3\u30C8\u540D}", spot.name);
      return { spotName: spot.name, memo, callout };
    }
  }),
  bulkSetCoords: defineAction({
    description: "Sets coordinates (lat/lng only) on many spots at once, e.g. coordinates harvested from Google Maps in a browser. Unknown ids are skipped.",
    request: object({
      items: array(object({
        id: number2().int().positive(),
        lat: number2().min(-90).max(90),
        lng: number2().min(-180).max(180)
      })).max(200)
    }),
    response: object({ updated: number2(), skipped: number2() }),
    async handler(ctx, args) {
      if (args.items.length === 0) {
        return { updated: 0, skipped: 0 };
      }
      const db = ctx.db();
      const ids = args.items.map((item) => item.id);
      const existing = await db.select({ id: spots.id }).from(spots).where(inArray(spots.id, ids));
      const existingIds = new Set(existing.map((row) => row.id));
      const statements = [];
      let updated = 0;
      let skipped = 0;
      for (const item of args.items) {
        if (!existingIds.has(item.id)) {
          skipped++;
          continue;
        }
        updated++;
        statements.push(db.update(spots).set({ lat: item.lat, lng: item.lng }).where(eq(spots.id, item.id)));
      }
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first)
          await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { updated, skipped };
    }
  }),
  geocode: defineAction({
    description: "Looks up place-name / address candidates with coordinates via OpenStreetMap Nominatim, so a hand-added spot can join proximity checks.",
    request: object({ query: string2().min(1).max(200) }),
    response: object({
      candidates: array(object({
        name: string2(),
        displayName: string2(),
        lat: number2(),
        lng: number2()
      })),
      error: string2().nullable()
    }),
    async handler(ctx, args) {
      try {
        const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=" + encodeURIComponent(args.query.trim());
        const res = await fetch(url, {
          headers: { "User-Agent": "muse-want-to-go-spots/1.0" }
        });
        if (!res.ok) {
          return { candidates: [], error: `\u691C\u7D22\u30B5\u30FC\u30D3\u30B9\u304C\u5FDC\u7B54\u3057\u307E\u305B\u3093\u3067\u3057\u305F (HTTP ${res.status})` };
        }
        const data = await res.json();
        if (!Array.isArray(data)) {
          return { candidates: [], error: "\u691C\u7D22\u7D50\u679C\u306E\u5F62\u5F0F\u304C\u60F3\u5B9A\u3068\u9055\u3044\u307E\u3057\u305F" };
        }
        const candidates = data.flatMap((item) => {
          if (typeof item !== "object" || item === null)
            return [];
          const rec = item;
          const lat = Number(rec.lat);
          const lng = Number(rec.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng))
            return [];
          const displayName = typeof rec.display_name === "string" ? rec.display_name : "";
          const name = typeof rec.name === "string" && rec.name ? rec.name : displayName;
          return [{ name, displayName, lat, lng }];
        });
        return { candidates, error: null };
      } catch {
        return { candidates: [], error: "\u5834\u6240\u306E\u691C\u7D22\u306B\u63A5\u7D9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F" };
      }
    }
  }),
  listVisitedMunicipalities: defineAction({
    description: "Lists the visited-municipality ledger (\u5E02\u533A\u753A\u6751 the user passed through and got a trivia delivery for) with per-prefecture counts, oldest delivery first. Each row carries its stored real-boundary GeoJSON geometry when one was supplied at recording time. Backs the \u5E02\u533A\u753A\u6751\u30FB\u8DEF\u7DDA and the markdown ledger export.",
    request: object({}),
    response: object({
      municipalities: array(object({
        id: number2(),
        name: string2(),
        prefecture: string2(),
        area: string2().nullable(),
        context: string2().nullable(),
        visitedOn: string2(),
        lat: number2().nullable(),
        lng: number2().nullable(),
        geometry: geoJsonGeometrySchema.nullable()
      })),
      prefectures: array(object({ name: string2(), total: number2() })),
      total: number2()
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(visitedMunicipalities).orderBy(asc(visitedMunicipalities.visitedOn), asc(visitedMunicipalities.prefecture), asc(visitedMunicipalities.name));
      const counts = new Map;
      for (const row of rows) {
        counts.set(row.prefecture, (counts.get(row.prefecture) ?? 0) + 1);
      }
      return {
        municipalities: rows.map((r) => ({
          id: r.id,
          name: r.name,
          prefecture: r.prefecture,
          area: r.area,
          context: r.context,
          visitedOn: r.visitedOn,
          lat: r.lat,
          lng: r.lng,
          geometry: parseGeometry(r.geometry)
        })),
        prefectures: [...counts.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ja")),
        total: rows.length
      };
    }
  }),
  addVisitedMunicipality: defineAction({
    description: "Records one municipality in the visited ledger (the chat-side trivia job calls this for each new municipality it delivers trivia for; also used by the in-page form). Optionally carries the municipality's real boundary as a simplified GeoJSON geometry (Polygon / MultiPolygon, [lng, lat] positions) so the \u5E02\u533A\u753A\u6751\u30FB\u8DEF\u7DDA can fill the actual shape; calls without it behave exactly as before. A context field records the trip context of the visit (what the trip was for / on the way back from). When the call carries no coordinates, the representative point is resolved from the prefecture + name via Nominatim (best-effort) so the row still joins the map and the numbered ledger. A municipality already recorded (same prefecture + name) keeps its first-visit date and is reported as not created; a geometry, coordinates, or a context supplied for such a row are stored only when the row has none yet (backfill, never an overwrite).",
    request: object({
      name: string2().min(1).max(100),
      prefecture: string2().min(1).max(100),
      area: string2().max(500).nullable().optional(),
      context: string2().max(500).nullable().optional(),
      visitedOn: string2().regex(/^\d{4}-\d{2}-\d{2}$/, "visitedOn must be YYYY-MM-DD"),
      lat: number2().min(-90).max(90).nullable().optional(),
      lng: number2().min(-180).max(180).nullable().optional(),
      geometry: geoJsonGeometrySchema.nullable().optional()
    }),
    response: object({ created: boolean2(), id: number2().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const name = args.name.trim();
      const prefecture = args.prefecture.trim();
      const existing = await db.select({
        id: visitedMunicipalities.id,
        geometry: visitedMunicipalities.geometry,
        lat: visitedMunicipalities.lat,
        lng: visitedMunicipalities.lng,
        context: visitedMunicipalities.context
      }).from(visitedMunicipalities).where(and(eq(visitedMunicipalities.prefecture, prefecture), eq(visitedMunicipalities.name, name)));
      if (existing[0]) {
        const row = existing[0];
        const patch = {};
        if (args.geometry && !row.geometry) {
          patch.geometry = encodeGeometry(args.geometry);
        }
        if (row.lat === null || row.lng === null) {
          const point = args.lat != null && args.lng != null ? { lat: args.lat, lng: args.lng } : await resolveMunicipalityPoint(prefecture, name);
          if (point) {
            patch.lat = point.lat;
            patch.lng = point.lng;
          }
        }
        const context = args.context?.trim() || null;
        if (context && !row.context)
          patch.context = context;
        if (Object.keys(patch).length > 0) {
          await db.update(visitedMunicipalities).set(patch).where(eq(visitedMunicipalities.id, row.id));
          ctx.invalidateQueries();
        }
        return { created: false, id: row.id };
      }
      let lat = args.lat ?? null;
      let lng = args.lng ?? null;
      if (lat === null || lng === null) {
        const point = await resolveMunicipalityPoint(prefecture, name);
        if (point) {
          lat = point.lat;
          lng = point.lng;
        }
      }
      const inserted = await db.insert(visitedMunicipalities).values({
        name,
        prefecture,
        area: args.area?.trim() || null,
        context: args.context?.trim() || null,
        visitedOn: args.visitedOn,
        lat,
        lng,
        geometry: encodeGeometry(args.geometry)
      }).returning({ id: visitedMunicipalities.id });
      ctx.invalidateQueries();
      return { created: true, id: inserted[0]?.id ?? null };
    }
  }),
  updateVisitedMunicipality: defineAction({
    description: "Sets (or clears, with null) the trip context of one visited-ledger municipality \u2014 what that first visit's trip was for / on the way back from. Only the context changes; the first-visit date, area, and coordinates are untouched.",
    request: object({
      id: number2().int().positive(),
      context: string2().max(500).nullable()
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.update(visitedMunicipalities).set({ context: args.context?.trim() || null }).where(eq(visitedMunicipalities.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  importVisitedMunicipalities: defineAction({
    description: "Bulk-imports the existing trivia ledger (from location-trivia/seen_places.md) into the visited-municipality table. Idempotent: municipalities already recorded (same prefecture + name) are skipped, so re-running never duplicates rows or changes first-visit dates. An entry may carry the municipality's simplified GeoJSON boundary geometry: it is stored on insert, and backfilled onto an already-recorded row only when that row has no geometry yet (never overwritten). An entry's trip context and coordinates are likewise backfilled only onto a row that has none yet.",
    request: object({
      entries: array(object({
        name: string2().min(1).max(100),
        prefecture: string2().min(1).max(100),
        area: string2().max(500).nullable().optional(),
        context: string2().max(500).nullable().optional(),
        visitedOn: string2().regex(/^\d{4}-\d{2}-\d{2}$/, "visitedOn must be YYYY-MM-DD"),
        lat: number2().min(-90).max(90).nullable().optional(),
        lng: number2().min(-180).max(180).nullable().optional(),
        geometry: geoJsonGeometrySchema.nullable().optional()
      })).min(1).max(500)
    }),
    response: object({
      inserted: number2(),
      geometryUpdated: number2(),
      skipped: number2()
    }),
    async handler(ctx, args) {
      const db = ctx.db();
      const existing = await db.select({
        id: visitedMunicipalities.id,
        prefecture: visitedMunicipalities.prefecture,
        name: visitedMunicipalities.name,
        geometry: visitedMunicipalities.geometry,
        lat: visitedMunicipalities.lat,
        lng: visitedMunicipalities.lng,
        context: visitedMunicipalities.context
      }).from(visitedMunicipalities);
      const seen = new Map(existing.map((r) => [
        `${r.prefecture}|${r.name}`,
        {
          id: r.id,
          hasGeometry: r.geometry !== null,
          hasCoords: r.lat !== null && r.lng !== null,
          hasContext: r.context !== null && r.context !== ""
        }
      ]));
      const fresh = [];
      const geometryUpdates = [];
      let geometryUpdatedCount = 0;
      let skipped = 0;
      for (const entry of args.entries) {
        const name = entry.name.trim();
        const prefecture = entry.prefecture.trim();
        if (!name || !prefecture) {
          skipped++;
          continue;
        }
        const key = `${prefecture}|${name}`;
        const known = seen.get(key);
        if (known) {
          const patch = {};
          if (entry.geometry && !known.hasGeometry) {
            patch.geometry = encodeGeometry(entry.geometry);
            known.hasGeometry = true;
            geometryUpdatedCount++;
          }
          if (!known.hasCoords && entry.lat != null && entry.lng != null) {
            patch.lat = entry.lat;
            patch.lng = entry.lng;
            known.hasCoords = true;
          }
          const context = entry.context?.trim() || null;
          if (context && !known.hasContext) {
            patch.context = context;
            known.hasContext = true;
          }
          if (Object.keys(patch).length > 0) {
            geometryUpdates.push(db.update(visitedMunicipalities).set(patch).where(eq(visitedMunicipalities.id, known.id)));
          } else {
            skipped++;
          }
          continue;
        }
        seen.set(key, {
          id: -1,
          hasGeometry: entry.geometry != null,
          hasCoords: entry.lat != null && entry.lng != null,
          hasContext: !!entry.context?.trim()
        });
        fresh.push({
          name,
          prefecture,
          area: entry.area?.trim() || null,
          context: entry.context?.trim() || null,
          visitedOn: entry.visitedOn,
          lat: entry.lat ?? null,
          lng: entry.lng ?? null,
          geometry: encodeGeometry(entry.geometry)
        });
      }
      const statements = [
        ...fresh.map((row) => db.insert(visitedMunicipalities).values(row)),
        ...geometryUpdates
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first)
          await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return {
        inserted: fresh.length,
        geometryUpdated: geometryUpdatedCount,
        skipped
      };
    }
  }),
  deleteVisitedMunicipality: defineAction({
    description: "Removes one municipality from the visited ledger (for correcting a wrong record).",
    request: object({ id: number2().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.delete(visitedMunicipalities).where(eq(visitedMunicipalities.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  listRiddenLines: defineAction({
    description: "Lists the ridden-railway-line ledger (\u8DEF\u7DDA the user rode and got a line-trivia delivery for), oldest first-ride date first. Shown alongside the \u5E02\u533A\u753A\u6751\u30FB\u8DEF\u7DDA as its companion collection. Each row also carries its service-master linkage (serviceId, rideState, restored from/to stations) \u2014 stage 1, subtask 1420.",
    request: object({}),
    response: object({
      lines: array(object({
        id: number2(),
        name: string2(),
        firstRiddenOn: string2(),
        note: string2().nullable(),
        context: string2().nullable(),
        serviceId: string2().nullable(),
        recordedServiceId: string2().nullable(),
        serviceLinkSource: _enum(["auto", "explicit"]).nullable(),
        serviceMatchVersion: string2().nullable(),
        rideState: rideStateSchema,
        fromStationId: string2().nullable(),
        fromStationName: string2().nullable(),
        toStationId: string2().nullable(),
        toStationName: string2().nullable(),
        masterVersion: string2().nullable(),
        pathSnapshot: string2().nullable(),
        sections: array(riddenSectionSchema)
      })),
      total: number2()
    }),
    async handler(ctx) {
      const db = ctx.db();
      const rows = await db.select().from(riddenLines).orderBy(asc(riddenLines.firstRiddenOn), asc(riddenLines.name));
      const sectionRows = rows.length > 0 ? await db.select().from(riddenLineSections).where(inArray(riddenLineSections.riddenLineId, rows.map((r) => r.id))).orderBy(asc(riddenLineSections.id)) : [];
      const sectionsByLine = new Map;
      for (const section of sectionRows) {
        const list = sectionsByLine.get(section.riddenLineId) ?? [];
        list.push(section);
        sectionsByLine.set(section.riddenLineId, list);
      }
      return {
        lines: rows.map((r) => ({
          id: r.id,
          name: r.name,
          firstRiddenOn: r.firstRiddenOn,
          note: r.note,
          context: r.context,
          serviceId: r.serviceId,
          recordedServiceId: r.recordedServiceId,
          serviceLinkSource: r.serviceLinkSource,
          serviceMatchVersion: r.serviceMatchVersion,
          rideState: normalizeRideState(r.rideState),
          fromStationId: r.fromStationId,
          fromStationName: r.fromStationName,
          toStationId: r.toStationId,
          toStationName: r.toStationName,
          masterVersion: r.masterVersion,
          pathSnapshot: r.pathSnapshot,
          sections: (sectionsByLine.get(r.id) ?? []).map((s) => ({
            id: s.id,
            fromStationId: s.fromStationId,
            fromStationName: s.fromStationName,
            toStationId: s.toStationId,
            toStationName: s.toStationName,
            direction: normalizeSectionDirection(s.direction),
            blockId: s.blockId,
            recordedServiceId: s.recordedServiceId
          }))
        })),
        total: rows.length
      };
    }
  }),
  addRiddenLine: defineAction({
    description: "Records one railway line in the ridden-lines ledger (the chat-side trivia job calls this for each new line it delivers trivia for; also used by the in-page form). A context field records the trip context of the first ride (what the trip was for / on the way back from). A line already recorded (same name) keeps its first-ride date and note and is reported as not created, so repeat rides never duplicate or move the first-ride date; a context supplied for such a row is stored only when the row has none yet. An explicit serviceId on a new row must match the service named by the entry. The ride fields are validated per state (unknown carries no section, partial needs both endpoint station IDs and a known service, full needs a known service and a master version); by default the row links by name and starts unknown.",
    request: object({
      name: string2().min(1).max(100),
      firstRiddenOn: string2().regex(/^\d{4}-\d{2}-\d{2}$/, "firstRiddenOn must be YYYY-MM-DD"),
      note: string2().max(1000).nullable().optional(),
      context: string2().max(500).nullable().optional()
    }).merge(rideFieldsSchema),
    response: object({ created: boolean2(), id: number2().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const name = args.name.trim();
      const existing = await db.select({
        id: riddenLines.id,
        context: riddenLines.context,
        serviceId: riddenLines.serviceId,
        serviceLinkSource: riddenLines.serviceLinkSource
      }).from(riddenLines).where(eq(riddenLines.name, name));
      if (existing[0]) {
        const context = args.context?.trim() || null;
        if (context && !existing[0].context) {
          await db.update(riddenLines).set({ context }).where(eq(riddenLines.id, existing[0].id));
          ctx.invalidateQueries();
        }
        const link = existing[0].serviceId || isExplicitlyUnlinked({ name, ...existing[0] }) ? undefined : riddenServiceBackfill(name);
        if (link) {
          await db.update(riddenLines).set(link).where(and(eq(riddenLines.id, existing[0].id), isNull(riddenLines.serviceId)));
          ctx.invalidateQueries();
        }
        return { created: false, id: existing[0].id };
      }
      const inserted = await db.insert(riddenLines).values({
        name,
        firstRiddenOn: args.firstRiddenOn,
        note: args.note?.trim() || null,
        context: args.context?.trim() || null,
        ...resolveRideFields(name, args)
      }).returning({ id: riddenLines.id });
      ctx.invalidateQueries();
      return { created: true, id: inserted[0]?.id ?? null };
    }
  }),
  updateRiddenLine: defineAction({
    description: "Sets (or clears, with null) the trip context of one ridden-lines ledger row \u2014 what that first ride's trip was for / on the way back from. Only the context changes; the first-ride date and note are untouched.",
    request: object({
      id: number2().int().positive(),
      context: string2().max(500).nullable()
    }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.update(riddenLines).set({ context: args.context?.trim() || null }).where(eq(riddenLines.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  confirmRiddenServiceLink: defineAction({
    description: "Confirms, changes or clears a ridden-lines ledger row's service link. The original recorded service and ride details are kept. The target must fit the full ride's path or every recorded section. Sections without a matching recorded service or block require endpoints and direction that identify the route.",
    request: object({
      id: number2().int().positive(),
      serviceId: string2().max(100).nullable()
    }),
    response: object({ ok: literal(true), serviceId: string2().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const rows = await db.select().from(riddenLines).where(eq(riddenLines.id, args.id));
      const line = rows[0];
      if (!line) {
        throw new Error(`confirmRiddenServiceLink: unknown ridden line ${args.id}`);
      }
      if (!isRiddenServiceLinkReviewable(line)) {
        throw new Error(`confirmRiddenServiceLink: "${line.name}" does not need a link confirmation`);
      }
      if (args.serviceId != null && !serviceById(args.serviceId)) {
        throw new Error(`confirmRiddenServiceLink: unknown service "${args.serviceId}"`);
      }
      const sectionRows = await db.select({
        fromStationId: riddenLineSections.fromStationId,
        toStationId: riddenLineSections.toStationId,
        direction: riddenLineSections.direction,
        blockId: riddenLineSections.blockId,
        recordedServiceId: riddenLineSections.recordedServiceId
      }).from(riddenLineSections).where(eq(riddenLineSections.riddenLineId, args.id));
      const fitProblem = riddenLinkFitProblem(line, sectionRows, args.serviceId);
      if (fitProblem) {
        throw new Error(`confirmRiddenServiceLink: "${line.name}" cannot be linked there \u2014 ${fitProblem}; the recorded link was left unchanged`);
      }
      const updated = await db.update(riddenLines).set({
        serviceId: args.serviceId,
        serviceLinkSource: "explicit",
        serviceMatchVersion: null
      }).where(and(eq(riddenLines.id, args.id), sql`${riddenLines.serviceId} IS ${line.serviceId}`, sql`${riddenLines.serviceLinkSource} IS ${line.serviceLinkSource}`)).returning({ id: riddenLines.id });
      if (updated.length === 0) {
        throw new Error(`confirmRiddenServiceLink: the link for "${line.name}" changed during confirmation`);
      }
      ctx.invalidateQueries();
      return { ok: true, serviceId: args.serviceId };
    }
  }),
  importRiddenLines: defineAction({
    description: "Bulk-imports the existing line-trivia log (from location-trivia/seen_lines.md) into the ridden-lines table. Idempotent: lines already recorded (same name) are skipped, so re-running never duplicates rows or changes first-ride dates. An entry's trip context is backfilled onto an already-recorded row only when that row has none yet. Fresh rows link to their service and start unknown (a fresh registration never inherits a restored section \u2014 that belongs to the SQL migration); already-recorded rows with no service linkage yet get the service link only, never an overwrite of their ride state or section.",
    request: object({
      entries: array(object({
        name: string2().min(1).max(100),
        firstRiddenOn: string2().regex(/^\d{4}-\d{2}-\d{2}$/, "firstRiddenOn must be YYYY-MM-DD"),
        note: string2().max(1000).nullable().optional(),
        context: string2().max(500).nullable().optional()
      })).min(1).max(500)
    }),
    response: object({ inserted: number2(), skipped: number2() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const existing = await db.select({
        id: riddenLines.id,
        name: riddenLines.name,
        context: riddenLines.context,
        serviceId: riddenLines.serviceId,
        serviceLinkSource: riddenLines.serviceLinkSource
      }).from(riddenLines);
      const seen = new Map(existing.map((r) => [
        r.name,
        {
          id: r.id,
          hasContext: !!r.context,
          serviceId: r.serviceId,
          serviceLinkSource: r.serviceLinkSource
        }
      ]));
      const fresh = [];
      const contextUpdates = [];
      const rideUpdates = [];
      let skipped = 0;
      for (const entry of args.entries) {
        const name = entry.name.trim();
        if (!name) {
          skipped++;
          continue;
        }
        const known = seen.get(name);
        if (known) {
          const context = entry.context?.trim() || null;
          if (context && !known.hasContext && known.id > 0) {
            contextUpdates.push(db.update(riddenLines).set({ context }).where(eq(riddenLines.id, known.id)));
            known.hasContext = true;
          } else {
            skipped++;
          }
          if (!known.serviceId && known.serviceLinkSource !== "explicit" && known.id > 0) {
            const link = riddenServiceBackfill(name);
            if (link) {
              rideUpdates.push(db.update(riddenLines).set(link).where(and(eq(riddenLines.id, known.id), isNull(riddenLines.serviceId))));
              known.serviceId = link.serviceId;
            }
          }
          continue;
        }
        const ride = resolveRideFields(name, {});
        seen.set(name, {
          id: -1,
          hasContext: !!entry.context?.trim(),
          serviceId: ride.serviceId,
          serviceLinkSource: ride.serviceLinkSource
        });
        fresh.push({
          name,
          firstRiddenOn: entry.firstRiddenOn,
          note: entry.note?.trim() || null,
          context: entry.context?.trim() || null,
          ...ride
        });
      }
      const statements = [
        ...fresh.map((row) => db.insert(riddenLines).values(row)),
        ...contextUpdates,
        ...rideUpdates
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first)
          await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { inserted: fresh.length, skipped };
    }
  }),
  addRiddenSection: defineAction({
    description: "Adds one section to a ridden-lines ledger row \u2014 a block pick from the in-page block list, or a hand-entered section between two stations the service is known to serve (stage 2, subtask 1421; stage 3, subtask 1455: a boundary station, or a station listed on one of the service's blocks \u2014 a mid-block station counts as an endpoint, a station known only from a migrated ride does not). On a non-loop service the pair may run either way (a section is one stretch of the line, travelled in either direction); on a loop service a direction is required (validateSectionEndpoints); a section that is exactly one master block may name it with blockId, so the client can mark the block covered \u2014 the named block must agree with the direction given (review round 2). Adding a section to an unknown row makes it partial (it now pins down a section); a full ride already covers the whole service, so sections cannot be added to it. Adding the same section twice returns the existing row instead of duplicating it \u2014 a unique index on the table (migration 0014) backs the check, so two calls racing each other still land on one row; when the later call names a block and the surviving row has none, the row adopts the block ID so the block stays untickable. A duplicate add also repairs a row left unknown with a section on record (review round 2).",
    request: object({
      riddenLineId: number2().int().positive(),
      fromStationId: string2().max(20),
      fromStationName: string2().max(100).nullable().optional(),
      toStationId: string2().max(20),
      toStationName: string2().max(100).nullable().optional(),
      direction: _enum(["inner", "outer"]).nullable().optional(),
      blockId: string2().max(100).nullable().optional()
    }),
    response: object({ created: boolean2(), id: number2().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db();
      const rows = await db.select().from(riddenLines).where(eq(riddenLines.id, args.riddenLineId));
      const line = rows[0];
      if (!line) {
        throw new Error(`addRiddenSection: unknown ridden line ${args.riddenLineId}`);
      }
      if (!line.serviceId) {
        throw new Error(`addRiddenSection: "${line.name}" is not linked to a service yet`);
      }
      const service = usableRiddenService(line);
      if (!service) {
        throw new Error(`addRiddenSection: service link for "${line.name}" needs confirmation`);
      }
      if (normalizeRideState(line.rideState) === "full") {
        throw new Error(`addRiddenSection: "${line.name}" is a full ride \u2014 it already covers the whole service`);
      }
      const fromStationId = args.fromStationId.trim();
      const toStationId = args.toStationId.trim();
      const direction = args.direction ?? null;
      const problem = validateSectionEndpoints(service.id, fromStationId, toStationId, direction);
      if (problem) {
        throw new Error(`addRiddenSection: ${problem}`);
      }
      const blockId = args.blockId?.trim() || null;
      if (blockId) {
        const block = blockById(service.id, blockId);
        if (!block) {
          throw new Error(`addRiddenSection: unknown block "${blockId}" for "${line.name}"`);
        }
        const endpointsMatch = block.from.id === fromStationId && block.to.id === toStationId || block.from.id === toStationId && block.to.id === fromStationId;
        if (!endpointsMatch) {
          throw new Error(`addRiddenSection: block "${blockId}" runs ${block.from.name}\u301C${block.to.name}, not the given section`);
        }
        if (block.direction && direction && block.direction !== direction) {
          throw new Error(`addRiddenSection: block "${blockId}" runs ${block.direction}, not ${direction}`);
        }
      }
      const fromName = args.fromStationName?.trim() || stationRefById(fromStationId)?.name || null;
      const toName = args.toStationName?.trim() || stationRefById(toStationId)?.name || null;
      const findDuplicate = async () => {
        const existing = await db.select().from(riddenLineSections).where(eq(riddenLineSections.riddenLineId, args.riddenLineId));
        return existing.find((s) => s.fromStationId === fromStationId && s.toStationId === toStationId && (s.direction ?? null) === direction);
      };
      const adoptBlockId = async (existing) => {
        if (blockId && !existing.blockId) {
          if (!recordedSectionFitsService(service.id, {
            ...existing,
            direction: normalizeSectionDirection(existing.direction)
          })) {
            throw new Error(`addRiddenSection: the existing section's recorded route cannot be attributed to ${service.displayName}`);
          }
          await db.update(riddenLineSections).set({ blockId }).where(and(eq(riddenLineSections.id, existing.id), isNull(riddenLineSections.blockId)));
          ctx.invalidateQueries();
        }
      };
      const duplicate = await findDuplicate();
      const repairRideState = async () => {
        const [fresh] = await db.select().from(riddenLines).where(eq(riddenLines.id, args.riddenLineId)).limit(1);
        if (!fresh || normalizeRideState(fresh.rideState) !== "unknown") {
          return;
        }
        const sections = await db.select({ id: riddenLineSections.id }).from(riddenLineSections).where(eq(riddenLineSections.riddenLineId, args.riddenLineId)).limit(1);
        if (sections.length > 0) {
          await db.update(riddenLines).set({ rideState: "partial" }).where(eq(riddenLines.id, args.riddenLineId));
        }
      };
      if (duplicate) {
        await adoptBlockId(duplicate);
        await repairRideState();
        return { created: false, id: duplicate.id };
      }
      let insertedId;
      try {
        const inserted = await db.insert(riddenLineSections).values({
          riddenLineId: args.riddenLineId,
          fromStationId,
          fromStationName: fromName,
          toStationId,
          toStationName: toName,
          direction,
          blockId,
          recordedServiceId: service.id
        }).returning({ id: riddenLineSections.id });
        insertedId = inserted[0]?.id ?? null;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const winner = await findDuplicate();
          if (winner) {
            await adoptBlockId(winner);
            await repairRideState();
            return { created: false, id: winner.id };
          }
        }
        throw error;
      }
      await repairRideState();
      ctx.invalidateQueries();
      return { created: true, id: insertedId };
    }
  }),
  deleteRiddenSection: defineAction({
    description: "Removes one added section from a ridden-lines ledger row (stage 2, subtask 1421). Removing the row's last section when it has no primary section returns it to unknown \u2014 a ride with no section on record must not claim a partial one.",
    request: object({ id: number2().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      const sections = await db.select().from(riddenLineSections).where(eq(riddenLineSections.id, args.id));
      const section = sections[0];
      if (!section)
        return { ok: true };
      await db.delete(riddenLineSections).where(eq(riddenLineSections.id, args.id));
      const remaining = await db.select({ id: riddenLineSections.id }).from(riddenLineSections).where(eq(riddenLineSections.riddenLineId, section.riddenLineId));
      if (remaining.length === 0) {
        const lines = await db.select().from(riddenLines).where(eq(riddenLines.id, section.riddenLineId));
        const line = lines[0];
        if (line && normalizeRideState(line.rideState) === "partial" && !line.fromStationId && !line.toStationId) {
          await db.update(riddenLines).set({ rideState: "unknown" }).where(eq(riddenLines.id, line.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    }
  }),
  deleteRiddenLine: defineAction({
    description: "Removes one railway line from the ridden-lines ledger (for correcting a wrong record).",
    request: object({ id: number2().int().positive() }),
    response: okResponse,
    async handler(ctx, args) {
      const db = ctx.db();
      await db.delete(riddenLineSections).where(eq(riddenLineSections.riddenLineId, args.id));
      await db.delete(riddenLines).where(eq(riddenLines.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    }
  })
};
export {
  Actions,
  isUniqueConstraintError,
  resolveRideFields,
  riddenLinkFitProblem
};
