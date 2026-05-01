import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_ORG: string
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS：只允許 agentkit 前端來源
app.use('/*', cors({
  origin: (origin) => {
    if (!origin) return null
    // 允許 localhost（開發）與 github.io（生產）
    if (origin.includes('localhost') || origin.includes('github.io')) return origin
    return null
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ─── 工具函式 ────────────────────────────────────────────

/** 驗證 GitHub token 並回傳 username，失敗回傳 null */
async function getGitHubUser(token: string): Promise<string | null> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'agentkit-api/1.0',
    },
  })
  if (!res.ok) return null
  const data = await res.json() as { login: string }
  return data.login
}

/** 從 Authorization header 取得並驗證 token，回傳 username */
async function authenticate(
  c: { req: { header: (name: string) => string | undefined }, env: Bindings },
): Promise<string | null> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  return getGitHubUser(token)
}

// ─── POST /oauth/token ────────────────────────────────────

app.post('/oauth/token', async (c) => {
  const { code } = await c.req.json<{ code: string }>()
  if (!code) return c.json({ error: 'missing code' }, 400)

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })

  const data = await res.json() as { access_token?: string; error?: string }

  if (!data.access_token) {
    return c.json({ error: data.error ?? 'oauth_failed' }, 400)
  }

  return c.json({ access_token: data.access_token })
})

// ─── GET /packages/stats ─────────────────────────────────

app.get('/packages/stats', async (c) => {
  const username = await authenticate(c)
  if (!username) return c.json({ error: 'unauthorized' }, 401)

  const idsParam = c.req.query('ids')
  if (!idsParam) return c.json({ error: 'missing ids parameter' }, 400)

  const ids = idsParam.split(',').slice(0, 50) // 最多 50 個

  const placeholders = ids.map(() => '?').join(',')

  const [statsRows, likesRows, userLikesRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT package_id, downloads FROM package_stats WHERE package_id IN (${placeholders})`
    ).bind(...ids).all<{ package_id: string; downloads: number }>(),
    c.env.DB.prepare(
      `SELECT package_id, COUNT(*) as count FROM package_likes WHERE package_id IN (${placeholders}) GROUP BY package_id`
    ).bind(...ids).all<{ package_id: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT package_id FROM package_likes WHERE package_id IN (${placeholders}) AND github_user = ?`
    ).bind(...ids, username).all<{ package_id: string }>(),
  ])

  const userLikedSet = new Set(userLikesRows.results?.map(r => r.package_id) ?? [])
  const statsMap = Object.fromEntries(
    (statsRows.results ?? []).map(r => [r.package_id, r.downloads])
  )
  const likesMap = Object.fromEntries(
    (likesRows.results ?? []).map(r => [r.package_id, r.count])
  )

  const result = ids.reduce((acc, id) => {
    acc[id] = {
      downloads: statsMap[id] ?? 0,
      likes: likesMap[id] ?? 0,
      liked_by_me: userLikedSet.has(id),
    }
    return acc
  }, {} as Record<string, { downloads: number; likes: number; liked_by_me: boolean }>)

  return c.json(result)
})

// ─── POST /packages/:type/:name/like ─────────────────────

app.post('/packages/:type/:name/like', async (c) => {
  const username = await authenticate(c)
  if (!username) return c.json({ error: 'unauthorized' }, 401)

  const packageId = `${c.req.param('type')}/${c.req.param('name')}`

  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM package_likes WHERE package_id = ? AND github_user = ?'
  ).bind(packageId, username).first()

  if (existing) {
    await c.env.DB.prepare(
      'DELETE FROM package_likes WHERE package_id = ? AND github_user = ?'
    ).bind(packageId, username).run()
    return c.json({ liked: false })
  } else {
    await c.env.DB.prepare(
      'INSERT INTO package_likes (package_id, github_user) VALUES (?, ?)'
    ).bind(packageId, username).run()
    return c.json({ liked: true })
  }
})

// ─── POST /packages/:type/:name/download ─────────────────

app.post('/packages/:type/:name/download', async (c) => {
  const username = await authenticate(c)
  if (!username) return c.json({ error: 'unauthorized' }, 401)

  const packageId = `${c.req.param('type')}/${c.req.param('name')}`

  await c.env.DB.prepare(`
    INSERT INTO package_stats (package_id, downloads)
    VALUES (?, 1)
    ON CONFLICT(package_id) DO UPDATE SET
      downloads = downloads + 1,
      updated_at = datetime('now')
  `).bind(packageId).run()

  return c.json({ ok: true })
})

export default app
