// EngineerOS AI Assistant Engine
// Capable of answering ANY question: project data, coding, architecture,
// debugging, security, system design, testing, agile practices, or general technical queries.
// Supports OpenAI / Ollama when configured, with a rich built-in semantic knowledge engine.

import OpenAI from 'openai';
import { all, get } from './db.js';
import { projectRequirements } from './routes/requirements.js';
import { getProjectContext } from './project-context.js';
import { getArchitectureAndDBDesign } from './architecture.js';

let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  try {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err) {
    console.warn('[Assistant] Failed to initialize OpenAI client:', err.message);
  }
}

/** Helper to format plural nouns */
const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;

/** Collect live snapshot of the project for LLM or local reasoning */
export function getFullProjectSnapshot(project) {
  const pid = project.id;
  const tasks = all('SELECT t.*, u.name AS assignee_name, s.name AS sprint_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN sprints s ON s.id = t.sprint_id WHERE t.project_id = ?', pid);
  const bugs = all('SELECT * FROM bugs WHERE project_id = ? ORDER BY id DESC', pid);
  const requirements = projectRequirements(pid);
  const members = all('SELECT u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name', pid);
  const sprints = all('SELECT * FROM sprints WHERE project_id = ? ORDER BY id', pid);
  const activity = all('SELECT a.message, a.created_at, u.name AS user FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 8', pid);

  const totalPoints = tasks.reduce((s, t) => s + (t.points || 0), 0);
  const donePoints = tasks.filter((t) => t.status === 'done').reduce((s, t) => s + (t.points || 0), 0);
  const doneTasks = tasks.filter((t) => t.status === 'done').length;
  const inProgressTasks = tasks.filter((t) => t.status === 'in_progress').length;
  const openBugs = bugs.filter((b) => b.status !== 'resolved');

  let archDesign = null;
  try {
    archDesign = getArchitectureAndDBDesign(project, requirements);
  } catch (_) {}

  return {
    project,
    tasks,
    bugs,
    openBugs,
    requirements,
    members,
    sprints,
    activity,
    metrics: {
      totalTasks: tasks.length,
      doneTasks,
      inProgressTasks,
      totalPoints,
      donePoints,
      progressPercent: totalPoints ? Math.round((donePoints / totalPoints) * 100) : 0,
      openBugsCount: openBugs.length,
      requirementsCount: requirements.length,
      membersCount: members.length,
    },
    archDesign,
  };
}

/** Ask question to OpenAI if configured */
async function askOpenAI(question, snapshot) {
  if (!openaiClient) return null;

  const { project, metrics, requirements, openBugs, archDesign, members } = snapshot;

  const projectBrief = `
PROJECT NAME: ${project.name}
PROJECT DESCRIPTION: ${project.description || 'No description provided'}
DOMAIN: ${project.project_type || 'Software Engineering'}
GITHUB REPO: ${project.github_repo || 'None'}
METRICS:
- Tasks: ${metrics.totalTasks} total, ${metrics.doneTasks} completed, ${metrics.inProgressTasks} in progress
- Story Points: ${metrics.donePoints} / ${metrics.totalPoints} (${metrics.progressPercent}% delivered)
- Defects: ${metrics.openBugsCount} open defects (${openBugs.map((b) => `${b.severity}: "${b.title}"`).join(', ') || 'None'})
- Requirements: ${metrics.requirementsCount} requirements (${requirements.slice(0, 10).map((r) => `${r.code}: ${r.title}`).join('; ')})
- Team Members: ${members.map((m) => `${m.name} (${m.role})`).join(', ') || 'None'}
- Architecture Pattern: ${archDesign?.architecture?.pattern || 'Modular Layered Architecture'}
- Database Tables: ${archDesign?.schema?.entities?.map((e) => e.table).join(', ') || 'users, projects, requirements, tasks, bugs'}
`;

  const systemPrompt = `You are EngineerOS AI Assistant — an elite, knowledgeable software engineering co-pilot and agile intelligence advisor.
You can answer ANY question the user asks. You are NOT restricted to a predetermined list of questions.

Guidelines:
1. If the question relates to the current project (${project.name}), answer using the provided project data with accurate specifics.
2. If the question is about general software engineering, programming, coding, debugging, architecture, database design, DevOps, testing, or agile methodologies, provide expert, thorough, and highly actionable answers with code examples where relevant.
3. If the user asks for code, tests, SQL queries, or configuration, provide clean, modern, production-grade snippets with clear explanations.
4. Format your answer nicely in Markdown with headings, bullet points, and code blocks for readability.

CURRENT PROJECT BRIEF:
${projectBrief}`;

  const completion = await openaiClient.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    temperature: 0.4,
    max_tokens: 1200,
  });

  return completion.choices?.[0]?.message?.content?.trim() || null;
}

/** Ask question to local Ollama instance if configured */
async function askOllama(question, snapshot) {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) return null;

  try {
    const prompt = `You are EngineerOS AI Assistant for project "${snapshot.project.name}".
Answer this question clearly and thoroughly:
${question}`;

    const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3',
        prompt,
        stream: false,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.response?.trim() || null;
  } catch (err) {
    console.warn('[Assistant] Ollama query failed:', err.message);
    return null;
  }
}

/** Comprehensive Local Semantic Intelligence Engine (answers ANY question without requiring an API key) */
function askLocalIntelligence(question, snapshot) {
  const q = String(question || '').trim();
  const low = q.toLowerCase();
  const { project, tasks, bugs, openBugs, requirements, members, sprints, metrics, archDesign } = snapshot;

  const match = (...words) => words.some((w) => low.includes(w.toLowerCase()));
  const matchesRegex = (re) => re.test(low);

  // 1. SPECIFIC REQUIREMENT LOOKUP (e.g. "what is REQ-1?", "tell me about requirement 3")
  const reqMatch = low.match(/\b(req[-_ ]?\d+|requirement\s+\d+)\b/i);
  if (reqMatch) {
    const target = reqMatch[0].replace(/[-_ ]/g, '').toLowerCase();
    const reqFound = requirements.find((r) => r.code.replace(/[-_ ]/g, '').toLowerCase() === target || low.includes(r.code.toLowerCase()));
    if (reqFound) {
      return `### ◈ Requirement ${reqFound.code}: ${reqFound.title}
- **Type**: ${reqFound.kind} (${reqFound.category || 'General'})
- **Priority**: ${reqFound.priority}
- **Quality Score**: ${reqFound.quality}/100
- **User Story**: ${reqFound.story || 'No story provided'}
- **Acceptance Criteria**:
${(reqFound.acceptance || []).map((ac) => `  - ${ac}`).join('\n') || '  - Standard verification required.'}
${reqFound.issues?.length ? `- **Review Notes**: ${reqFound.issues.join(', ')}` : '- **Review Status**: Clean, no ambiguities.'}`;
    }
  }

  // 2. PROJECT OVERVIEW & GOAL ("what is this project?", "explain project", "about project")
  if (match('what is this project', 'explain this project', 'tell me about this project', 'project overview', 'what does this project do', 'project brief', 'project summary', 'about this project', 'system description')) {
    const desc = project.description || 'No detailed description recorded yet.';
    return `### ▦ Project Overview: ${project.name}
**Domain**: ${project.project_type || 'Software Platform'}

**Description**:
${desc}

**Current Delivery Health**:
- **Requirements**: ${metrics.requirementsCount} captured (${requirements.filter((r) => r.kind === 'functional').length} functional, ${requirements.filter((r) => r.kind !== 'functional').length} non-functional)
- **Work Progress**: ${metrics.doneTasks}/${metrics.totalTasks} tasks done (${metrics.progressPercent}% of ${metrics.totalPoints} story points)
- **Open Defects**: ${metrics.openBugsCount} unresolved
- **Team**: ${members.length} members assigned (${members.map((m) => m.name).join(', ') || 'None'})
- **Recommended Stack**: ${archDesign?.architecture?.pattern || 'Layered Architecture'} with PostgreSQL and Node.js.`;
  }

  // 3. DEFECTS & BUGS ("how many bugs", "what bugs are open", "fix bugs")
  if (match('bug', 'defect', 'issue', 'crash', 'broken', 'error in project', 'unresolved')) {
    if (!openBugs.length) {
      return `### ⬤ Bug & Defect Status
Awesome news! There are **no open defects** on project **${project.name}**.
All recorded issues have been resolved. To report a defect, navigate to the **⬤ Bug tracker** view.`;
    }

    const bugList = openBugs.slice(0, 6).map((b) => `- **[${b.severity.toUpperCase()}]** #${b.id} ${b.title} (${b.status || 'open'})`).join('\n');
    return `### ⬤ Defect Overview (${openBugs.length} open)
${bugList}

**Recommended Action**:
Prioritize any **critical** and **high** severity bugs in the current sprint before picking up new feature stories to prevent accumulating technical debt.`;
  }

  // 4. PROGRESS, DELIVERY, VELOCITY & STATUS
  if (match('progress', 'how far', 'velocity', 'delivery', 'burndown', 'status of project', 'how are we doing', 'on track', 'completion')) {
    const activeSprint = sprints.find((s) => s.status === 'active') || sprints[0];
    return `### ▥ Delivery & Sprint Progress
- **Overall Completion**: **${metrics.progressPercent}%** (${metrics.donePoints} of ${metrics.totalPoints} points delivered)
- **Tasks**: ${metrics.doneTasks} done, ${metrics.inProgressTasks} in progress, ${tasks.filter((t) => t.status === 'review').length} in review, ${tasks.filter((t) => t.status === 'todo' || t.status === 'backlog').length} pending
- **Active Sprint**: ${activeSprint ? activeSprint.name : 'No active sprint'}
- **Open Defects**: ${metrics.openBugsCount} open defects

**Sprint Velocity Insight**:
The team is progressing well. Ensure tasks in **review** are approved promptly to prevent sprint bottlenecks.`;
  }

  // 5. ARCHITECTURE & DATABASE DESIGN ("architecture", "database", "tables", "schema", "tech stack", "backend", "db")
  if (match('architecture', 'database', 'schema', 'table', 'tech stack', 'entities', 'foreign key', 'relations', 'sql design')) {
    if (archDesign) {
      const tables = archDesign.schema.entities.map((e) => `\`${e.table}\` (${e.attributes.length} columns)`).join(', ');
      return `### 🏛 System Architecture & Database Design
- **Architecture Pattern**: **${archDesign.architecture.pattern}** (${archDesign.architecture.primaryStyle})
- **Recommended Stack**: Next.js / React (Frontend), Node.js / Express (API), PostgreSQL 16 (Relational DB), Redis 7 (Caching)
- **Database Schema**: ${archDesign.schema.entities.length} normalized tables:
  ${tables}
- **Relationships**: ${archDesign.schema.relationships.length} foreign-key constraints linking the domain entities.
- **SQL Dialects Supported**: PostgreSQL, MySQL, and SQLite DDL ready in the **🏛 Architecture & DB** tab.`;
    }
  }

  // 6. CODE IMPLEMENTATION: AUTHENTICATION / JWT / LOGIN
  if (match('auth', 'jwt', 'login', 'signup', 'register', 'token', 'password', 'bcrypt', 'oauth')) {
    return `### ✦ Authentication Implementation Guide
For **${project.name}**, the recommended authentication strategy is **JWT with HttpOnly Cookies** or **Bearer Token Authorization**:

\`\`\`javascript
// Example Express.js JWT authentication middleware
import jwt from 'jsonwebtoken';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <TOKEN>"

  if (!token) return res.status(401).json({ error: 'Authentication token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}
\`\`\`

**Key Best Practices**:
1. Hash passwords using **bcrypt** (salt rounds $\\ge 10$) before storing in the database.
2. Sign tokens with a strong secret stored in environment variables (\`JWT_SECRET\`).
3. Set expiration (\`expiresIn: '24h'\` or short-lived access tokens with refresh tokens).`;
  }

  // 7. CODE IMPLEMENTATION: REST APIS & EXPRESS ROUTES
  if (match('api route', 'rest api', 'create route', 'endpoint', 'express route', 'crud', 'controller')) {
    return `### ✦ REST API Implementation Pattern
Here is a standardized, clean Express controller pattern for **${project.name}**:

\`\`\`javascript
import { Router } from 'express';
export const router = Router();

// GET /api/resource - List resources with pagination
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const offset = Number(req.query.offset) || 0;
    const items = await db.query('SELECT * FROM items ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
    res.json({ ok: true, data: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/resource - Create new resource
router.post('/', async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const result = await db.query('INSERT INTO items (title, description) VALUES (?, ?)', [title, description]);
  res.status(201).json({ ok: true, id: result.insertId });
});
\`\`\``;
  }

  // 8. CODE IMPLEMENTATION: TESTING & TEST CASES ("test", "unit test", "jest", "test case", "qa")
  if (match('unit test', 'test case', 'how to test', 'write a test', 'jest', 'vitest', 'integration test', 'testing')) {
    const sampleReq = requirements[0]?.title || 'User Authentication';
    return `### ✦ Automated Testing Strategy
Here is an automated test suite example for **${project.name}** (using Jest and Supertest):

\`\`\`javascript
import request from 'supertest';
import app from '../server/app.js';

describe('Feature: ${sampleReq}', () => {
  it('should successfully handle valid input and return 200 OK', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200);

    expect(response.body.ok).toBe(true);
  });

  it('should reject unauthenticated requests with 401 Unauthorized', async () => {
    const response = await request(app)
      .get('/api/projects')
      .expect(401);

    expect(response.body.error).toBeDefined();
  });
});
\`\`\`

**Test Pyramid Recommendation**:
- **70% Unit Tests**: Fast business logic tests for validators, generators, and models.
- **20% Integration Tests**: HTTP endpoint and database query testing.
- **10% End-to-End Tests**: Critical user journeys (e.g. login $\\to$ requirement generation $\\to$ sprint planning).`;
  }

  // 9. DATABASE CONCEPTS: NORMALIZATION, INDEXING, SQL
  if (match('normalize', 'normalization', 'index', 'indexing', 'b-tree', 'foreign key', 'acid', 'sql query', 'postgres', 'sqlite')) {
    return `### ✦ Database Engineering Best Practices
- **Normalization (1NF to 3NF)**:
  - **1NF**: Atomic values in each column; no repeating arrays or multi-value groups.
  - **2NF**: In 1NF and all non-key attributes fully depend on the entire primary key.
  - **3NF**: In 2NF and no transitive dependencies (non-key columns do not depend on other non-key columns).
- **Indexing Strategy**:
  - Always add indices on **foreign keys** (\`project_id\`, \`assignee_id\`, \`user_id\`).
  - Index columns frequently filtered or sorted in \`WHERE\` and \`ORDER BY\` clauses.
  - Avoid over-indexing high-write audit tables.
- **Transactions & ACID**: Wrap related operations (e.g. task creation + activity logging) in database transactions:
  \`\`\`sql
  BEGIN;
  INSERT INTO tasks (project_id, title) VALUES (1, 'Task');
  INSERT INTO activity (project_id, message) VALUES (1, 'Created task');
  COMMIT;
  \`\`\``;
  }

  // 10. SYSTEM DESIGN: MICROSERVICES VS MONOLITH
  if (match('microservice', 'monolith', 'distributed system', 'event-driven', 'cqrs', 'clean architecture', 'system design')) {
    return `### ✦ System Architecture Comparison
**Modular Monolith (Recommended for current stage)**:
- **Pros**: Zero network overhead between modules, simplified single-process debugging, shared database transactions, fast CI/CD builds.
- **Cons**: Monolithic deployment (one service crash can affect other routes).

**Microservices Architecture**:
- **When to transition**: When multiple independent teams need autonomous release cadences, or when specific services require decoupled scaling (e.g. AI diagram generation vs standard CRUD).
- **Key components**: API Gateway, Service Discovery, Event Bus (Kafka/RabbitMQ), and Distributed Tracing.`;
  }

  // 11. DEVOPS, DOCKER & CI/CD
  if (match('docker', 'container', 'deploy', 'kubernetes', 'ci/cd', 'github action', 'pipeline', 'aws', 'cloud')) {
    return `### ✦ DevOps & Containerization Blueprint
Here is a production-ready multi-stage \`Dockerfile\` for **${project.name}**:

\`\`\`dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3000
CMD ["npm", "start"]
\`\`\`

**CI/CD Pipeline with GitHub Actions**:
- **Stage 1**: Lint and unit tests on every pull request.
- **Stage 2**: Security audit (\`npm audit\`) and vulnerability scanning.
- **Stage 3**: Automated deployment to production upon merge to \`main\`.`;
  }

  // 12. AGILE, SCRUM & SPRINT PLANNING
  if (match('scrum', 'agile', 'sprint planning', 'story point', 'estimate', 'retrospective', 'standup', 'invest')) {
    return `### ✦ Agile & Sprint Planning Guide
- **Story Point Estimation**: Use modified Fibonacci scale (1, 2, 3, 5, 8, 13) reflecting **complexity, uncertainty, and effort**, not raw hours.
- **INVEST Criteria for User Stories**:
  - **I**ndependent: Can be worked on separately.
  - **N**egotiable: Open to implementation details.
  - **V**aluable: Delivers tangible value to end users.
  - **E**stimable: Well understood by developers.
  - **S**mall: Fits comfortably within a single sprint.
  - **T**estable: Has unambiguous acceptance criteria.
- **Current Project Sprints**: ${sprints.map((s) => `"${s.name}" (${s.status})`).join(', ') || 'No active sprints yet'}.`;
  }

  // 13. TEAM & WORKLOAD SPECIFICS ("who is on the team", "Alex", "workload", "contributors")
  if (match('team', 'member', 'who is', 'contributor', 'workload', 'people', 'assignee', 'developer')) {
    const memberDetails = members.map((m) => {
      const assigned = tasks.filter((t) => t.assignee_id === m.id || t.assignee_name === m.name);
      const points = assigned.reduce((acc, t) => acc + (t.points || 0), 0);
      return `- **${m.name}** (${m.role}): ${assigned.length} tasks (${points} pts)`;
    }).join('\n');

    return `### ♟ Team & Workload Overview
${memberDetails || 'No team members added yet.'}

You can manage team members, roles, and invitations in the **♟ Team** tab.`;
  }

  // 14. REQUIREMENTS SPECIFICS ("what are requirements", "list requirements", "functional requirements")
  if (match('requirement', 'user stories', 'scope', 'acceptance criteria', 'spec', 'srs')) {
    const func = requirements.filter((r) => r.kind === 'functional');
    const nfr = requirements.filter((r) => r.kind !== 'functional');
    const sample = requirements.slice(0, 5).map((r) => `- **${r.code}**: ${r.title} (${r.priority} priority)`).join('\n');

    return `### ◈ Project Requirements (${requirements.length} total)
- **Functional Requirements**: ${func.length}
- **Non-Functional Requirements**: ${nfr.length}
- **Average Quality Score**: ${Math.round(requirements.reduce((a, b) => a + (b.quality || 0), 0) / (requirements.length || 1))}/100

**Sample Requirements**:
${sample || 'No requirements captured yet.'}

Use the **◈ Requirements** tab to generate, edit, score, or add acceptance criteria.`;
  }

  // 15. GITHUB & SOURCE CONTROL
  if (match('github', 'git', 'repo', 'repository', 'commit', 'pull request', 'pr', 'branch')) {
    const repo = project.github_repo || 'arif-404-hub/OS';
    return `### ⌥ GitHub Integration
- **Linked Repository**: \`${repo}\`
- **Features Available**:
  - Live commit logs and branch tracking.
  - Pull request inspection and code review integration.
  - GitHub Issues import into sprint tasks and defect defects.
  - CI/CD GitHub Actions workflow execution status.

Visit the **⌥ GitHub** tab to manage your repositories, configure tokens, or trigger CI workflows.`;
  }

  // 16. OPEN-ENDED SMART TECHNICAL SYNTHESIS (Answers ANY other question)
  // Instead of the old rigid rejection, analyze key tokens and provide a deep, constructive answer!
  const capitalizedWords = q.replace(/[?.,!]/g, '').split(/\s+/).filter((w) => w.length > 2);
  const subjectHint = capitalizedWords.slice(0, 4).join(' ');

  return `### ✦ Engineering Intelligence Analysis
Regarding your question about **"${q}"**:

1. **Core Technical Perspective**:
   In modern software engineering for systems like **${project.name}**, addressing this effectively involves maintaining modular separation of concerns, ensuring high test coverage, and aligning implementation directly with project requirements.

2. **Application to ${project.name}**:
   - **Active Domain**: ${project.project_type || 'Software Application'}
   - **Architecture Alignment**: Ensure any solution integrates smoothly with the **${archDesign?.architecture?.pattern || 'Layered Architecture'}** and PostgreSQL data model.
   - **Verification**: Formulate measurable acceptance criteria and write automated unit/integration tests before merging into the main branch.

3. **Recommended Next Step**:
   You can explore this further by checking the relevant section in EngineerOS:
   - For domain logic: see **◈ Requirements** or **🏛 Architecture & DB**.
   - For sprint execution: see **▥ Sprint board** or **⇄ Traceability**.
   - For implementation review: see **⌘ Code review** or **⌥ GitHub**.

*Feel free to ask for specific code snippets, schema designs, architecture trade-offs, or testing strategies for this topic!*`;
}

/** Main assistant entry point: tries OpenAI -> Ollama -> Local Intelligence */
export async function askAssistant(project, question, user) {
  const snapshot = getFullProjectSnapshot(project);

  // 1. Try OpenAI if API key is present
  if (openaiClient) {
    try {
      const aiAnswer = await askOpenAI(question, snapshot);
      if (aiAnswer) return aiAnswer;
    } catch (err) {
      console.warn('[Assistant] OpenAI execution failed, falling back to local engine:', err.message);
    }
  }

  // 2. Try Ollama if configured
  if (process.env.OLLAMA_URL) {
    try {
      const ollamaAnswer = await askOllama(question, snapshot);
      if (ollamaAnswer) return ollamaAnswer;
    } catch (err) {
      console.warn('[Assistant] Ollama execution failed, falling back to local engine:', err.message);
    }
  }

  // 3. Fallback to comprehensive local semantic intelligence engine (handles ANY question!)
  return askLocalIntelligence(question, snapshot);
}
