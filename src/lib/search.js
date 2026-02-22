import Fuse from 'fuse.js'

// ── Fuse index (headers only — fast fuzzy matching) ───────────────────────────
const FUSE_OPTIONS = {
  includeScore:      true,
  threshold:         0.4,       // 0 = exact only, 1 = match anything
  minMatchCharLength: 2,
  ignoreLocation:    true,      // don't penalise matches far into the string
  keys: [
    { name: 'block',  weight: 0.6  },
    { name: 'hat',    weight: 0.25 },
    { name: 'pocket', weight: 0.15 },
  ],
}

let fuse      = null
let allBlocks = []   // retained for the content-search pass

export function initSearch(blocks) {
  allBlocks = blocks
  fuse      = new Fuse(blocks, FUSE_OPTIONS)
}

/**
 * Two-pass ranked search.
 *
 * Pass 1 — Fuse.js fuzzy match on block/hat/pocket headers.
 *   Fast, handles typos, returns up to `limit` results scored 0–100.
 *
 * Pass 2 — Exact substring match on full block content.
 *   Only runs when the query is ≥ 4 characters (avoids noise on short terms).
 *   Catches specific evidence phrases ("ethical localism", "models") that
 *   never appear in headers but are central to a block's argument.
 *   Content matches score 35–55, always below confident header matches.
 *   Frequency of the term in the content boosts the score slightly.
 *
 * Returns up to `limit` results, header matches ranked above content matches.
 */
export function search(query, limit = 10) {
  if (!fuse || !query.trim()) return []

  const q = query.trim()

  // ── Pass 1: fuzzy header search ──────────────────────────────────────────
  const headerResults = fuse.search(q, { limit }).map(r => ({
    ...r.item,
    score:       Math.round((1 - r.score) * 100),
    matchSource: 'header',
  }))

  // ── Pass 2: exact content search ─────────────────────────────────────────
  let contentResults = []

  if (q.length >= 4 && allBlocks.length) {
    const qLower  = q.toLowerCase()
    const seenIds = new Set(headerResults.map(r => r.id))
    const slots   = limit - headerResults.length

    if (slots > 0) {
      contentResults = allBlocks
        .filter(b => !seenIds.has(b.id) && b.content.toLowerCase().includes(qLower))
        .map(b => {
          // Frequency-based score: more occurrences → higher relevance, capped at 55.
          const count = b.content.toLowerCase().split(qLower).length - 1
          return {
            ...b,
            score:       Math.min(55, 35 + count * 4),
            matchSource: 'content',
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, slots)
    }
  }

  return [...headerResults, ...contentResults]
}
