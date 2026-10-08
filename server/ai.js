// Requirement engineering, UML synthesis and code review.
//
// Everything here runs locally and deterministically so the platform works with
// no API key and no network. If OLLAMA_URL is set, refineWithLLM() upgrades the
// generated prose; otherwise the heuristic result is used as-is.

const NFR_KEYWORDS = {
  Performance: ['performance', 'fast', 'speed', 'latency', 'response time', 'throughput', 'concurrent', 'load time'],
  Security: ['security', 'secure', 'encrypt', 'authentication', 'authorization', 'password', 'attack', 'vulnerab', 'gdpr', 'audit'],
  Reliability: ['reliab', 'uptime', 'availab', 'backup', 'recover', 'failover', 'fault'],
  Usability: ['usability', 'user-friendly', 'intuitive', 'accessib', 'responsive design', 'ease of use'],
  Scalability: ['scalab', 'scale', 'growth', 'capacity'],
  Maintainability: ['maintain', 'modular', 'documentation', 'code quality', 'testab'],
  Portability: ['portab', 'cross-platform', 'browser', 'device', 'mobile support'],
};

// Vague terms that make a requirement untestable.
const AMBIGUOUS = [
  'fast', 'quickly', 'slow', 'user-friendly', 'easy', 'easily', 'efficient', 'effective',
  'appropriate', 'adequate', 'sufficient', 'several', 'some', 'many', 'few', 'etc',
  'robust', 'flexible', 'minimal', 'optimal', 'better', 'improved', 'modern',
  'as needed', 'if possible', 'approximately', 'various', 'normal', 'reasonable',
  'state-of-the-art', 'seamless', 'intuitive', 'nice', 'good', 'best', 'simple',
];

const ROLE_HINTS = [
  [['admin', 'administrator', 'superuser'], 'administrator'],
  [['manager', 'project manager', 'lead'], 'project manager'],
  [['tester', 'qa', 'quality assurance'], 'tester'],
  [['developer', 'engineer', 'programmer'], 'developer'],
  [['designer', 'ux', 'ui designer'], 'designer'],
  [['client', 'customer', 'stakeholder'], 'client'],
  [['guest', 'visitor'], 'visitor'],
];

const STOP_START = /^(the|a|an|it|this|that|there|system|we|our|they)\s+/i;

/** Split a free-form document into candidate requirement statements. */
function splitStatements(text) {
  return String(text)
    .split(/\r?\n|(?<=[.;!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/^\s*(?:[-*•‣◦]|\d+[.)])\s*/, '').trim())
    .filter((s) => s.length > 12 && /[a-z]/i.test(s));
}

// Phrasings that signal a quality attribute without using its keyword.
const NFR_PATTERNS = {
  Performance: [/\bwithin\s+\d+\s*(ms|milliseconds?|secs?|seconds?|minutes?)\b/i, /\bper\s+second\b/i, /\bin\s+under\s+\d+/i],
  Reliability: [/\b\d+(\.\d+)?\s*(%|percent)\b/i, /\bno\s+data\s+loss\b/i],
  Usability: [/\beasy\s+to\s+(use|learn|navigate|understand)\b/i, /\bwithout\s+training\b/i],
  Security: [/\bmust\s+(be\s+)?(encrypt|hash|anonymi[sz])/i, /\bonly\s+authoris?zed\b/i],
  Scalability: [/\bup\s+to\s+[\d,]+\s+(concurrent\s+)?(users|requests|records|titles)\b/i],
};

function classify(sentence) {
  const low = sentence.toLowerCase();
  for (const [category, words] of Object.entries(NFR_KEYWORDS)) {
    if (words.some((w) => low.includes(w))) return { kind: 'non-functional', category };
  }
  for (const [category, patterns] of Object.entries(NFR_PATTERNS)) {
    if (patterns.some((re) => re.test(sentence))) return { kind: 'non-functional', category };
  }
  return { kind: 'functional', category: 'Functional' };
}

function detectRole(sentence) {
  const low = sentence.toLowerCase();
  for (const [words, role] of ROLE_HINTS) {
    if (words.some((w) => low.includes(w))) return role;
  }
  // Fall back to the subject of "<subject> shall be able to ..." or "allow <subject>
  // to ...", for domain roles the hint list does not know about (student, librarian).
  const agent = low.match(AGENTIVE) || low.match(ALLOW_AGENT);
  if (agent && !new RegExp(`^(${SYSTEM_WORDS})$`, 'i').test(agent[1])) return agent[1];
  return 'user';
}

function findAmbiguity(sentence) {
  const low = sentence.toLowerCase();
  const issues = AMBIGUOUS
    .filter((w) => new RegExp(`\\b${w}\\b`).test(low))
    .map((w) => `Vague term "${w}" - replace with a measurable value.`);

  if (!/\b(shall|must|should|will|can|able to)\b/i.test(sentence))
    issues.push('No modal verb (shall/must/should) - the obligation is unclear.');
  if (/\b(and|or)\b.*\b(and|or)\b/i.test(sentence) && sentence.length > 120)
    issues.push('Compound statement - consider splitting into separate requirements.');
  if (sentence.length > 220)
    issues.push('Statement is very long - hard to verify as a single requirement.');
  return issues;
}

/** 0-100 score: how testable and well-formed the statement is. */
function scoreQuality(sentence, issues, kind) {
  let score = 100;
  score -= issues.length * 12;
  if (kind === 'non-functional' && !/\d/.test(sentence)) score -= 15; // NFRs need numbers
  if (sentence.length < 30) score -= 10;
  if (!/\b(user|system|admin|client|service|application|platform)\b/i.test(sentence)) score -= 8;
  return Math.max(5, Math.min(100, score));
}

const SYSTEM_WORDS = 'system|application|platform|software|product|website|service';
const HUMAN_WORDS = 'user|users|admin|administrator|administrators|manager|managers|developer|'
  + 'developers|tester|testers|designer|designers|client|clients|customer|customers|'
  + 'stakeholder|stakeholders|guest|visitor|team|member|members';

// "<subject> shall be able to ..." always has an agent, whatever the domain calls it
// (student, librarian, cashier), so it identifies both the actor and a human subject.
const AGENTIVE = /^\s*(?:the |a |an |each |every )?([a-z][\w-]*(?:\s+[a-z][\w-]*)?)\s+(?:shall|should|must|will|can)\s+be\s+able\s+to\s+/i;

// "... allow a librarian to register ..." also names its actor.
const ALLOW_AGENT = /\b(?:allow|allows|enable|enables|permit|permits|let)\s+(?:a |an |the )?([a-z][\w-]*(?:\s+[a-z][\w-]*)?)\s+to\s+/i;

// Each prefix, when it matches, is stripped and tells us who the subject was.
const SUBJECT_PREFIXES = [
  { re: new RegExp(`^\\s*(the |a |an )?(${SYSTEM_WORDS})\\s+(shall|should|must|will|can)\\s+`, 'i'), mode: 'system' },
  { re: new RegExp(`^\\s*(the |a |an )?(project |quality assurance )?(${HUMAN_WORDS})\\s+(shall|should|must|will|can)\\s+`, 'i'), mode: 'human' },
  { re: AGENTIVE, mode: 'human' },
  { re: /^(allow|allows|enable|enables|permit|permits|let)\s+(a|an|the)?\s*[\w\s]{0,25}?\bto\s+/i, mode: 'human' },
  { re: /^be\s+able\s+to\s+/i, mode: null },
];

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const trimEnd = (s) => String(s).replace(/[.;]+$/, '').trim();

/**
 * Reduce a statement to a bare verb phrase and identify its subject.
 * @returns {{action: string, mode: 'human'|'system'|'none'}}
 *   `human`  - a person performs the action ("I want to upload a file")
 *   `system` - the system performs it ("I want the system to stay available")
 *   `none`   - passive or subjectless, so `action` must not follow "I want to"
 */
function peel(sentence) {
  let s = String(sentence).trim();
  let mode = 'none';

  for (let pass = 0; pass < 4; pass++) {
    const before = s;
    for (const { re, mode: subject } of SUBJECT_PREFIXES) {
      const next = s.replace(re, '');
      if (next === s) continue;
      s = next;
      if (subject) mode = subject; // a later human peel overrides an earlier system one
    }
    s = s.replace(STOP_START, '');
    if (s === before) break; // nothing left to peel
  }
  return { action: lowerFirst(trimEnd(s)), mode };
}

const toAction = (sentence) => peel(sentence).action;

/** "a" or "an", chosen for the word that follows. Words like "user" sound consonantal. */
const article = (word) => (/^[aeio]/i.test(word) ? 'an' : 'a');

function titleOf(sentence) {
  const words = toAction(sentence).split(/\s+/).slice(0, 8).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/[,;:]$/, '');
}

/** Phrase the requirement as a user story, adapting to who the subject is. */
function storyFor(sentence, role) {
  const { action, mode } = peel(sentence);
  const who = `As ${article(role)} ${role}`;

  if (mode === 'human') return `${who}, I want to ${action} so that I can achieve my goal efficiently.`;
  if (mode === 'system') return `${who}, I want the system to ${action} so that I can rely on it during my work.`;
  return `${who}, I need the system to guarantee that ${lowerFirst(trimEnd(sentence))}.`;
}

function acceptanceFor(sentence, role, kind) {
  const { action, mode } = peel(sentence);
  const criteria = {
    human: [
      `Given a signed-in ${role}, when they ${action}, then the system completes the operation and confirms it.`,
      `Given invalid or missing input, when the ${role} submits, then a clear validation message is shown and nothing is saved.`,
    ],
    system: [
      `Given the system is deployed and running, when it is exercised under normal conditions, then it must ${action}.`,
      `Given the condition is not met, when a ${role} is affected, then the system reports the failure rather than failing silently.`,
    ],
    none: [
      `Given the system is running normally, when the behaviour is exercised, then this holds: ${lowerFirst(trimEnd(sentence))}.`,
      'Given a failure of this condition, when it is detected, then the system logs the violation and raises an alert.',
    ],
  }[mode];
  if (kind === 'non-functional') {
    const number = sentence.match(/\d+\s*(ms|s|seconds|minutes|%|users|requests)?/i);
    criteria.push(
      number
        ? `The measured value stays within the stated target (${number[0].trim()}) under expected load.`
        : 'A measurable target must be agreed with stakeholders before this can be verified.'
    );
  } else {
    criteria.push(`The action is recorded in the audit log with the identity of the ${role} and a timestamp.`);
  }
  return criteria;
}

function priorityFor(sentence, kind) {
  const low = sentence.toLowerCase();
  if (/\b(must|critical|essential|mandatory|required|shall)\b/.test(low)) return 'high';
  if (/\b(may|optional|nice to have|could|future)\b/.test(low)) return 'low';
  return kind === 'non-functional' ? 'medium' : 'high';
}

/**
 * Turn a free-form project brief into structured requirements.
 * @returns {Array} requirement objects ready to be persisted
 */
export function analyzeRequirements(text, startIndex = 1) {
  const seen = new Set();
  const out = [];
  let fCount = 0;
  let nCount = 0;

  for (const sentence of splitStatements(text)) {
    const fingerprint = sentence.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(fingerprint)) continue; // duplicate restatement
    seen.add(fingerprint);

    const { kind, category } = classify(sentence);
    const role = detectRole(sentence);
    const issues = findAmbiguity(sentence);
    const code = kind === 'functional'
      ? `FR-${String(startIndex + fCount++).padStart(3, '0')}`
      : `NFR-${String(startIndex + nCount++).padStart(3, '0')}`;

    out.push({
      code,
      kind,
      category,
      title: titleOf(sentence),
      description: sentence.replace(/\s+/g, ' ').trim(),
      priority: priorityFor(sentence, kind),
      story: storyFor(sentence, role),
      acceptance: acceptanceFor(sentence, role, kind),
      quality: scoreQuality(sentence, issues, kind),
      issues,
    });
  }
  return out;
}

/** Detect requirements that overlap or contradict each other. */
export function detectConflicts(requirements) {
  const conflicts = [];
  const tokens = (r) => new Set(`${r.title} ${r.description}`.toLowerCase().match(/[a-z]{4,}/g) || []);
  const negated = /\b(not|never|no|without|disable|prevent)\b/i;

  for (let i = 0; i < requirements.length; i++) {
    for (let j = i + 1; j < requirements.length; j++) {
      const a = tokens(requirements[i]);
      const b = tokens(requirements[j]);
      const shared = [...a].filter((t) => b.has(t));
      const overlap = shared.length / Math.max(1, Math.min(a.size, b.size));
      if (overlap <= 0.6) continue;

      const contradicts = negated.test(requirements[i].description) !== negated.test(requirements[j].description);
      conflicts.push({
        a: requirements[i].code,
        b: requirements[j].code,
        type: contradicts ? 'contradiction' : 'overlap',
        detail: contradicts
          ? 'These requirements describe the same feature but one negates the other.'
          : `These requirements overlap by ${Math.round(overlap * 100)}% - consider merging them.`,
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------- UML ------

function entityWords(requirements) {
  const counts = new Map();
  const skip = new Set(['system', 'shall', 'must', 'should', 'will', 'user', 'able', 'with', 'from',
    'that', 'this', 'their', 'them', 'when', 'then', 'they', 'have', 'each', 'also', 'into', 'been',
    'allow', 'allows', 'support', 'provide', 'using', 'within', 'under', 'while', 'where']);
  for (const r of requirements) {
    for (const w of (String(r.description).toLowerCase().match(/\b[a-z]{4,}\b/g) || [])) {
      if (!skip.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const words = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1).replace(/s$/, ''));
  return words.length ? words : ['Entity'];
}

function requirementActors(requirements) {
  const actors = requirements
    .map((r) => (String(r.story || '').match(/^As an? ([^,]+),/i) || [])[1])
    .map((actor) => clean(actor))
    .filter(Boolean);
  return [...new Set(actors)].slice(0, 5);
}

const clean = (s) => String(s ?? '').replace(/["`\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 55);
const mermaidId = (s, fallback = 'Node') => {
  const id = String(s ?? '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z_]+/, '');
  return id || fallback;
};
const mermaidLabel = (s) => clean(s).replace(/[()[\]{}<>]/g, ' ');

/**
 * Generate Mermaid source for a diagram type from the project's requirements.
 * @param {string} type usecase|class|sequence|activity|er|state|component|deployment
 */
export function generateUML(type, project, requirements) {
  const fr = requirements.filter((r) => r.kind === 'functional');
  const top = (fr.length ? fr : [{ code: 'FR-001', title: 'Core feature' }]).slice(0, 8);
  const entities = entityWords(requirements.length ? requirements : [{ description: project.description }]);
  const roles = requirementActors(requirements);
  const actors = roles.length ? roles : ['user'];
  const short = (s) => mermaidId(s, 'Actor');

  switch (type) {
    case 'usecase':
      return [
        'graph LR',
        ...actors.map((a, i) => `  A${i}(["${mermaidLabel(a)}"]):::actor`),
        `  subgraph System["${mermaidLabel(project.name)}"]`,
        ...top.map((r, i) => `    U${i}(("${mermaidLabel(r.title)}"))`),
        '  end',
        ...top.map((_, i) => `  A${i % actors.length} --> U${i}`),
        '  classDef actor fill:#2563eb,stroke:#1e40af,color:#fff',
      ].join('\n');

    case 'class':
      {
        const classNames = [...new Set(entities.map((entity, i) => mermaidId(entity, `Entity${i + 1}`)))];
      return [
        'classDiagram',
        ...classNames.map((e) => [
          `  class ${e} {`,
          '    +int id',
          '    +String name',
          '    +Date createdAt',
          `    +save() ${e}`,
          '    +delete() void',
          '  }',
        ].join('\n')),
        ...classNames.slice(1).map((e) => `  ${classNames[0]} "1" --> "*" ${e}`),
      ].join('\n');
      }

    case 'sequence':
      return [
        'sequenceDiagram',
        `  actor ${short(actors[0])} as ${mermaidLabel(actors[0])}`,
        '  participant UI as Web Client',
        '  participant API as EngineerOS API',
        '  participant AI as Analysis Engine',
        '  participant DB as Database',
        ...top.slice(0, 3).flatMap((r) => [
          `  ${short(actors[0])}->>UI: ${mermaidLabel(r.title)}`,
          '  UI->>API: request with Bearer token',
          '  API->>AI: analyse and validate',
          '  AI-->>API: structured result',
          '  API->>DB: persist',
          '  DB-->>API: ok',
          `  API-->>UI: 200 ${mermaidLabel(r.code)} saved`,
        ]),
      ].join('\n');

    case 'activity':
      {
        const steps = top.slice(0, 5);
      return [
        'flowchart TD',
        '  S([Start]) --> L[Sign in]',
        '  L --> V{Credentials valid?}',
        '  V -- No --> E[Show error] --> L',
        '  V -- Yes --> P[Open project]',
        ...steps.map((r, i) => `  P --> T${i}["${mermaidLabel(r.title)}"] --> R${i}`),
        ...steps.slice(0, -1).map((_, i) => `  R${i} --> T${i + 1}`),
        `  R${Math.max(0, steps.length - 1)} --> V2{Validation passed?}`,
        '  V2 -- No --> F[Return issues] --> P',
        '  V2 -- Yes --> C[Persist and log activity]',
        '  C --> D([End])',
      ].join('\n');
      }

    case 'er':
      return [
        'erDiagram',
        '  USER ||--o{ PROJECT : owns',
        '  USER ||--o{ TASK : "assigned to"',
        '  PROJECT ||--o{ REQUIREMENT : contains',
        '  PROJECT ||--o{ SPRINT : schedules',
        '  PROJECT ||--o{ BUG : tracks',
        '  REQUIREMENT ||--o{ TASK : "traced to"',
        '  SPRINT ||--o{ TASK : includes',
        '  TASK ||--o{ BUG : produces',
        '  USER {',
        '    int id PK',
        '    string name',
        '    string email',
        '    string role',
        '  }',
        '  PROJECT {',
        '    int id PK',
        '    string name',
        '    string description',
        '    int owner_id FK',
        '  }',
        '  REQUIREMENT {',
        '    int id PK',
        '    string code',
        '    string kind',
        '    string priority',
        '    int quality',
        '  }',
        '  SPRINT {',
        '    int id PK',
        '    string name',
        '    string status',
        '  }',
        '  TASK {',
        '    int id PK',
        '    string title',
        '    string status',
        '    int points',
        '  }',
        '  BUG {',
        '    int id PK',
        '    string title',
        '    string severity',
        '    string status',
        '  }',
      ].join('\n');

    case 'state':
      return [
        'stateDiagram-v2',
        '  [*] --> Backlog',
        '  Backlog --> Todo : planned into sprint',
        '  Todo --> InProgress : developer starts',
        '  InProgress --> Review : pull request opened',
        '  Review --> InProgress : changes requested',
        '  Review --> Done : approved and merged',
        '  Done --> InProgress : bug reopened',
        '  Done --> [*]',
      ].join('\n');

    case 'component':
      {
        const qualityAreas = [...new Set(requirements
          .filter((r) => r.kind !== 'functional')
          .map((r) => clean(r.category || 'Quality')))].slice(0, 5);
      return [
        'graph TB',
        `  subgraph Client["${mermaidLabel(project.name)} client"]`,
        '    UI[Web Client]',
        '  end',
        '  subgraph Server',
        '    R[REST API on Express]',
        '    A[Auth and RBAC]',
        '    E[Analysis Engine]',
        '    S[SRS Generator]',
        '    U[UML Generator]',
        '  end',
        ...(qualityAreas.length ? [
          '  subgraph Quality["Quality concerns"]',
          ...qualityAreas.map((area, i) => `    Q${i}["${mermaidLabel(area)}"]`),
          '  end',
        ] : []),
        '  subgraph Data',
        '    DB[(SQLite)]',
        '  end',
        '  UI --> R',
        '  R --> A',
        '  R --> E',
        '  R --> S',
        '  R --> U',
        '  A --> DB',
        '  E --> DB',
        '  S --> DB',
        ...qualityAreas.map((_, i) => `  E -.-> Q${i}`),
      ].join('\n');
      }

    case 'deployment':
      return [
        'graph TB',
        '  subgraph Browser',
        '    B[Web Client]',
        '  end',
        '  subgraph ApplicationServer[Application Server]',
        '    N[Node.js runtime]',
        '    X[Express app]',
        '    N --- X',
        '  end',
        '  subgraph Storage[Storage Volume]',
        '    D[(SQLite file and WAL)]',
        '  end',
        `  B -->|HTTPS JSON| X`,
        '  X -->|file IO| D',
      ].join('\n');

    default:
      throw new Error(`Unknown diagram type: ${type}`);
  }
}

// -------------------------------------------------------- Code review ------

const REVIEW_RULES = [
  // --- Critical Security Vulnerabilities ---
  {
    re: /\beval\s*\(/,
    sev: 'critical',
    msg: 'Arbitrary code execution risk with eval().',
    fix: 'Use explicit parsing (e.g. JSON.parse) or structured data mapping instead of eval().',
  },
  {
    re: /\bnew\s+Function\s*\(/,
    sev: 'critical',
    msg: 'Dynamic Function constructor allows arbitrary code execution similar to eval().',
    fix: 'Refactor to standard function declarations or a safe expression evaluator.',
  },
  {
    re: /(password|passwd|secret|api[_-]?key|jwt[_-]?secret|private[_-]?key|token|auth)\w*\s*[:=]\s*["'][^"']{6,}["']/i,
    sev: 'critical',
    msg: 'Hard-coded secret or credential detected in source.',
    fix: 'Extract secrets to environment variables (e.g. process.env.API_KEY).',
  },
  {
    re: /\b(AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|sk-(?:live|test|proj)?[a-zA-Z0-9_-]{12,})\b/,
    sev: 'critical',
    msg: 'Potential hardcoded cloud, GitHub, or API provider access token.',
    fix: 'Revoke this credential immediately and supply it via an environment variable.',
  },
  {
    re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*["']\s*\+/i,
    sev: 'critical',
    msg: 'SQL query constructed via string concatenation (SQL Injection risk).',
    fix: 'Use parameterized queries with placeholders ($1, ?, or named parameters).',
  },
  {
    re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$\{/i,
    sev: 'critical',
    msg: 'SQL query constructed via template literal interpolation (SQL Injection risk).',
    fix: 'Use parameterized prepared statements instead of string interpolation.',
  },
  {
    re: /\b(child_process|cp)\.(exec|execSync)\s*\([^)]*(\+|`|\$\{)/i,
    sev: 'critical',
    msg: 'Command injection vulnerability in shell execution.',
    fix: 'Use execFile or spawn with an argument array instead of a raw concatenated shell string.',
  },
  {
    re: /__proto__|constructor\s*\[\s*['"]prototype['"]\s*\]/,
    sev: 'critical',
    msg: 'Potential Prototype Pollution vulnerability via unchecked property traversal.',
    fix: 'Use Object.create(null), validate property names against Object.keys, or use a Map.',
  },
  {
    re: /fs\.(readFile|readFileSync|createReadStream|writeFile|writeFileSync)\s*\([^)]*(\+\s*req\.|\$\{\s*req\.|\.\.\/)/i,
    sev: 'critical',
    msg: 'Path traversal vulnerability in filesystem operation.',
    fix: 'Sanitize path using path.basename() or resolve and assert it stays inside a safe root directory.',
  },
  {
    re: /\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/,
    sev: 'high',
    msg: 'Direct HTML injection sink (Cross-Site Scripting / XSS).',
    fix: 'Use textContent, createElement, or sanitize with DOMPurify before assigning HTML.',
  },
  {
    re: /javascript:\s*[^"']+/i,
    sev: 'high',
    msg: 'Inline javascript: URI scheme detected (potential XSS vector).',
    fix: 'Avoid javascript: pseudoprotocol URLs; use an event listener with preventDefault().',
  },

  // --- High Severity Quality & Logic ---
  {
    re: /catch\s*\([^)]*\)\s*\{\s*\}/,
    sev: 'high',
    msg: 'Empty catch block silently swallows exceptions.',
    fix: 'Log the error with context or re-throw: console.error(err); or throw err;',
  },
  {
    re: /crypto\.createHash\s*\(\s*['"](md5|sha1)['"]\s*\)/i,
    sev: 'high',
    msg: 'Cryptographically broken or weak hash algorithm (MD5/SHA-1).',
    fix: 'Use SHA-256 or bcrypt/argon2 for password hashing.',
  },
  {
    re: /Math\.random\s*\(\s*\)\s*(\.toString|\*|\+)/,
    sev: 'high',
    msg: 'Math.random() is cryptographically insecure for tokens or identifiers.',
    fix: 'Use crypto.randomUUID() or crypto.randomBytes(16) for unpredictable tokens.',
  },
  {
    re: /(password|token|hash|secret)\s*===?\s*(req\.|\w+)/i,
    sev: 'high',
    msg: 'Potential timing attack when comparing authentication tokens with standard equality.',
    fix: 'Use crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) for secret comparisons.',
  },

  // --- Medium Severity ---
  {
    re: /[^=!<>]==[^=]/,
    sev: 'medium',
    msg: 'Loose equality (==) performs implicit type coercion.',
    fix: 'Use strict equality (===) for predictable comparisons.',
  },
  {
    re: /[^=!<>!]!=[^=]/,
    sev: 'medium',
    msg: 'Loose inequality (!=) performs implicit type coercion.',
    fix: 'Use strict inequality (!==) for predictable comparisons.',
  },
  {
    re: /fs\.(readFileSync|writeFileSync|existsSync|statSync)\s*\(/,
    sev: 'medium',
    msg: 'Synchronous I/O in potentially asynchronous server context blocks event loop.',
    fix: 'Use asynchronous fs.promises methods (e.g. await fs.promises.readFile(...)).',
  },
  {
    re: /new\s+RegExp\s*\(\s*(req\.|input|query|params)/i,
    sev: 'medium',
    msg: 'Unescaped user input passed to RegExp constructor (ReDoS vulnerability).',
    fix: 'Escape special regex characters or validate input against a strict whitelist.',
  },
  {
    re: /(127\.0\.0\.1|localhost):\d{2,5}/,
    sev: 'medium',
    msg: 'Hardcoded local hostname or port in source.',
    fix: 'Use environment variables (e.g. process.env.SERVICE_URL || "http://localhost:3000").',
  },

  // --- Low Severity ---
  {
    re: /\bvar\s+\w/,
    sev: 'low',
    msg: 'Legacy var declaration with function scoping and hoisting.',
    fix: 'Replace var with const for immutable bindings or let for reassigned variables.',
  },
  {
    re: /console\.(log|debug|trace)\s*\(/,
    sev: 'low',
    msg: 'Debug logging statement left in source.',
    fix: 'Remove debug logging or replace with a structured logger (e.g., logger.info()).',
  },
  {
    re: /\bdebugger\s*;?/,
    sev: 'low',
    msg: 'Leftover debugger breakpoint statement.',
    fix: 'Remove debugger statement before deploying to production.',
  },
  {
    re: /\balert\s*\(/,
    sev: 'low',
    msg: 'Synchronous blocking alert() call degrades user experience.',
    fix: 'Use non-blocking UI notifications or modals instead of native alert().',
  },
];

/** Static heuristic review of a code snippet. */
export function reviewCode(code, filename = 'snippet.js') {
  const source = String(code);
  const lines = source.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, i) => {
    const isComment = /^\s*(\/\/|\*|#)/.test(line);
    if (isComment) {
      if (/\b(TODO|FIXME|HACK|BUG|XXX)\b/i.test(line)) {
        findings.push({ line: i + 1, severity: 'low', message: 'Unresolved TODO/FIXME marker.', suggestion: 'Track this as a task instead of a comment.', code: line.trim().slice(0, 120) });
      }
      return;
    }
    for (const rule of REVIEW_RULES) {
      if (rule.re.test(line)) {
        findings.push({ line: i + 1, severity: rule.sev, message: rule.msg, suggestion: rule.fix, code: line.trim().slice(0, 120) });
      }
    }
  });

  // Structural metrics.
  let depth = 0;
  let maxDepth = 0;
  for (const ch of source) {
    if (ch === '{') maxDepth = Math.max(maxDepth, ++depth);
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  const functions = (source.match(/\bfunction\b|=>/g) || []).length;
  const complexity = (source.match(/\b(if|for|while|case|catch)\b|&&|\|\|/g) || []).length + 1;

  if (maxDepth > 4) findings.push({ line: 0, severity: 'medium', message: `Nesting depth of ${maxDepth} makes the code hard to follow.`, suggestion: 'Extract inner blocks into named functions or use early returns.', code: '' });
  if (lines.length > 120) findings.push({ line: 0, severity: 'medium', message: `File is ${lines.length} lines long.`, suggestion: 'Split it into focused modules.', code: '' });
  if (complexity > 15) findings.push({ line: 0, severity: 'high', message: `Cyclomatic complexity is approximately ${complexity}.`, suggestion: 'Reduce branching; consider a lookup table or polymorphism.', code: '' });

  const weight = { critical: 25, high: 12, medium: 6, low: 2 };
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const score = Math.max(0, 100 - findings.reduce((sum, f) => sum + (weight[f.severity] || 0), 0));

  return {
    filename,
    metrics: { lines: lines.length, functions, complexity, maxDepth },
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line),
  };
}

/**
 * Optional LLM-driven code review enrichment pass.
 * Returns null when unavailable so callers fall back seamlessly to heuristic output.
 */
export async function generateAICodeReview(code, filename, heuristicResult) {
  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const prompt = `You are a senior principal security engineer and architect. Review this code file (${filename}):
\`\`\`
${code.slice(0, 4000)}
\`\`\`
Static scan found ${heuristicResult.findings.length} findings, with overall Grade: ${heuristicResult.grade} (Score: ${heuristicResult.score}/100).
Summarize in 3 concise, highly actionable bullet points:
- Key security risk or vulnerability
- Architecture / code smell assessment
- Recommended priority fix or refactor`;

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 350,
        temperature: 0.2,
      });

      return response.choices[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.warn('[AI Code Review OpenAI error]', e.message);
    }
  }

  if (process.env.OLLAMA_URL) {
    try {
      const res = await refineWithLLM(`Provide a brief code review for ${filename}:\n${code.slice(0, 2000)}`);
      if (res) return res;
    } catch (_) {}
  }

  return null;
}

/**
 * Optional refinement pass through a local Ollama server.
 * Returns null when unavailable so callers fall back to the heuristic output.
 */
export async function refineWithLLM(prompt) {
  const url = process.env.OLLAMA_URL;
  if (!url) return null;
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'llama3', prompt, stream: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return (await res.json()).response?.trim() || null;
  } catch {
    return null; // model unavailable - heuristics still cover the feature
  }
}
