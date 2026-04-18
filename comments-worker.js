// worker.js
import { App } from '@octokit/app';

export default {
  async fetch(request, env) {
    // 处理 CORS 预检请求
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

    // 获取评论列表 (GET /comments?slug=xxx)
    if (request.method === 'GET' && url.pathname === '/comments') {
      const slug = url.searchParams.get('slug');
      if (!slug) {
        return new Response('Missing slug parameter', { status: 400 });
      }

      try {
        const octokit = await getInstallationOctokit(env);
        const filePath = `comments/${slug}.json`;

        // 尝试获取已有文件
        let response;
        try {
          response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: filePath,
            ref: env.GITHUB_BRANCH || 'main',
          });
        } catch (error) {
          // 文件不存在时返回空数组
          if (error.status === 404) {
            return new Response(JSON.stringify([]), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
          throw error;
        }

        // 解码 base64 内容
        const content = atob(response.data.content);
        const comments = JSON.parse(content);

        return new Response(JSON.stringify(comments), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        console.error('GET error:', error);
        return new Response(JSON.stringify({ error: 'Failed to fetch comments' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    // 提交新评论 (POST /comments)
    if (request.method === 'POST' && url.pathname === '/comments') {
      try {
        const body = await request.json();
        const { slug, author, content, email } = body;

        // 基础验证
        if (!slug || !author || !content) {
          return new Response('Missing required fields: slug, author, content', {
            status: 400,
          });
        }

        // 简单的内容清洗（防 XSS）
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

        // 获取现有文件内容及 sha（如果存在）
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
          const content = atob(getResponse.data.content);
          existingComments = JSON.parse(content);
        } catch (error) {
          // 文件不存在，忽略错误，后续会新建
          if (error.status !== 404) {
            throw error;
          }
        }

        // 合并评论
        const allComments = [...existingComments, newComment];
        const fileContent = JSON.stringify(allComments, null, 2);
        // 正确处理中文的 Base64 编码
        const base64Content = btoa(unescape(encodeURIComponent(fileContent)));

        // 提交到 GitHub
        const putBody = {
          message: `Add comment from ${author} on ${slug}`,
          content: base64Content,
          branch: env.GITHUB_BRANCH || 'main',
        };
        if (existingSha) {
          putBody.sha = existingSha;
        }

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
          owner: env.GITHUB_OWNER,
          repo: env.GITHUB_REPO,
          path: filePath,
          ...putBody,
        });

        return new Response(JSON.stringify({ success: true, comment: newComment }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        console.error('POST error:', error);
        return new Response(
          JSON.stringify({ error: 'Failed to submit comment', details: error.message }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }
    }

    // 其他请求返回 404
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * 使用 GitHub App 凭证获取已认证的 Octokit 实例
 */
async function getInstallationOctokit(env) {
  const app = new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
  return await app.getInstallationOctokit(env.GITHUB_APP_INSTALLATION_ID);
}
