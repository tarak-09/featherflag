/**
 * The flag store.
 *
 * In-memory and deliberately so: this service is read-heavy, the dataset is
 * tiny, and evaluation must never depend on a network call. Flags are loaded
 * from a JSON document at startup. A persistent backing store would change the
 * durability story, not the evaluation logic, which is why the two are separate
 * modules.
 */

const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class FlagValidationError extends Error {}

function validateFlag(raw, index) {
  const where = `flags[${index}]`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FlagValidationError(`${where}: expected an object`);
  }

  const allowed = new Set(['key', 'enabled', 'rolloutPercentage', 'include', 'exclude', 'description']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new FlagValidationError(`${where}: unknown field(s): ${unknown.sort().join(', ')}`);
  }

  if (typeof raw.key !== 'string' || !FLAG_KEY_PATTERN.test(raw.key)) {
    throw new FlagValidationError(
      `${where}: 'key' must match ${FLAG_KEY_PATTERN} (lowercase, up to 64 chars)`,
    );
  }

  if (typeof raw.enabled !== 'boolean') {
    throw new FlagValidationError(`${where}: 'enabled' is required and must be a boolean`);
  }

  const rollout = raw.rolloutPercentage ?? 100;
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    throw new FlagValidationError(`${where}: 'rolloutPercentage' must be an integer between 0 and 100`);
  }

  const readSubjects = (field) => {
    const value = raw[field] ?? [];
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || s.length === 0)) {
      throw new FlagValidationError(`${where}: '${field}' must be an array of non-empty strings`);
    }
    return value;
  };

  const include = readSubjects('include');
  const exclude = readSubjects('exclude');

  const overlap = include.filter((s) => exclude.includes(s));
  if (overlap.length > 0) {
    throw new FlagValidationError(
      `${where}: subject(s) in both include and exclude: ${overlap.join(', ')}. ` +
        'Exclude would win, so the include is dead configuration.',
    );
  }

  return Object.freeze({
    key: raw.key,
    enabled: raw.enabled,
    rolloutPercentage: rollout,
    include: Object.freeze(include),
    exclude: Object.freeze(exclude),
    description: raw.description ?? '',
  });
}

export function parseFlags(document) {
  const raw = typeof document === 'string' ? JSON.parse(document) : document;
  const list = Array.isArray(raw) ? raw : raw?.flags;

  if (!Array.isArray(list)) {
    throw new FlagValidationError("expected a JSON array of flags, or an object with a 'flags' array");
  }

  const flags = list.map(validateFlag);

  const seen = new Map();
  flags.forEach((flag, index) => {
    if (seen.has(flag.key)) {
      throw new FlagValidationError(
        `flags[${index}]: duplicate key '${flag.key}' (already defined at flags[${seen.get(flag.key)}])`,
      );
    }
    seen.set(flag.key, index);
  });

  return flags;
}

export class FlagStore {
  #flags;

  constructor(flags = []) {
    this.#flags = new Map(flags.map((flag) => [flag.key, flag]));
  }

  static fromDocument(document) {
    return new FlagStore(parseFlags(document));
  }

  get(key) {
    return this.#flags.get(key);
  }

  has(key) {
    return this.#flags.has(key);
  }

  list() {
    return [...this.#flags.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  get size() {
    return this.#flags.size;
  }
}
