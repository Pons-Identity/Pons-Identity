// Hover documentation for the JavaScript a script can use, shown by CodeEditor. Only what the script sandbox really has is
// listed: the standard language and its built-in objects, with no browser or Node extras (no fetch, require, URL or timers).
//
// Three tables, each keyed by how the thing is written in code:
//   KEYWORDS and GLOBALS   a bare word:              await, parseInt, Math
//   STATICS                 a dotted name:            Math.max, JSON.stringify, Object.keys
//   MEMBERS                 a method on any value:    map, trim, toFixed. The receiver is unknown, so a name shared by several
//                           types (includes, slice, at) lists each of them.
// An entry is { sig, desc, input?, returns?, throws?, example? }.

const e = (sig, desc, returns, example, input) => ({ sig, desc, returns, example, input });

export const KEYWORDS = {
  await: e('await promise', 'Pauses the script until a promise settles. Works anywhere in a script, since it runs as an async function.', 'The value the promise resolved to; throws if it rejected.', 'const r = await http.get(url);'),
  async: e('async (args) => { … }', 'Makes a function return a promise, so await can be used inside it. Needed on callbacks that await; array methods such as map do not wait for them.', 'A promise.', 'const sizes = await Promise.all(urls.map(async (u) => (await http.get(u)).text.length));'),
  return: e('return value', 'Ends the script (or function) and gives back a value.', '', 'return { created: 3 };'),
  const: e('const name = value', 'Declares a variable that cannot be reassigned. An object or array it holds can still be changed.', '', 'const limit = 50;'),
  let: e('let name = value', 'Declares a variable that can be reassigned, limited to its block.', '', 'let count = 0;\ncount += 1;'),
  throw: e('throw new Error(message)', 'Stops with an error. Uncaught, it ends the run as "error" and reports the line.', '', 'if (!user) throw new Error("No such user: " + input.username);'),
  try: e('try { … } catch (err) { … } finally { … }', 'Runs code and handles an error it throws. finally always runs.', '', 'try {\n  await idp.groups.addMember("Staff", name);\n} catch (err) {\n  log.warning(err.message);\n}'),
  catch: e('catch (err) { … }', 'The part of try that runs when something threw. err is usually an Error with a message.', '', 'try { await risky(); } catch (err) { log.error(err.message); }'),
  typeof: e('typeof value', 'The kind of a value as text: "string", "number", "boolean", "object", "undefined", "function" or "bigint". null is "object"; use Array.isArray for arrays.', 'string.', 'if (typeof input.days !== "number") throw new Error("days must be a number");'),
  of: e('for (const item of iterable) { … }', 'Loops over the values of an array, string, Map or Set.', '', 'for (const u of users) log(u.username);'),
  in: e('key in object', 'Whether an object has a property. In a for…in loop it visits the keys.', 'boolean.', 'if ("manager" in user.attributes) { … }'),
  new: e('new Constructor(args)', 'Creates an object from a class such as Date, Map, Set, Error or RegExp.', 'The new object.', 'const seen = new Set();'),
  null: e('null', 'The deliberate "no value". idp.users.find returns null for no match. null == undefined, but null !== undefined.', '', 'const u = await idp.users.find({ username });\nif (u === null) return;'),
  undefined: e('undefined', 'The value of a variable or property that was never set, and what a function without a return gives back.', '', 'if (input.days === undefined) days = 30;'),
  true: e('true', 'The boolean true.', ''),
  false: e('false', 'The boolean false.', ''),
};

// Reminders of the statement syntax, for people who write other languages too. `coming` names the equivalent elsewhere.
const k = (sig, desc, example, coming) => ({ ...e(sig, desc, '', example), coming });
Object.assign(KEYWORDS, {
  if: k('if (condition) { … } else if (condition) { … } else { … }', 'Runs a block only when the condition is true. The condition needs parentheses and the blocks need braces (or a single statement). The empty string, 0, null, undefined and NaN count as false; an empty array or object counts as true.',
    'if (!user) {\n  log.warning("no such user");\n} else if (!user.active) {\n  log("already off");\n} else {\n  await idp.users.update(user.username, { active: false });\n}',
    'Python: elif is "else if", and there is no colon or indentation. Ruby: elsif. Shell: fi and then are not used.'),
  else: k('if (…) { … } else { … }', 'The block that runs when the if condition was false. "else if" chains another test.', 'if (days > 90) status = "stale";\nelse if (days > 30) status = "old";\nelse status = "new";', 'Python: elif / else. Ruby: elsif / else.'),
  for: k('for (let i = 0; i < n; i++) { … }   for (const x of list) { … }   for (const key in object) { … }', 'Loops. The three-part form counts; "for…of" visits the values of an array, string, Map or Set; "for…in" visits an object\'s keys (use Object.entries for key and value together). Use for…of with await when each step must finish before the next.',
    'for (let i = 0; i < 3; i++) log(i);\nfor (const u of users) await sync(u);\nfor (const [key, value] of Object.entries(user.attributes)) log(key, value);',
    'Python: for x in items: (that is for…of); for i in range(n) is the counting form. Java/C#: foreach (x in items) is for…of.'),
  while: k('while (condition) { … }', 'Repeats the block as long as the condition is true. Make sure something in the loop changes the condition, or the run stops only when it times out.', 'let page = 1;\nwhile (page <= 5) {\n  const r = await http.get(`${base}?page=${page}`);\n  if (!r.json.length) break;\n  page += 1;\n}', 'Python: while condition: (no parentheses; indentation instead of braces).'),
  do: k('do { … } while (condition);', 'Like while, but the block always runs once before the condition is tested.', 'let tries = 0;\ndo {\n  tries += 1;\n} while (tries < 3 && !ok);'),
  switch: k('switch (value) { case a: … break; default: … }', 'Chooses a block by comparing a value (with ===) to each case. Without break, execution falls through into the next case.',
    'switch (user.department) {\n  case "Sailing":\n    group = "Crew";\n    break;\n  case "Rigging":\n  case "Sails":\n    group = "Loft";\n    break;\n  default:\n    group = "Staff";\n}', 'Python: match / case. Go: switch does not fall through. Ruby: case / when.'),
  case: k('case value: … break;', 'One branch of a switch. Stack several case lines to share one block.', 'case "a":\ncase "b":\n  handle();\n  break;'),
  default: k('default: …', 'The branch of a switch used when no case matches. (Also the word in "export default", which scripts do not use.)', 'switch (x) {\n  case 1: one(); break;\n  default: other();\n}'),
  break: k('break;', 'Leaves the nearest loop or switch at once.', 'for (const u of users) {\n  if (u.username === name) { found = u; break; }\n}', 'Python/C/Java: the same word.'),
  continue: k('continue;', 'Skips the rest of this pass of a loop and starts the next one.', 'for (const row of rows) {\n  if (!row.email) continue;\n  await idp.users.create(row);\n}', 'Python/C/Java: the same word.'),
  function: k('function name(a, b = 1, ...rest) { return a + b; }', 'Declares a named function. It can be called before the line that declares it. Add async to use await inside. An arrow function, (a, b) => a + b, is the short form for callbacks.',
    'async function lookup(name) {\n  return await idp.users.find({ username: name });\n}\nconst names = users.map((u) => u.username);',
    'Python: def name(a, b=1, *rest):. Ruby: def. Go: func. Arrow functions are like Python lambdas but can have a full block body.'),
  class: k('class Name extends Base { constructor(…) { super(…); } method() { … } }', 'Declares a class. Scripts rarely need one: a plain object or a function is usually simpler.', 'class Counter {\n  count = 0;\n  add() { this.count += 1; }\n}\nconst c = new Counter();'),
  extends: k('class Child extends Parent { … }', 'Makes a class build on another. Call super(…) first in the constructor.', 'class MyError extends Error {}'),
  static: k('static name() { … }', 'In a class: a method or field that belongs to the class itself, not to its objects.', 'class Util { static double(n) { return n * 2; } }\nUtil.double(4);'),
  this: k('this', 'Inside a class method, the object the method was called on. In an arrow function it is the surrounding one.', 'class Box { n = 1; get() { return this.n; } }', 'Python: self. Ruby: self. Java: this.'),
  super: k('super(args)  /  super.method()', 'In a class that extends another: calls the parent constructor, or one of its methods.', 'class A extends B { constructor() { super(); } }', 'Python: super().__init__(). Java: super(…).'),
  var: k('var name = value;', 'Older way to declare a variable. It is scoped to the whole function, not the block, and can be used before its line. Prefer const or let.', 'var total = 0;'),
  delete: k('delete object.key', 'Removes a property from an object.', 'delete input.password;\nconst { password, ...safe } = input;  // another way: copy without it', 'Python: del obj["key"].'),
  void: k('void expression', 'Evaluates an expression and gives undefined.', ''),
  instanceof: k('value instanceof Class', 'Whether a value was made by a class or constructor.', 'if (err instanceof TypeError) { … }\nArray.isArray(list);  // for arrays, this is the usual test', 'Python: isinstance(value, Class).'),
  finally: k('try { … } catch (err) { … } finally { … }', 'The block of a try that always runs, whether or not something threw.', 'try {\n  await risky();\n} finally {\n  log("done");\n}', 'Python: finally: is the same.'),
  yield: k('function* gen() { yield value; }', 'Hands a value out of a generator function one at a time. Rarely needed in scripts.', 'function* count() { yield 1; yield 2; }'),
  with: k('with', 'Not available: it is disallowed in modern JavaScript. Use try / finally to clean up.', ''),
  import: k('import', 'Not available in scripts: there is no module loading. Everything a script can use is listed in the reference (idp, http, files, csv, util and so on).', '', 'Python: import. Node: require / import.'),
  require: k('require', 'Not available in scripts. Use the functions listed in the reference instead.', ''),
  export: k('export', 'Not available in scripts. A script gives its result with return.', 'return { created: 3 };'),
  enum: k('enum', 'Reserved but unused in JavaScript. Use an object: const Color = { RED: "red", BLUE: "blue" };', ''),
  debugger: k('debugger;', 'Pauses in a debugger. Does nothing in a script; use log.debug(…) instead.', ''),
});
// A few older entries get a note for readers of other languages.
KEYWORDS.of.coming = 'Python: for x in items. Java/C#: foreach. Use "in" only for an object\'s keys.';
KEYWORDS.const.coming = 'Java: final. Rust: let. Go: const is for compile-time values only.';
KEYWORDS.try.coming = 'Python: try / except / finally. Ruby: begin / rescue / ensure. Java: try / catch / finally.';
KEYWORDS.throw.coming = 'Python: raise. Ruby: raise. Java: throw.';
KEYWORDS.null.coming = 'Python: None. Ruby: nil. SQL: NULL.';
KEYWORDS.true.coming = 'Python: True (capital T). Shell: 0 is "success".';
KEYWORDS.false.coming = 'Python: False (capital F).';
KEYWORDS.typeof.coming = 'Python: type(x). Java: x.getClass().';
KEYWORDS.new.coming = 'Python: no new keyword, just Class(). Java/C#: the same word.';
KEYWORDS.return.coming = 'Python/Java/C: the same word. A function with no return gives undefined (Python: None).';

export const GLOBALS = {
  parseInt: e('parseInt(text, radix = 10)', 'Reads a whole number from the start of some text. Always pass the radix.', 'number, or NaN if the text does not start with a number.', 'parseInt("42px", 10);  // 42', 'text, and the base (2–36)'),
  parseFloat: e('parseFloat(text)', 'Reads a decimal number from the start of some text.', 'number, or NaN.', 'parseFloat("3.5kg");  // 3.5'),
  isNaN: e('isNaN(value)', 'Whether the value is NaN after converting it to a number. Number.isNaN does not convert and is usually what you want.', 'boolean.', 'isNaN("abc");  // true'),
  isFinite: e('isFinite(value)', 'Whether the value is a number that is not NaN or Infinity, after converting it.', 'boolean.', 'isFinite("12");  // true'),
  encodeURIComponent: e('encodeURIComponent(text)', 'Escapes text for use inside a URL, such as one query-string value.', 'string.', 'const url = "https://api.example.net/people?q=" + encodeURIComponent(name);'),
  decodeURIComponent: e('decodeURIComponent(text)', 'Reverses encodeURIComponent.', 'string.', 'decodeURIComponent("a%20b");  // "a b"', 'escaped text'),
  encodeURI: e('encodeURI(url)', 'Escapes a whole URL, leaving characters such as / ? & = alone.', 'string.', 'encodeURI("https://example.net/a b");  // "https://example.net/a%20b"'),
  decodeURI: e('decodeURI(url)', 'Reverses encodeURI.', 'string.'),
  NaN: e('NaN', '"Not a number": the result of a failed number conversion. NaN !== NaN, so test it with Number.isNaN.', 'number.'),
  Infinity: e('Infinity', 'Larger than any number. -Infinity is smaller.', 'number.'),
  globalThis: e('globalThis', 'The script\'s global object.', 'object.'),
  Math: e('Math', 'Numeric functions and constants, such as Math.round, Math.max and Math.PI.', 'object.', 'Math.round(2.5);  // 3'),
  JSON: e('JSON', 'Converts between JavaScript values and JSON text: JSON.parse and JSON.stringify.', 'object.'),
  Object: e('Object', 'Helpers for objects: Object.keys, Object.values, Object.entries, Object.assign, Object.fromEntries.', 'object.'),
  Array: e('Array', 'Helpers for arrays: Array.isArray, Array.from, Array.of.', 'object.'),
  String: e('String(value)', 'Converts a value to text. String.fromCharCode and String.raw are also available.', 'string.', 'String(42);  // "42"'),
  Number: e('Number(value)', 'Converts a value to a number (NaN if it cannot). Number.isInteger, Number.isNaN and Number.parseFloat are also available.', 'number.', 'Number("12.5");  // 12.5'),
  Boolean: e('Boolean(value)', 'Converts a value to true or false. Empty text, 0, null, undefined and NaN are false; everything else is true.', 'boolean.', 'Boolean("");  // false'),
  BigInt: e('BigInt(value)', 'Converts a whole number to a BigInt, which has no size limit. BigInts cannot be mixed with ordinary numbers.', 'bigint.', 'BigInt(2) ** 70n;'),
  Date: e('new Date(value?)', 'A moment in time. With no argument it is now; give an ISO string or milliseconds since 1970. Times from the server are ISO strings in UTC.', 'Date.', 'const d = new Date("2026-10-01T10:00:00Z");\nd.toISOString();', 'nothing, an ISO string, milliseconds, or (year, month, day, …)'),
  Map: e('new Map(entries?)', 'A key → value collection that keeps insertion order and accepts any value as a key. Methods: get, set, has, delete, size, keys, values, entries.', 'Map.', 'const byName = new Map(users.map((u) => [u.username, u]));\nbyName.get("srivera");'),
  Set: e('new Set(values?)', 'A collection of unique values. Methods: add, has, delete, size.', 'Set.', 'const unique = [...new Set(emails)];'),
  Promise: e('Promise', 'A value that arrives later. Promise.all waits for several, Promise.allSettled waits for several even if some fail, Promise.race takes the first.', 'object.', 'const [a, b] = await Promise.all([fn.one({}), fn.two({})]);'),
  RegExp: e('new RegExp(pattern, flags?)', 'A pattern for matching text. A /literal/ is usually easier to write.', 'RegExp.', 'const digits = new RegExp("\\\\d+", "g");'),
  Error: e('new Error(message)', 'An error value to throw. Also available: TypeError, RangeError, SyntaxError.', 'Error, with message and stack.', 'throw new Error("HR system returned " + r.status);'),
  Symbol: e('Symbol(description?)', 'A unique value, used as an object key that cannot clash.', 'symbol.'),
  Intl: e('Intl', 'Locale-aware formatting: Intl.DateTimeFormat, Intl.NumberFormat, Intl.Collator.', 'object.', 'new Intl.NumberFormat("en-US").format(1234567);  // "1,234,567"'),
  Proxy: e('new Proxy(target, handler)', 'Wraps an object to intercept reads and writes.', 'Proxy.'),
  Reflect: e('Reflect', 'Functional versions of object operations such as Reflect.has and Reflect.ownKeys.', 'object.'),
  WeakMap: e('new WeakMap()', 'Like Map, but keys must be objects and do not stay alive because of it.', 'WeakMap.'),
  WeakSet: e('new WeakSet()', 'Like Set, but only holds objects and does not keep them alive.', 'WeakSet.'),
};

export const STATICS = {
  'Math.round': e('Math.round(x)', 'Rounds to the nearest whole number; .5 rounds up.', 'number.', 'Math.round(4.5);  // 5'),
  'Math.floor': e('Math.floor(x)', 'Rounds down.', 'number.', 'Math.floor(-1.5);  // -2'),
  'Math.ceil': e('Math.ceil(x)', 'Rounds up.', 'number.', 'Math.ceil(1.1);  // 2'),
  'Math.trunc': e('Math.trunc(x)', 'Drops the decimal part.', 'number.', 'Math.trunc(-1.9);  // -1'),
  'Math.abs': e('Math.abs(x)', 'The number without its sign.', 'number.', 'Math.abs(-3);  // 3'),
  'Math.max': e('Math.max(...numbers)', 'The largest argument. With no arguments it is -Infinity. For an array, spread it.', 'number.', 'Math.max(...ages);'),
  'Math.min': e('Math.min(...numbers)', 'The smallest argument. With no arguments it is Infinity.', 'number.', 'Math.min(3, 1, 2);  // 1'),
  'Math.pow': e('Math.pow(base, exponent)', 'base raised to exponent. base ** exponent is the same.', 'number.', 'Math.pow(2, 10);  // 1024'),
  'Math.sqrt': e('Math.sqrt(x)', 'The square root.', 'number, or NaN for a negative.', 'Math.sqrt(9);  // 3'),
  'Math.random': e('Math.random()', 'A pseudo-random number from 0 up to, but not including, 1. Not secure: use util.randomPassword or util.uuid for secrets.', 'number.', 'const pick = list[Math.floor(Math.random() * list.length)];'),
  'Math.sign': e('Math.sign(x)', '-1, 0 or 1 for the sign of x.', 'number.'),
  'Math.log': e('Math.log(x)', 'The natural logarithm. Math.log10 and Math.log2 also exist.', 'number.'),
  'Math.PI': e('Math.PI', 'π, about 3.14159.', 'number.'),
  'JSON.stringify': e('JSON.stringify(value, replacer?, indent?)', 'Turns a value into JSON text. Functions and undefined are left out; a circular object throws.', 'string.', 'JSON.stringify({ a: 1 }, null, 2);', 'the value, an optional replacer, and spaces to indent by'),
  'JSON.parse': e('JSON.parse(text)', 'Turns JSON text into a value.', 'The value.', 'const data = JSON.parse(r.text);', 'JSON text'),
  'Object.keys': e('Object.keys(obj)', 'The object\'s own property names.', 'string[].', 'Object.keys({ a: 1, b: 2 });  // ["a", "b"]'),
  'Object.values': e('Object.values(obj)', 'The object\'s own property values.', 'array.', 'Object.values({ a: 1, b: 2 });  // [1, 2]'),
  'Object.entries': e('Object.entries(obj)', 'The object\'s own [key, value] pairs.', '[string, any][].', 'for (const [k, v] of Object.entries(user.attributes)) log(k, v);'),
  'Object.fromEntries': e('Object.fromEntries(pairs)', 'Builds an object from [key, value] pairs. The reverse of Object.entries.', 'object.', 'Object.fromEntries(users.map((u) => [u.username, u.email]));'),
  'Object.assign': e('Object.assign(target, ...sources)', 'Copies properties from the sources onto target, which is changed and returned. To copy without changing, use { ...a, ...b }.', 'target.', 'const merged = Object.assign({}, defaults, input);'),
  'Object.freeze': e('Object.freeze(obj)', 'Stops an object from being changed.', 'The same object.'),
  'Array.isArray': e('Array.isArray(value)', 'Whether the value is an array. typeof says "object" for arrays.', 'boolean.', 'const list = Array.isArray(input.ids) ? input.ids : [input.ids];'),
  'Array.from': e('Array.from(iterable, mapFn?)', 'Makes an array from anything iterable, or from { length: n }.', 'array.', 'Array.from({ length: 3 }, (_, i) => i * 2);  // [0, 2, 4]'),
  'Array.of': e('Array.of(...items)', 'An array of the arguments.', 'array.'),
  'Number.isInteger': e('Number.isInteger(value)', 'Whether the value is a whole number. No conversion is done.', 'boolean.', 'Number.isInteger(4.0);  // true'),
  'Number.isNaN': e('Number.isNaN(value)', 'Whether the value is exactly NaN. No conversion is done.', 'boolean.', 'Number.isNaN(Number("abc"));  // true'),
  'Number.isFinite': e('Number.isFinite(value)', 'Whether the value is a number that is not NaN or Infinity.', 'boolean.'),
  'Number.parseInt': e('Number.parseInt(text, radix)', 'The same as parseInt.', 'number.'),
  'Number.parseFloat': e('Number.parseFloat(text)', 'The same as parseFloat.', 'number.'),
  'Number.MAX_SAFE_INTEGER': e('Number.MAX_SAFE_INTEGER', 'The largest whole number that is stored exactly, 9007199254740991.', 'number.'),
  'String.fromCharCode': e('String.fromCharCode(...codes)', 'Text from UTF-16 character codes.', 'string.', 'String.fromCharCode(72, 105);  // "Hi"'),
  'Date.now': e('Date.now()', 'The current time as milliseconds since 1 January 1970 UTC.', 'number.', 'const started = Date.now();\n…\nlog("took", Date.now() - started, "ms");'),
  'Date.parse': e('Date.parse(text)', 'Milliseconds since 1970 for a date string, or NaN. An ISO string such as "2026-10-01T10:00:00Z" is the reliable form.', 'number.'),
  'Date.UTC': e('Date.UTC(year, month, day?, …)', 'Milliseconds since 1970 for a UTC date. month counts from 0.', 'number.'),
  'Promise.all': e('Promise.all(promises)', 'Waits for every promise. Rejects at once if any rejects. Results are in the order given. Mind the run\'s call limits when starting many calls at once.', 'A promise of an array.', 'const [a, b] = await Promise.all([idp.users.find({ username: "a" }), idp.users.find({ username: "b" })]);'),
  'Promise.allSettled': e('Promise.allSettled(promises)', 'Waits for every promise, whether it succeeds or fails.', 'A promise of { status: "fulfilled", value } | { status: "rejected", reason }[].', 'const results = await Promise.allSettled(names.map((n) => idp.users.find({ username: n })));'),
  'Promise.race': e('Promise.race(promises)', 'Settles as soon as the first promise does.', 'A promise.'),
  'Promise.resolve': e('Promise.resolve(value)', 'A promise already resolved with the value.', 'A promise.'),
  'Promise.reject': e('Promise.reject(reason)', 'A promise already rejected.', 'A promise.'),
  'Symbol.iterator': e('Symbol.iterator', 'The key an object uses to say how it is looped over with for…of.', 'symbol.'),
  'Intl.NumberFormat': e('new Intl.NumberFormat(locale, options)', 'Formats numbers for a locale. Call .format(n).', 'NumberFormat.', 'new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(12.5);  // "$12.50"'),
  'Intl.DateTimeFormat': e('new Intl.DateTimeFormat(locale, options)', 'Formats dates for a locale and time zone. Call .format(date).', 'DateTimeFormat.', 'new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date());'),
};

// Methods. Names used by more than one type list each, so the tip is right whichever one the receiver is.
const M = Object.create(null);  // no prototype, so a method named toString is an ordinary key
const add = (name, ...entries) => { M[name] = [...(M[name] || []), ...entries]; };

// Array
add('map', e('array.map((item, index) => value)', 'A new array of what the callback returns for each item. A callback that awaits gives promises: wrap in Promise.all.', 'array.', 'users.map((u) => u.email);'));
add('filter', e('array.filter((item, index) => boolean)', 'A new array of the items for which the callback returns true.', 'array.', 'users.filter((u) => u.active);'));
add('find', e('array.find((item, index) => boolean)', 'The first item for which the callback returns true.', 'The item, or undefined.', 'const sam = users.find((u) => u.username === "srivera");'));
add('findIndex', e('array.findIndex((item, index) => boolean)', 'The position of the first matching item.', 'number, or -1.', 'users.findIndex((u) => !u.active);'));
add('findLast', e('array.findLast((item) => boolean)', 'Like find, from the end.', 'The item, or undefined.'));
add('some', e('array.some((item) => boolean)', 'Whether at least one item matches.', 'boolean.', 'users.some((u) => !u.active);'));
add('every', e('array.every((item) => boolean)', 'Whether every item matches. True for an empty array.', 'boolean.', 'rows.every((r) => r.email);'));
add('reduce', e('array.reduce((total, item) => total, start)', 'Folds the items into one value. Always give a start value; without it an empty array throws.', 'The final total.', 'const sum = amounts.reduce((t, n) => t + n, 0);'));
add('forEach', e('array.forEach((item, index) => void)', 'Calls the callback for each item. It does not wait for async callbacks: use for…of with await instead.', 'undefined.', 'users.forEach((u) => log(u.username));'));
add('flat', e('array.flat(depth = 1)', 'Flattens nested arrays.', 'array.', '[[1], [2, 3]].flat();  // [1, 2, 3]'));
add('flatMap', e('array.flatMap((item) => array)', 'map then flat by one level.', 'array.', 'groups.flatMap((g) => g.members);'));
add('push', e('array.push(...items)', 'Adds items to the end. Changes the array.', 'The new length.', 'created.push(user.username);'));
add('pop', e('array.pop()', 'Removes and returns the last item. Changes the array.', 'The item, or undefined.'));
add('shift', e('array.shift()', 'Removes and returns the first item. Changes the array.', 'The item, or undefined.'));
add('unshift', e('array.unshift(...items)', 'Adds items to the start. Changes the array.', 'The new length.'));
add('splice', e('array.splice(start, deleteCount, ...items)', 'Removes and/or inserts items in place. Changes the array.', 'The removed items.', 'list.splice(1, 2);'));
add('sort', e('array.sort(compare?)', 'Sorts in place. Without a compare function items are sorted as text, so 10 comes before 9: pass (a, b) => a - b for numbers.', 'The same array.', 'users.sort((a, b) => a.last_name.localeCompare(b.last_name));'));
add('reverse', e('array.reverse()', 'Reverses in place.', 'The same array.'));
add('join', e('array.join(separator = ",")', 'Joins the items into text.', 'string.', '["a", "b"].join(", ");  // "a, b"'));
add('concat', e('array.concat(...arrays)', 'A new array with the others added on. [...a, ...b] is the same.', 'array.'), e('string.concat(...parts)', 'Joins text onto this text. A template string or + is more usual.', 'string.'));
add('includes', e('array.includes(value)', 'Whether the array has the value (compared with ===, but NaN matches).', 'boolean.', '["a", "b"].includes("a");  // true'), e('string.includes(search, from = 0)', 'Whether the text contains the search text.', 'boolean.', '"sam@example.net".includes("@");  // true'));
add('indexOf', e('array.indexOf(value)', 'The position of the first match.', 'number, or -1.'), e('string.indexOf(search, from = 0)', 'The position of the first match.', 'number, or -1.', '"a.b".indexOf(".");  // 1'));
add('lastIndexOf', e('array.lastIndexOf(value)', 'The position of the last match.', 'number, or -1.'), e('string.lastIndexOf(search)', 'The position of the last match.', 'number, or -1.'));
add('slice', e('array.slice(start, end?)', 'A copy of part of the array. Negative numbers count from the end.', 'array.', 'list.slice(0, 10);'), e('string.slice(start, end?)', 'Part of the text. Negative numbers count from the end.', 'string.', '"srivera".slice(0, 1);  // "s"'));
add('at', e('array.at(index)', 'The item at a position; negative counts from the end.', 'The item, or undefined.', 'list.at(-1);  // the last'), e('string.at(index)', 'The character at a position; negative counts from the end.', 'string, or undefined.'));
add('fill', e('array.fill(value, start?, end?)', 'Sets items to a value in place.', 'The same array.'));
add('keys', e('array.keys()  /  map.keys()', 'An iterator of indexes (array) or keys (Map). Spread it for an array.', 'iterator.'));
add('values', e('array.values()  /  map.values()  /  set.values()', 'An iterator of the values.', 'iterator.'));
add('entries', e('array.entries()  /  map.entries()', 'An iterator of [index or key, value] pairs.', 'iterator.', 'for (const [i, u] of users.entries()) log(i, u.username);'));

// String
add('split', e('string.split(separator, limit?)', 'Splits text into an array at each separator. A /regex/ also works.', 'string[].', '"a,b,c".split(",");  // ["a", "b", "c"]'));
add('trim', e('string.trim()', 'Removes spaces and line breaks from both ends. trimStart and trimEnd do one end.', 'string.', '" Sam ".trim();  // "Sam"'));
add('trimStart', e('string.trimStart()', 'Removes spaces from the start.', 'string.'));
add('trimEnd', e('string.trimEnd()', 'Removes spaces from the end.', 'string.'));
add('toLowerCase', e('string.toLowerCase()', 'The text in lower case. Use it before comparing email addresses.', 'string.', 'email.toLowerCase();'));
add('toUpperCase', e('string.toUpperCase()', 'The text in upper case.', 'string.'));
add('startsWith', e('string.startsWith(search, from = 0)', 'Whether the text begins with the search text.', 'boolean.', 'username.startsWith("svc-");'));
add('endsWith', e('string.endsWith(search)', 'Whether the text ends with the search text.', 'boolean.', 'email.endsWith("@example.net");'));
add('replace', e('string.replace(search, replacement)', 'Replaces the first match. A /regex/g replaces all. The replacement can be a function.', 'string.', '"a-b-c".replace("-", "_");  // "a_b-c"'));
add('replaceAll', e('string.replaceAll(search, replacement)', 'Replaces every match.', 'string.', '"a-b-c".replaceAll("-", "_");  // "a_b_c"'));
add('padStart', e('string.padStart(length, fill = " ")', 'Pads the start until the text is that long.', 'string.', '"7".padStart(3, "0");  // "007"'));
add('padEnd', e('string.padEnd(length, fill = " ")', 'Pads the end until the text is that long.', 'string.'));
add('repeat', e('string.repeat(count)', 'The text repeated.', 'string.'));
add('charAt', e('string.charAt(index)', 'The character at a position, or "".', 'string.'));
add('charCodeAt', e('string.charCodeAt(index)', 'The UTF-16 code of the character at a position.', 'number.'));
add('substring', e('string.substring(start, end?)', 'Part of the text. Prefer slice.', 'string.'));
add('localeCompare', e('string.localeCompare(other)', 'Compares text in the way people sort it. Negative if it comes first, 0 if equal, positive if after. Use it as a sort callback.', 'number.', 'names.sort((a, b) => a.localeCompare(b));'));
add('normalize', e('string.normalize("NFD")', 'Puts accented characters in a standard form. With "NFD" and a regex you can strip accents.', 'string.', 'name.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");'));
add('match', e('string.match(regex)', 'Matches text against a /regex/. Without the g flag the result has the groups; with it, every match.', 'array, or null.', '"id=42".match(/id=(\\d+)/)?.[1];  // "42"'));
add('matchAll', e('string.matchAll(regex)', 'Every match of a /regex/g, with its groups.', 'iterator.', 'for (const m of text.matchAll(/@(\\w+)/g)) log(m[1]);'));
add('search', e('string.search(regex)', 'The position of the first match.', 'number, or -1.'));

// RegExp
add('test', e('regex.test(text)', 'Whether the text matches the pattern. Careful with the g flag: it remembers where it stopped.', 'boolean.', '/^[^@\\s]+@[^@\\s]+$/.test(input.email);'));
add('exec', e('regex.exec(text)', 'The next match with its groups.', 'array, or null.'));

// Number
add('toFixed', e('number.toFixed(digits)', 'The number as text with a fixed count of decimals (rounded).', 'string.', '(3.14159).toFixed(2);  // "3.14"'));
add('toString', e('value.toString(radix?)', 'The value as text. A number takes a base: (255).toString(16) is "ff".', 'string.'));
add('toLocaleString', e('value.toLocaleString(locale?, options?)', 'The number or date as text in a locale.', 'string.', '(1234567).toLocaleString("en-US");  // "1,234,567"'));
add('toPrecision', e('number.toPrecision(digits)', 'The number as text with that many significant digits.', 'string.'));

// Date
add('getTime', e('date.getTime()', 'Milliseconds since 1970 UTC. Subtract two for a difference.', 'number.', '(new Date() - new Date(user.created_at)) / 86400000;  // days'));
add('toISOString', e('date.toISOString()', 'The date as an ISO 8601 string in UTC, the form the server uses.', 'string.', 'new Date().toISOString();  // "2026-10-27T09:30:00.000Z"'));
add('getUTCFullYear', e('date.getUTCFullYear()', 'The year in UTC. See also getUTCMonth (0–11), getUTCDate, getUTCDay (0 = Sunday), getUTCHours, getUTCMinutes.', 'number.'));
add('getUTCMonth', e('date.getUTCMonth()', 'The month in UTC, counted from 0 (January).', 'number.'));
add('getUTCDate', e('date.getUTCDate()', 'The day of the month in UTC (1–31).', 'number.'));
add('getUTCDay', e('date.getUTCDay()', 'The day of the week in UTC (0 = Sunday).', 'number.'));
add('setUTCDate', e('date.setUTCDate(day)', 'Sets the day of the month in UTC. Days past the end roll into the next month, so date.setUTCDate(date.getUTCDate() + 30) adds 30 days. Changes the date.', 'number: the new time.', 'const due = new Date();\ndue.setUTCDate(due.getUTCDate() + 30);'));
add('toDateString', e('date.toDateString()', 'The date part as readable text, in the server\'s time zone.', 'string.'));

// Map, Set, Promise, Error, objects
add('get', e('map.get(key)', 'The value stored for a key.', 'The value, or undefined.'));
add('set', e('map.set(key, value)', 'Stores a value for a key.', 'The same Map.'));
add('has', e('map.has(key)  /  set.has(value)', 'Whether the key or value is present.', 'boolean.'));
add('add', e('set.add(value)', 'Adds a value.', 'The same Set.'));
add('delete', e('map.delete(key)  /  set.delete(value)', 'Removes an entry.', 'boolean: whether it was there.'));
add('clear', e('map.clear()  /  set.clear()', 'Removes everything.', 'undefined.'));
add('then', e('promise.then(onValue, onError?)', 'Runs a callback when the promise resolves. With await you rarely need it.', 'A new promise.'));
add('catch', e('promise.catch(onError)', 'Runs a callback if the promise rejects.', 'A new promise.'));
add('finally', e('promise.finally(callback)', 'Runs a callback when the promise settles either way.', 'A new promise.'));
add('hasOwnProperty', e('object.hasOwnProperty(name)', 'Whether the object has the property itself, not inherited. Object.hasOwn(obj, name) is safer.', 'boolean.'));
add('message', e('error.message', 'The readable description of an Error.', 'string.', 'catch (err) { log.error(err.message); }'));
add('length', e('value.length', 'How many items an array has, or characters a string has.', 'number.', 'users.length;'));

export const MEMBERS = M;
