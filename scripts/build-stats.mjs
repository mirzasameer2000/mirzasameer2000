#!/usr/bin/env node
/**
 * Generates assets/stats.svg from the GitHub GraphQL API.
 *
 * Self-hosted on purpose: the popular third-party stat services
 * (github-readme-stats, activity-graph) regularly return 503/402 once their
 * free quota is exhausted, which silently breaks the README for everyone.
 * Rendering our own SVG in CI removes that dependency entirely.
 *
 * Requires: GITHUB_TOKEN (Actions provides it), USERNAME.
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const USER = process.env.USERNAME || 'mirzasameer2000'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required')
  process.exit(1)
}

const QUERY = `
{
  user(login: "${USER}") {
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions }
    }
    followers { totalCount }
  }
}`

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
})
if (!res.ok) {
  console.error('GitHub API error', res.status, await res.text())
  process.exit(1)
}
const { data, errors } = await res.json()
if (errors) {
  console.error('GraphQL errors', JSON.stringify(errors))
  process.exit(1)
}

const u = data.user
const c = u.contributionsCollection
const repos = u.repositories.totalCount
const stars = u.repositories.nodes.reduce((a, r) => a + r.stargazerCount, 0)
// Private contributions dwarf public ones for client work, so surface the
// calendar total rather than only public commits.
const contributions = c.contributionCalendar.totalContributions
const commits = c.totalCommitContributions + c.restrictedContributionsCount
const prs = c.totalPullRequestContributions
const followers = u.followers.totalCount

const byLang = new Map()
for (const repo of u.repositories.nodes) {
  for (const { size, node } of repo.languages.edges) {
    const cur = byLang.get(node.name) || { size: 0, color: node.color || '#8b949e' }
    cur.size += size
    byLang.set(node.name, cur)
  }
}
const langs = [...byLang.entries()]
  .map(([name, v]) => ({ name, ...v }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 6)
const langTotal = langs.reduce((a, l) => a + l.size, 0) || 1
const byLangCount = byLang.size

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n))

const W = 1000
const H = 260
const ACCENT = '#f1c40f'

// Only surface metrics that are actually meaningful. A hard-zero PR or star
// count reads worse than omitting it, and most of this work lives in private
// client repos where those counters never move.
const candidates = [
  { label: 'Contributions (yr)', value: contributions },
  { label: 'Total commits', value: commits },
  { label: 'Repositories', value: repos },
  { label: 'Languages', value: byLangCount },
  { label: 'Pull requests', value: prs },
  { label: 'Followers', value: followers },
]
const cards = candidates
  .filter((c) => c.value > 0)
  .slice(0, 4)
  .map((c) => ({ label: c.label, value: fmt(c.value) }))

// Same rule for the header line — omit counters sitting at zero.
const subtitle = [
  followers > 0 ? `${followers} followers` : null,
  stars > 0 ? `${stars} stars` : null,
  'updated daily',
]
  .filter(Boolean)
  .join(' · ')

const cardW = 214
const cardGap = 18
const cardX = (i) => 32 + i * (cardW + cardGap)

const cardSvg = cards
  .map(
    (c, i) => `
    <g transform="translate(${cardX(i)},64)">
      <rect width="${cardW}" height="86" rx="12" fill="#ffffff" fill-opacity="0.03" stroke="${ACCENT}" stroke-opacity="0.22"/>
      <text x="18" y="42" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="30" font-weight="800" fill="#ffffff">${esc(c.value)}
        <animate attributeName="opacity" values="0;1" dur="0.6s" begin="${0.15 * i}s" fill="freeze"/>
      </text>
      <text x="18" y="66" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="12.5" fill="#8b949e">${esc(c.label)}</text>
      <rect x="18" y="74" width="0" height="2" rx="1" fill="${ACCENT}" opacity="0.7">
        <animate attributeName="width" values="0;${cardW - 36}" dur="0.9s" begin="${0.15 * i}s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1"/>
      </rect>
    </g>`,
  )
  .join('')

// Stacked language bar — one row, proportional, animated draw-in.
let cursor = 32
const barW = W - 64
const segs = langs
  .map((l, i) => {
    const w = Math.max(2, (l.size / langTotal) * barW)
    const x = cursor
    cursor += w
    return `<rect x="${x.toFixed(1)}" y="186" width="0" height="12" fill="${l.color}" rx="2">
      <animate attributeName="width" values="0;${w.toFixed(1)}" dur="0.9s" begin="${0.4 + i * 0.09}s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1"/>
    </rect>`
  })
  .join('')

let lx = 32
const legend = langs
  .map((l, i) => {
    const pct = ((l.size / langTotal) * 100).toFixed(1)
    const label = `${l.name} ${pct}%`
    const w = label.length * 7.1 + 26
    const g = `<g transform="translate(${lx},214)" opacity="0">
      <circle cx="6" cy="8" r="5" fill="${l.color}"/>
      <text x="18" y="12" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="12.5" fill="#c9d1d9">${esc(label)}</text>
      <animate attributeName="opacity" values="0;1" dur="0.5s" begin="${0.7 + i * 0.08}s" fill="freeze"/>
    </g>`
    lx += w
    return g
  })
  .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GitHub statistics for ${esc(USER)}">
  <title>GitHub statistics — ${esc(USER)}</title>
  <defs>
    <linearGradient id="sbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#05070d"/>
      <stop offset="55%" stop-color="#0a0f1c"/>
      <stop offset="100%" stop-color="#05070d"/>
    </linearGradient>
    <linearGradient id="ssweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${ACCENT}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="-1 0; 1 0; -1 0" dur="8s" repeatCount="indefinite"/>
    </linearGradient>
    <pattern id="sgrid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
    <clipPath id="sframe"><rect width="${W}" height="${H}" rx="16"/></clipPath>
  </defs>

  <g clip-path="url(#sframe)">
    <rect width="${W}" height="${H}" fill="url(#sbg)"/>
    <rect width="${W}" height="${H}" fill="url(#sgrid)"/>

    <text x="32" y="40" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="${ACCENT}" letter-spacing="1.6">GITHUB ACTIVITY</text>
    <text x="${W - 32}" y="40" text-anchor="end" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="12" fill="#8b949e">${esc(subtitle)}</text>

    ${cardSvg}

    <text x="32" y="176" font-family="'Segoe UI', Inter, Helvetica, Arial, sans-serif" font-size="12.5" font-weight="700" fill="#8b949e" letter-spacing="1.2">LANGUAGES</text>
    <rect x="32" y="186" width="${barW}" height="12" rx="2" fill="#ffffff" fill-opacity="0.05"/>
    ${segs}
    ${legend}

    <rect x="0" y="0" width="${W}" height="2" fill="url(#ssweep)"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="#ffffff" stroke-opacity="0.09"/>
</svg>
`

mkdirSync('assets', { recursive: true })
writeFileSync('assets/stats.svg', svg)
console.log(`stats.svg written — ${contributions} contributions, ${repos} repos, ${langs.length} languages`)
