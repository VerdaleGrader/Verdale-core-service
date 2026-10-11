import { z } from 'zod';
import { buildApp } from '@/routes';
import { ForbiddenError } from '@/errors';

function app(databaseUp = true) {
  const instance = buildApp({
    version: '1.2.3',
    readinessChecks: [{ name: 'database', check: async () => databaseUp }],
  });
  instance.get('/test/forbidden', async () => {
    throw new ForbiddenError('You are not a member of this Space.');
  });
  instance.get('/test/zod', async () => z.object({ name: z.string() }).parse({}));
  instance.get('/test/crash', async () => {
    throw new Error('secret database detail');
  });
  return instance;
}

describe('system endpoints', () => {
  it('reports health with the version', async () => {
    const response = await app().inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '1.2.3' });
  });

  it('is ready only when the database is reachable', async () => {
    const up = await app(true).inject({ method: 'GET', url: '/ready' });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ status: 'ready', checks: { database: true } });

    const down = await app(false).inject({ method: 'GET', url: '/ready' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'not_ready', checks: { database: false } });
  });
});

describe('request id', () => {
  it('reuses a well-formed X-Request-Id and generates one otherwise', async () => {
    const reused = await app().inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc12345-from-frontend' },
    });
    expect(reused.headers['x-request-id']).toBe('abc12345-from-frontend');

    const generated = await app().inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error format', () => {
  it('renders typed errors in the standard shape', async () => {
    const response = await app().inject({ method: 'GET', url: '/test/forbidden' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      status: 403,
      error_code: 'FORBIDDEN',
      message: 'You are not a member of this Space.',
      request_id: response.headers['x-request-id'],
    });
  });

  it('turns validation failures into field details', async () => {
    const response = await app().inject({ method: 'GET', url: '/test/zod' });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error_code).toBe('VALIDATION_FAILED');
    expect(body.details).toEqual([{ field: 'name', message: expect.any(String) }]);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const response = await app().inject({ method: 'GET', url: '/test/crash' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error_code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('secret database detail');
  });

  it('uses the same shape for unknown routes', async () => {
    const response = await app().inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, error_code: 'NOT_FOUND' });
  });
});
