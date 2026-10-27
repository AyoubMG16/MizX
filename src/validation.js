import { AppError } from './errors.js';

function invalid(name, expectation) {
  return new AppError(400, 'VALIDATION_ERROR', `${name} ${expectation}.`);
}

export function bodyObject(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_BODY', 'Request body must be a JSON object or form data.');
  }
  return body;
}

export function optionalString(
  value,
  name,
  { max = 128, trim = true, allowEmpty = false } = {},
) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(name, 'must be a string');

  const result = trim ? value.trim() : value;
  if (!allowEmpty && result.length === 0) return null;
  if (result.length > max) throw invalid(name, `must be at most ${max} characters`);
  return result;
}

export function requiredString(value, name, options = {}) {
  const result = optionalString(value, name, { ...options, allowEmpty: false });
  if (result === null) throw invalid(name, 'is required');
  return result;
}

export function scalarString(value, name, { max = 128 } = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = String(value);
  }
  return requiredString(value, name, { max, trim: true });
}

export function optionalInteger(
  value,
  name,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = null } = {},
) {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value) || (typeof value !== 'number' && typeof value !== 'string')) {
    throw invalid(name, 'must be an integer');
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(name, `must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function oneOf(value, name, values, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (!values.includes(normalized)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${name} must be one of: ${values.join(', ')}.`,
    );
  }
  return normalized;
}

export function optionalBoolean(value, name, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw invalid(name, 'must be a boolean');
}
