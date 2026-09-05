import { BaronError } from '@lonca/baron-core';

/**
 * Turn whatever a person typed for JIRA_SITE into the root every request is built on.
 *
 * The first live `baron init` had this value wrong, and the failure was a raw
 * "Failed to parse URL from n/rest/api/2/project/…" from fetch — nothing named the setting, and
 * nothing said what a good value looks like. People also type the site the way Atlassian shows it,
 * `acme.atlassian.net`, without a scheme. So: add https:// when no scheme is given, drop trailing
 * slashes, and refuse anything that still is not an http(s) URL with a message that names the
 * variable and shows the shape.
 */
export function normalizeSite(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidSite(raw);
  }
  // A bare label such as "n" parses as a host, so the URL check alone would let the exact value
  // the first live run saved through; a real site always has a dot (or is localhost, for a dev
  // instance).
  const plausibleHost = url.hostname.includes('.') || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !plausibleHost) {
    throw invalidSite(raw);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function invalidSite(raw: string): BaronError {
  return new BaronError(
    `JIRA_SITE is '${raw}', which is not a site URL. It should be the root of your Jira Cloud ` +
      'site, e.g. https://acme.atlassian.net — fix it in .baron/credentials (or the environment).',
    'JIRA_CONFIG',
  );
}
