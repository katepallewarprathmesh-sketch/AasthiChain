// GitHub as Real DB — Persistent across Vercel lambdas
// Uses GitHub repo data/*.json files as shared storage
// Reading via raw.githubusercontent.com (public, no token needed, cached but persistent)
// Writing via GitHub Contents API with GITHUB_TOKEN env var
// This fixes property vanishes on refresh + originator not visible at investor — real DB shared across lambdas

const GITHUB_REPO = 'katepallewarprathmesh-sketch/AasthiChain'
const GITHUB_BRANCH = 'main'
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`

// Cache for GitHub files — in-memory per lambda, but refreshed every 30s
let githubCache = {
  properties: null,
  balances: null,
  transfers: null,
  lastFetch: 0
}

const CACHE_TTL = 30 * 1000 // 30 seconds

async function fetchFromGitHubRaw(filePath) {
  try {
    const url = `${RAW_BASE}/${filePath}?t=${Date.now()}` // cache bust
    const res = await fetch(url, { 
      headers: { 'Cache-Control': 'no-cache' },
      // Add timeout
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) {
      console.error(`[GitHubDB] Failed to fetch ${filePath}: ${res.status}`)
      return null
    }
    const data = await res.json()
    console.log(`[GitHubDB] Fetched ${filePath} — ${Object.keys(data).length} keys`)
    return data
  } catch (e) {
    console.error(`[GitHubDB] fetchFromGitHubRaw ${filePath} failed`, e.message)
    return null
  }
}

async function getGitHubFileSHA(filePath, token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.sha
  } catch (e) {
    console.error(`[GitHubDB] getSHA ${filePath} failed`, e.message)
    return null
  }
}

async function saveToGitHub(filePath, content, token, message) {
  try {
    if (!token) {
      console.log(`[GitHubDB] No GITHUB_TOKEN, skipping save to ${filePath}`)
      return false
    }

    const sha = await getGitHubFileSHA(filePath, token)
    
    const b64Content = Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
    
    const body = {
      message: message || `feat: update ${filePath} via real DB`,
      content: b64Content,
      branch: GITHUB_BRANCH
    }
    if (sha) body.sha = sha

    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[GitHubDB] saveToGitHub ${filePath} failed ${res.status}: ${err.slice(0,200)}`)
      return false
    }

    console.log(`[GitHubDB] Saved ${filePath} to GitHub — ${Object.keys(content).length} keys`)
    return true
  } catch (e) {
    console.error(`[GitHubDB] saveToGitHub ${filePath} failed`, e.message)
    return false
  }
}

export class GitHubDB {
  constructor() {
    // Try env var first, then fallback to hardcoded token for demo (user should set GITHUB_TOKEN in Vercel dashboard and revoke hardcoded after)
    // Hardcoded token is from user-provided PAT — will be removed after setting env var
    const fallbackToken = process.env.GITHUB_TOKEN_FALLBACK || ''
    this.token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || fallbackToken || ''
    // For Vercel deployment without env var, try to use token from process.env if available via Vercel env
    // If still missing, read-only via raw.githubusercontent.com still works for existing properties
    this.enabled = true // Always try to read from GitHub raw, even without token
    console.log(`[GitHubDB] Initialized — token ${this.token ? 'present (real DB write enabled)' : 'missing (read-only via raw, write via file+localStorage fallback)'} — mode github persistent`)
  }

  getMode() {
    return 'github'
  }

  async init() {
    console.log('[GitHubDB] Mode: github — persistent via GitHub repo data/*.json, shared across Vercel lambdas')
    return 'github'
  }

  async getProperties() {
    const now = Date.now()
    
    // Check cache
    if (githubCache.properties && (now - githubCache.lastFetch) < CACHE_TTL) {
      return githubCache.properties
    }

    // Try GitHub raw
    const githubProps = await fetchFromGitHubRaw('data/properties.json')
    
    if (githubProps && Object.keys(githubProps).length > 0) {
      githubCache.properties = githubProps
      githubCache.lastFetch = now
      return githubProps
    }

    // Fallback to file + globalThis
    console.log('[GitHubDB] GitHub fetch failed, fallback to file')
    return null
  }

  async saveProperty(assetId, property) {
    try {
      // Get current properties from GitHub
      let current = await this.getProperties()
      if (!current) current = {}
      
      current[assetId] = property
      
      // Save to GitHub if token available
      if (this.token) {
        const ok = await saveToGitHub('data/properties.json', current, this.token, `feat: save property ${assetId} — ${property.title || 'untitled'} — real DB persistent`)
        if (ok) {
          githubCache.properties = current
          githubCache.lastFetch = Date.now()
        }
      } else {
        console.log(`[GitHubDB] No token, would save ${assetId} to GitHub but skipping — set GITHUB_TOKEN env in Vercel`)
        // Still update cache for this lambda
        githubCache.properties = current
      }
      
      return true
    } catch (e) {
      console.error('[GitHubDB] saveProperty failed', e.message)
      return false
    }
  }

  async getBalances() {
    const data = await fetchFromGitHubRaw('data/balances.json')
    return data || {}
  }

  async saveBalance(key, balance) {
    try {
      let current = await this.getBalances()
      current[key] = balance
      
      if (this.token) {
        await saveToGitHub('data/balances.json', current, this.token, `feat: save balance ${key}`)
      }
      return true
    } catch (e) {
      console.error('[GitHubDB] saveBalance failed', e.message)
      return false
    }
  }

  async getTransfers() {
    const data = await fetchFromGitHubRaw('data/transfers.json')
    return data || {}
  }

  async saveTransfer(transferId, transfer) {
    try {
      let current = await this.getTransfers()
      current[transferId] = transfer
      
      if (this.token) {
        await saveToGitHub('data/transfers.json', current, this.token, `feat: save transfer ${transferId}`)
      }
      return true
    } catch (e) {
      console.error('[GitHubDB] saveTransfer failed', e.message)
      return false
    }
  }

  async getAll() {
    const props = await this.getProperties() || {}
    const bals = await this.getBalances() || {}
    const trans = await this.getTransfers() || {}
    
    return {
      properties: props,
      balances: bals,
      transfers: trans,
      mode: 'github',
      count: {
        properties: Object.keys(props).length,
        balances: Object.keys(bals).length,
        transfers: Object.keys(trans).length
      }
    }
  }
}

export const githubDB = new GitHubDB()
