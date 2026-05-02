import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_ORG: string
  SYNC_SECRET: string
}

const REPO_MAP: Record<string, string> = {
  skill: 'agentkit-skills',
  prompt: 'agentkit-prompts',
  mcp: 'agentkit-mcp',
  plugin: 'agentkit-plugins',
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS：只允許 agentkit 前端來源
app.use('/*', cors({
  origin: (origin) => {
    if (!origin) return null
    // 允許 localhost / 區網 IP（本機開發）與 github.io（生產）
    if (origin.includes('localhost') || origin.includes('192.168.') || origin.includes('github.io')) return origin
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

/** Validate SYNC_SECRET for internal sync endpoints */
function authSync(c: { req: { header: (n: string) => string | undefined }; env: Bindings }): boolean {
  const h = c.req.header('Authorization')
  return h?.startsWith('Bearer ') === true && h.slice(7) === c.env.SYNC_SECRET
}

/** Build a prepared statement to upsert a single package into D1 */
function buildUpsertStmt(
  db: D1Database,
  org: string,
  payload: { type: string; name: string; repo: string; manifest: Record<string, unknown> },
): D1PreparedStatement {
  const { type, name, repo, manifest } = payload
  const id = `${type}/${name}`
  const agentkit = manifest._agentkit as Record<string, unknown> | undefined
  const author = manifest.author as Record<string, unknown> | undefined

  return db.prepare(`
    INSERT OR REPLACE INTO packages
      (id, type, name, version, description, tags, compatible,
       author_name, author_github, license, repo_path, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    id,
    type,
    name,
    String(manifest.version ?? '0.0.0'),
    String(manifest.description ?? ''),
    JSON.stringify(Array.isArray(agentkit?.tags) ? agentkit.tags : []),
    JSON.stringify(Array.isArray(agentkit?.compatible) ? agentkit.compatible : []),
    String(author?.name ?? name),
    String(author?.github ?? '') || null,
    String(manifest.license ?? '') || null,
    `https://raw.githubusercontent.com/${org}/${repo}/main/${name}`,
  )
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

// ─── GET /packages ───────────────────────────────────────

app.get('/packages', async (c) => {
  const rawQ    = c.req.query('q')?.trim() ?? ''
  const rawType = c.req.query('type') ?? ''
  const sort    = c.req.query('sort') ?? 'downloads'
  const offset  = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10))
  const limit   = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))

  const validTypes = ['skill', 'prompt', 'mcp', 'plugin']
  const typeFilter = validTypes.includes(rawType) ? rawType : null

  // Optional auth — provides liked_by_me when present
  const authHeader = c.req.header('Authorization')
  let username: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    username = await getGitHubUser(authHeader.slice(7))
  }

  // Build FTS5 query: split on whitespace, strip special chars, add prefix wildcard
  const ftsQuery = rawQ
    ? rawQ.split(/\s+/).filter(Boolean).map((w) => `${w.replace(/['"()*:^]/g, '')}*`).join(' ')
    : null

  const likedByMeSql = username
    ? `CASE WHEN EXISTS(SELECT 1 FROM package_likes WHERE package_id = p.id AND github_user = ?) THEN 1 ELSE 0 END`
    : `0`

  const orderBySql =
    sort === 'likes'   ? `ORDER BY (SELECT COUNT(*) FROM package_likes pl WHERE pl.package_id = p.id) DESC` :
    sort === 'updated' ? `ORDER BY p.synced_at DESC` :
                         `ORDER BY COALESCE(ps.downloads, 0) DESC`

  type PackageRow = {
    id: string; type: string; name: string; version: string; description: string
    tags: string; compatible: string; author_name: string; author_github: string | null
    license: string | null; repo_path: string; synced_at: string
    downloads: number; likes: number; liked_by_me: number
  }

  let countSql: string
  let listSql: string
  const countParams: unknown[] = []
  const listParams: unknown[] = []

  if (ftsQuery) {
    const typeWhere = typeFilter ? 'AND p.type = ?' : ''
    countSql = `
      SELECT COUNT(*) as total
      FROM packages_fts fts
      JOIN packages p ON p.rowid = fts.rowid
      WHERE packages_fts MATCH ? ${typeWhere}`
    countParams.push(ftsQuery)
    if (typeFilter) countParams.push(typeFilter)

    listSql = `
      SELECT p.id, p.type, p.name, p.version, p.description, p.tags, p.compatible,
        p.author_name, p.license, p.repo_path, p.synced_at,
        COALESCE(ps.downloads, 0) as downloads,
        (SELECT COUNT(*) FROM package_likes pl WHERE pl.package_id = p.id) as likes,
        ${likedByMeSql} as liked_by_me
      FROM packages_fts fts
      JOIN packages p ON p.rowid = fts.rowid
      LEFT JOIN package_stats ps ON ps.package_id = p.id
      WHERE packages_fts MATCH ? ${typeWhere}
      ${orderBySql} LIMIT ? OFFSET ?`
    if (username) listParams.push(username)
    listParams.push(ftsQuery)
    if (typeFilter) listParams.push(typeFilter)
    listParams.push(limit, offset)
  } else {
    const typeWhere = typeFilter ? 'WHERE p.type = ?' : ''
    countSql = `SELECT COUNT(*) as total FROM packages p ${typeWhere}`
    if (typeFilter) countParams.push(typeFilter)

    listSql = `
      SELECT p.id, p.type, p.name, p.version, p.description, p.tags, p.compatible,
        p.author_name, p.license, p.repo_path, p.synced_at,
        COALESCE(ps.downloads, 0) as downloads,
        (SELECT COUNT(*) FROM package_likes pl WHERE pl.package_id = p.id) as likes,
        ${likedByMeSql} as liked_by_me
      FROM packages p
      LEFT JOIN package_stats ps ON ps.package_id = p.id
      ${typeWhere} ${orderBySql} LIMIT ? OFFSET ?`
    if (username) listParams.push(username)
    if (typeFilter) listParams.push(typeFilter)
    listParams.push(limit, offset)
  }

  const [countResult, listResult] = await Promise.all([
    c.env.DB.prepare(countSql).bind(...countParams).first<{ total: number }>(),
    c.env.DB.prepare(listSql).bind(...listParams).all<PackageRow>(),
  ])

  const total = countResult?.total ?? 0
  const rows = listResult.results ?? []

  const pkgs = rows.map((row) => ({
    id: row.id,
    type: row.type,
    name: row.name,
    version: row.version,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    compatible: JSON.parse(row.compatible) as string[],
    author: row.author_name,
    license: row.license ?? '',
    updatedAt: row.synced_at,
    repoPath: row.repo_path,
    downloads: row.downloads,
    likes: row.likes,
    liked_by_me: row.liked_by_me === 1,
  }))

  return c.json({ packages: pkgs, total, offset, limit })
})

// ─── POST /sync ──────────────────────────────────────────

app.post('/sync', async (c) => {
  if (!authSync(c)) return c.json({ error: 'unauthorized' }, 401)

  const body = await c.req.json<{
    type: string
    name: string
    repo: string
    manifest: Record<string, unknown>
  }>()

  if (!body.type || !body.name || !body.repo || !body.manifest || typeof body.manifest !== 'object') {
    return c.json({ error: 'missing required fields: type, name, repo, manifest' }, 400)
  }

  await buildUpsertStmt(c.env.DB, c.env.GITHUB_ORG, body).run()
  return c.json({ ok: true })
})

// ─── POST /sync/bulk ─────────────────────────────────────

app.post('/sync/bulk', async (c) => {
  if (!authSync(c)) return c.json({ error: 'unauthorized' }, 401)

  const { packages } = await c.req.json<{
    packages: Array<{ type: string; name: string; repo: string; manifest: Record<string, unknown> }>
  }>()

  if (!Array.isArray(packages)) return c.json({ error: 'packages must be an array' }, 400)

  const batch = packages.slice(0, 500).filter(
    (p) => p.type && p.name && p.repo && p.manifest && typeof p.manifest === 'object',
  )

  if (batch.length === 0) return c.json({ ok: true, count: 0 })

  const stmts = batch.map((p) => buildUpsertStmt(c.env.DB, c.env.GITHUB_ORG, p))
  await c.env.DB.batch(stmts)
  return c.json({ ok: true, count: batch.length })
})

export default app
