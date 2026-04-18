// comments-worker.js (纯 JS 版本，无需 npm 依赖)
export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);

    // GET 评论
    if (request.method === 'GET' && url.pathname === '/comments') {
      const slug = url.searchParams.get('slug');
      if (!slug) return new Response('Missing slug', { status: 400 });

      try {
        const octokit = await getInstallationOctokit(env);
        const filePath = `comments/${slug}.json`;

        let response;
        try {
          response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: filePath,
            ref: env.GITHUB_BRANCH || 'main',
          });
        } catch (error) {
          if (error.status === 404) {
            return new Response(JSON.stringify([]), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
          }
          throw error;
        }

        const content = atob(response.data.content);
        const comments = JSON.parse(content);
        return new Response(JSON.stringify(comments), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to fetch comments' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // POST 评论
    if (request.method === 'POST' && url.pathname === '/comments') {
      try {
        const body = await request.json();
        const { slug, author, content, email } = body;

        if (!slug || !author || !content) {
          return new Response('Missing required fields', { status: 400 });
        }

        const sanitizedContent = content.replace(/<[^>]*>/g, '');
        const newComment = {
          id: crypto.randomUUID(),
          author: author.trim(),
          content: sanitizedContent,
          email: email || '',
          timestamp: new Date().toISOString(),
        };

        const octokit = await getInstallationOctokit(env);
        const filePath = `comments/${slug}.json`;

        let existingSha = null;
        let existingComments = [];

        try {
          const getResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: filePath,
            ref: env.GITHUB_BRANCH || 'main',
          });
          existingSha = getResponse.data.sha;
          existingComments = JSON.parse(atob(getResponse.data.content));
        } catch (error) {
          if (error.status !== 404) throw error;
        }

        const allComments = [...existingComments, newComment];
        const fileContent = JSON.stringify(allComments, null, 2);
        const base64Content = btoa(unescape(encodeURIComponent(fileContent)));

        const putBody = {
          message: `Add comment from ${author} on ${slug}`,
          content: base64Content,
          branch: env.GITHUB_BRANCH || 'main',
        };
        if (existingSha) putBody.sha = existingSha;

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
          owner: env.GITHUB_OWNER,
          repo: env.GITHUB_REPO,
          path: filePath,
          ...putBody,
        });

        return new Response(JSON.stringify({ success: true, comment: newComment }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---------- 纯 JS 实现 GitHub App 认证（无需 @octokit/app）----------
async function getInstallationOctokit(env) {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;

  // 生成 JWT
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const header = { alg: 'RS256', typ: 'JWT' };

  const pemContents = privateKey
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const encode = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedHeader = encode(header);
  const encodedPayload = encode(payload);
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signatureInput));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signatureInput}.${encodedSignature}`;

  // 换取安装令牌
  const tokenRes = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-Worker',
    },
  });

  if (!tokenRes.ok) {
    throw new Error(`Failed to get installation token: ${tokenRes.status}`);
  }

  const { token } = await tokenRes.json();

  // 返回简易 Octokit 对象
  return {
    request: async (method, url, options = {}) => {
      const fullUrl = url.startsWith('https://') ? url : `https://api.github.com${url}`;
      const res = await fetch(fullUrl, {
        method,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Cloudflare-Worker',
          ...options.headers,
        },
        body: options.body,
      });

      if (!res.ok) {
        const errText = await res.text();
        const error = new Error(`GitHub API error: ${res.status} ${errText}`);
        error.status = res.status;
        throw error;
      }

      const data = await res.json().catch(() => ({}));
      return { data };
    },
  };
}
