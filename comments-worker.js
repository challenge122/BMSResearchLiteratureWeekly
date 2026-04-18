// worker.js
export default {
  async fetch(request, env) {
    // CORS 预检处理
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

    // 获取评论列表 (GET)
    if (request.method === 'GET' && url.pathname === '/comments') {
      const slug = url.searchParams.get('slug');
      if (!slug) return new Response('Missing slug', { status: 400 });

      try {
        const filePath = `comments/${slug}.json`;
        const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}`;
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `token ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker-Comments',
          },
        });

        if (response.status === 404) {
          return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        const data = await response.json();
        const content = atob(data.content);
        const comments = JSON.parse(content);
        return new Response(JSON.stringify(comments), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }

    // 提交新评论 (POST)
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

        const filePath = `comments/${slug}.json`;
        const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}`;

        let existingSha = null;
        let existingComments = [];
        const getResponse = await fetch(apiUrl, {
          headers: {
            'Authorization': `token ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker-Comments',
          },
        });

        if (getResponse.ok) {
          const data = await getResponse.json();
          existingSha = data.sha;
          existingComments = JSON.parse(atob(data.content));
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

        const putResponse = await fetch(apiUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `token ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker-Comments',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(putBody),
        });

        if (!putResponse.ok) {
          const errorText = await putResponse.text();
          throw new Error(`GitHub API error: ${putResponse.status} - ${errorText}`);
        }

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
