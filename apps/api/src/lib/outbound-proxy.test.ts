import { describe, expect, it } from 'vitest';
import { outboundProxyNotice, redactProxyUrl } from './outbound-proxy.js';

// W20-10 (UX_TODO INS-63): Node's fetch ignores HTTPS_PROXY without
// NODE_USE_ENV_PROXY=1, so boot says so.
describe('outboundProxyNotice', () => {
  it('says nothing without a proxy', () => {
    expect(outboundProxyNotice({})).toBeNull();
    expect(outboundProxyNotice({ HTTPS_PROXY: '  ' })).toBeNull();
  });

  it('warns when the proxy would be ignored', () => {
    const n = outboundProxyNotice({ HTTPS_PROXY: 'http://proxy.corp:3128' });
    expect(n?.level).toBe('warn');
    expect(n?.message).toContain('NODE_USE_ENV_PROXY');
  });

  it('reports the route when it is honoured, without credentials', () => {
    const n = outboundProxyNotice({
      https_proxy: 'http://user:s3cret@proxy.corp:3128',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,postgres',
    });
    expect(n?.level).toBe('info');
    expect(n?.message).toContain('proxy.corp:3128');
    expect(n?.message).toContain('localhost,postgres');
    expect(n?.message).not.toContain('s3cret');
  });
});

describe('redactProxyUrl', () => {
  it('strips user and password', () => {
    expect(redactProxyUrl('http://a:b@p:8080/')).toBe('http://p:8080');
  });
  it('never echoes an unparseable value', () => {
    expect(redactProxyUrl('not a url with secret')).toBe('(unparseable proxy URL)');
  });
});
