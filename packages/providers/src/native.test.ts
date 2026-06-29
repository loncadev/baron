import { describe, expect, it } from 'vitest';
import { type NativeHttp, azureBasicAuth, nativeRequestPlan } from './native.js';

const http: NativeHttp = {
  baseUrl: (env) => `https://dev.azure.com/${env.ORG ?? ''}`,
  authHeader: (env) => azureBasicAuth(env.TOKEN ?? ''),
};

describe('nativeRequestPlan', () => {
  it('builds the URL from base + path + query and attaches the auth header', () => {
    const plan = nativeRequestPlan(
      http,
      { ORG: 'beekod', TOKEN: 't' },
      { method: 'get', path: '/_apis/projects', query: { 'api-version': '7.1' } },
    );
    expect(plan.url).toBe('https://dev.azure.com/beekod/_apis/projects?api-version=7.1');
    expect(plan.method).toBe('GET');
    expect(plan.headers.authorization).toBe(`Basic ${Buffer.from(':t').toString('base64')}`);
    expect(plan.body).toBeUndefined();
  });

  it('serializes a JSON body and sets content-type', () => {
    const plan = nativeRequestPlan(http, {}, { method: 'post', path: 'x', body: { a: 1 } });
    expect(plan.url).toBe('https://dev.azure.com/x');
    expect(plan.headers['content-type']).toBe('application/json');
    expect(plan.body).toBe('{"a":1}');
  });

  it('appends query with & when the path already carries a query string', () => {
    const plan = nativeRequestPlan(
      http,
      {},
      { method: 'get', path: '/x?foo=1', query: { bar: '2' } },
    );
    expect(plan.url).toBe('https://dev.azure.com/x?foo=1&bar=2');
  });
});
