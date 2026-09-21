/** Legacy `/setup/passkey?token=` is ignored. Only a URL fragment may carry a bootstrap token. */

export function consumeSetupTokenFromSearch(href: string): {
  token: string;
  nextUrl: string;
  discardedQueryToken: boolean;
} {
  const url = new URL(href, 'https://placeholder.local');
  const discardedQueryToken = url.searchParams.has('token');
  url.searchParams.delete('token');

  let token = '';
  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (rawHash) {
    const hashParams = new URLSearchParams(rawHash);
    if (hashParams.has('token')) {
      token = hashParams.get('token') || '';
      hashParams.delete('token');
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : '';
    }
  }

  const search = url.searchParams.toString();
  return {
    token,
    nextUrl: `${url.pathname}${search ? `?${search}` : ''}${url.hash}`,
    discardedQueryToken,
  };
}
