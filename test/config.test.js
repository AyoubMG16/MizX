import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'config-test-secret-'.repeat(4),
};

test('PUBLIC_URL takes precedence over Render environment variables', () => {
  const config = loadConfig({
    ...baseEnv,
    PUBLIC_URL: 'https://public.example.com',
    RENDER_EXTERNAL_URL: 'https://render.example.com',
    RENDER_EXTERNAL_HOSTNAME: 'render.example.com',
  });

  assert.equal(config.publicUrl, 'https://public.example.com');
});

test('RENDER_EXTERNAL_URL is used when PUBLIC_URL is blank', () => {
  const config = loadConfig({
    ...baseEnv,
    PUBLIC_URL: '   ',
    RENDER_EXTERNAL_URL: 'https://mizx.onrender.com',
  });

  assert.equal(config.publicUrl, 'https://mizx.onrender.com');
});

test('RENDER_EXTERNAL_HOSTNAME is used when no public URL is available', () => {
  const config = loadConfig({
    ...baseEnv,
    RENDER_EXTERNAL_HOSTNAME: 'mizx.onrender.com',
  });

  assert.equal(config.publicUrl, 'https://mizx.onrender.com');
});

test('invalid PUBLIC_URL values are rejected', () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        PUBLIC_URL: 'https://example.com/some/path',
      }),
    /PUBLIC_URL must be an origin without a path/,
  );
});
