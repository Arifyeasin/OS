import { Router } from 'express';
import { all, get, run, log } from '../db.js';
import { requireAuth } from '../auth.js';

export const router = Router();
router.use(requireAuth);

/**
 * Loads req.project for any route below /:pid and rejects non-members.
 * Mounted by the sub-routers so every project-scoped route is protected.
 */
export function loadProject(req, res, next) {
  const project = get('SELECT * FROM projects WHERE id = ?', Number(req.params.pid));
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const isMember = project.owner_id === req.user.id
    || get('SELECT 1 FROM members WHERE project_id = ? AND user_id = ?', project.id, req.user.id)
    || req.user.role === 'ADMIN';
  if (!isMember) return res.status(403).json({ error: 'You are not a member of this project.' });

  req.project = project;
  next();
}

// Projects the user owns or belongs to (admins see everything).
router.get('/', (req, res) => {
  const rows = req.user.role === 'ADMIN'
    ? all('SELECT * FROM projects ORDER BY created_at DESC')
    : all(`SELECT DISTINCT p.* FROM projects p
           LEFT JOIN members m ON m.project_id = p.id
           WHERE p.owner_id = ? OR m.user_id = ?
           ORDER BY p.created_at DESC`, req.user.id, req.user.id);

  res.json(rows.map((p) => ({
    ...p,
    counts: {
      requirements: get('SELECT COUNT(*) c FROM requirements WHERE project_id = ?', p.id).c,
      tasks: get('SELECT COUNT(*) c FROM tasks WHERE project_id = ?', p.id).c,
      openBugs: get("SELECT COUNT(*) c FROM bugs WHERE project_id = ? AND status != 'resolved'", p.id).c,
    },
  })));
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Project name must be at least 2 characters.' });
  if (description.length < 20) return res.status(400).json({ error: 'Project description must be at least 20 characters.' });

  const rawRepo = String(req.body.github_repo || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '');
  const githubToken = String(req.body.github_token || '').trim();

  const { lastInsertRowid } = run(
    'INSERT INTO projects (name, description, project_type, github_repo, github_token, owner_id) VALUES (?, ?, ?, ?, ?, ?)',
    name, description, String(req.body.project_type || '').trim(), rawRepo, githubToken, req.user.id
  );
  run('INSERT INTO members (project_id, user_id, role) VALUES (?, ?, ?)', lastInsertRowid, req.user.id, req.user.role);
  run('INSERT INTO sprints (project_id, name) VALUES (?, ?)', lastInsertRowid, 'Sprint 1');
  log(lastInsertRowid, req.user.id, `created the project "${name}"`);

  res.status(201).json(get('SELECT * FROM projects WHERE id = ?', lastInsertRowid));
});

router.get('/:pid', loadProject, (req, res) => {
  res.json({
    ...req.project,
    members: all(`SELECT u.id, u.name, u.email, u.github_username, u.avatar_url, m.role FROM members m
                  JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`, req.project.id),
    sprints: all('SELECT * FROM sprints WHERE project_id = ? ORDER BY id', req.project.id),
    activity: all(`SELECT a.message, a.created_at, u.name AS user FROM activity a
                   LEFT JOIN users u ON u.id = a.user_id
                   WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 20`, req.project.id),
  });
});

router.patch('/:pid', loadProject, (req, res) => {
  if (req.project.owner_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only the project owner can edit this project.' });
  }
  const description = String(req.body.description ?? req.project.description).trim();
  if (description.length < 20) return res.status(400).json({ error: 'Project description must be at least 20 characters.' });
  const githubRepo = req.body.github_repo !== undefined
    ? String(req.body.github_repo).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
    : req.project.github_repo;
  const githubToken = req.body.github_token !== undefined
    ? String(req.body.github_token).trim()
    : req.project.github_token;

  run('UPDATE projects SET name = ?, description = ?, project_type = ?, github_repo = ?, github_token = ? WHERE id = ?',
    String(req.body.name ?? req.project.name).trim(),
    description,
    String(req.body.project_type ?? req.project.project_type ?? '').trim(),
    githubRepo,
    githubToken,
    req.project.id);
  res.json(get('SELECT * FROM projects WHERE id = ?', req.project.id));
});

router.delete('/:pid', loadProject, (req, res) => {
  if (req.project.owner_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only the project owner can delete this project.' });
  }
  run('DELETE FROM projects WHERE id = ?', req.project.id);
  res.json({ ok: true });
});

// Add an existing user to the project team.
router.post('/:pid/members', loadProject, (req, res) => {
  const member = get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', req.project.id, req.user.id);
  if (req.project.owner_id !== req.user.id && req.user.role !== 'ADMIN' && member?.role !== 'PM') {
    return res.status(403).json({ error: 'Only project managers can manage members.' });
  }
  const user = get('SELECT id, name, role FROM users WHERE email = ?', String(req.body.email || '').trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account exists with that email.' });

  run('INSERT OR IGNORE INTO members (project_id, user_id, role) VALUES (?, ?, ?)',
    req.project.id, user.id, req.body.role || user.role);
  log(req.project.id, req.user.id, `added ${user.name} to the team`);
  res.status(201).json({ ok: true });
});

router.delete('/:pid/members/:uid', loadProject, (req, res) => {
  const member = get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', req.project.id, req.user.id);
  if (req.project.owner_id !== req.user.id && req.user.role !== 'ADMIN' && member?.role !== 'PM') {
    return res.status(403).json({ error: 'Only project managers can manage members.' });
  }
  run('DELETE FROM members WHERE project_id = ? AND user_id = ?', req.project.id, Number(req.params.uid));
  res.json({ ok: true });
});
