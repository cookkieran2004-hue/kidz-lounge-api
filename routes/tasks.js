const { json } = require('../lib/http');
const { displayNameFor } = require('../lib/utils');

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path === '/tasks' && method === 'GET') {
    // Everyone can see their own tasks. An admin can look up someone
    // else's specifically via ?assigned_to=username.
    let assignedTo = currentUser.username;
    if (qs.assigned_to && currentUser.role === 'admin') {
      assignedTo = qs.assigned_to;
    }
    const result = await db.query(
      `SELECT t.*, ab.first_name AS assigned_by_first_name, ab.last_name AS assigned_by_last_name, ab.preferred_name AS assigned_by_preferred_name
       FROM "Tasks" t
       LEFT JOIN "Staff" ab ON ab.username = t.assigned_by
       WHERE t.assigned_to=$1 ORDER BY (t.status = 'done'), t.due_date NULLS LAST, t.created_at DESC`,
      [assignedTo]
    );
    return json(200, result.rows.map(r => ({ ...r, assigned_by_display: displayNameFor({ first_name: r.assigned_by_first_name, last_name: r.assigned_by_last_name, preferred_name: r.assigned_by_preferred_name, username: r.assigned_by }) })));
  }

  if (path === '/tasks/board' && method === 'GET') {
    // The admin to-do board: every task, across every staff member, so an
    // admin can see who has what and what's been completed.
    if (currentUser.role !== 'admin') return json(403, { error: 'Admin access required.' });
    const result = await db.query(
      `SELECT t.*,
              at.first_name AS assigned_to_first_name, at.last_name AS assigned_to_last_name, at.preferred_name AS assigned_to_preferred_name,
              ab.first_name AS assigned_by_first_name, ab.last_name AS assigned_by_last_name, ab.preferred_name AS assigned_by_preferred_name
       FROM "Tasks" t
       LEFT JOIN "Staff" at ON at.username = t.assigned_to
       LEFT JOIN "Staff" ab ON ab.username = t.assigned_by
       ORDER BY t.assigned_to, (t.status = 'done'), t.due_date NULLS LAST, t.created_at DESC`
    );
    return json(200, result.rows.map(r => ({
      ...r,
      assigned_to_display: displayNameFor({ first_name: r.assigned_to_first_name, last_name: r.assigned_to_last_name, preferred_name: r.assigned_to_preferred_name, username: r.assigned_to }),
      assigned_by_display: displayNameFor({ first_name: r.assigned_by_first_name, last_name: r.assigned_by_last_name, preferred_name: r.assigned_by_preferred_name, username: r.assigned_by }),
    })));
  }

  if (path === '/tasks' && method === 'POST') {
    const { title, description, assigned_to, due_date } = body;
    if (!title || !title.trim()) return json(400, { error: 'Title is required.' });
    if (!assigned_to || !assigned_to.trim()) return json(400, { error: 'A task must be assigned to someone.' });
    // Anyone can create a task for themselves; only an admin can assign a
    // task to someone else.
    if (assigned_to.trim() !== currentUser.username && currentUser.role !== 'admin') {
      return json(403, { error: 'Only an admin can assign a task to someone else.' });
    }
    const result = await db.query(
      `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, due_date, source)
       VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING *`,
      [title.trim(), description || null, assigned_to.trim(), currentUser.username, due_date || null]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/tasks\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT * FROM "Tasks" WHERE id=$1', [id]);
    const existingTask = existingRes.rows[0];
    if (!existingTask) return json(404, { error: 'Task not found.' });

    const { title, description, due_date, status, assigned_to } = body;
    const isAssignee = existingTask.assigned_to === currentUser.username;
    const isAssigner = existingTask.assigned_by === currentUser.username;
    const isAdmin = currentUser.role === 'admin';

    // Marking a task done/reopening it is just tracking progress, so the
    // assignee, the assigner, or an admin can all do that. Actually editing
    // what the task says (title/description/due date) or reassigning it is
    // a bigger action -- same permission as deleting it: admin or whoever
    // originally assigned it.
    const wantsContentChange = title !== undefined || description !== undefined || due_date !== undefined || assigned_to !== undefined;
    if (wantsContentChange) {
      if (!isAdmin && !isAssigner) {
        return json(403, { error: 'Only an admin or the person who assigned this task can edit it.' });
      }
    } else if (status !== undefined) {
      if (!isAssignee && !isAssigner && !isAdmin) {
        return json(403, { error: 'You do not have access to this task.' });
      }
    }

    if (assigned_to && assigned_to !== existingTask.assigned_to && !isAdmin) {
      return json(403, { error: 'Only an admin can reassign a task.' });
    }

    let completedAt = existingTask.completed_at;
    if (status === 'done' && existingTask.status !== 'done') completedAt = new Date();
    if (status === 'open') completedAt = null;

    const result = await db.query(
      `UPDATE "Tasks" SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         due_date = COALESCE($3, due_date),
         status = COALESCE($4, status),
         assigned_to = COALESCE($5, assigned_to),
         completed_at = $6
       WHERE id = $7 RETURNING *`,
      [title || null, description || null, due_date || null, status || null, assigned_to || null, completedAt, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/tasks\/[^/]+\/comments$/) && method === 'PUT') {
    const id = path.split('/')[2];
    const existingRes = await db.query('SELECT * FROM "Tasks" WHERE id=$1', [id]);
    const existingTask = existingRes.rows[0];
    if (!existingTask) return json(404, { error: 'Task not found.' });

    const isAssignee = existingTask.assigned_to === currentUser.username;
    const isAssigner = existingTask.assigned_by === currentUser.username;
    const isAdmin = currentUser.role === 'admin';
    if (!isAssignee && !isAssigner && !isAdmin) {
      return json(403, { error: 'You do not have access to this task.' });
    }

    // Comments are a JSON array (stored in the same TEXT column) so each
    // one has its own id/author/timestamp -- needed to support editing or
    // deleting a single comment rather than only appending to a blob.
    let commentsList = [];
    if (existingTask.comments) {
      try {
        commentsList = JSON.parse(existingTask.comments);
      } catch (err) {
        // Pre-existing flat-text comment from before this format existed --
        // preserve it as a single read-only legacy entry rather than losing it.
        commentsList = [{ id: 0, author_username: null, author_display: null, timestamp: existingTask.created_at, text: existingTask.comments, legacy: true }];
      }
    }

    const { action, text, commentId } = body;

    if (action === 'append') {
      if (!text || !text.trim()) return json(400, { error: 'Comment text is required.' });
      const nextId = commentsList.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1;
      commentsList.push({
        id: nextId,
        author_username: currentUser.username,
        author_display: displayNameFor({
          username: currentUser.username, first_name: currentUser.firstName,
          last_name: currentUser.lastName, preferred_name: currentUser.preferredName,
        }),
        timestamp: new Date().toISOString(),
        text: text.trim(),
      });
    } else if (action === 'edit') {
      const target = commentsList.find(c => c.id === commentId);
      if (!target) return json(404, { error: 'Comment not found.' });
      if (target.author_username !== currentUser.username) {
        return json(403, { error: 'You can only edit your own comments.' });
      }
      if (!text || !text.trim()) return json(400, { error: 'Comment text is required.' });
      target.text = text.trim();
      target.edited = true;
    } else if (action === 'delete') {
      if (!isAdmin) return json(403, { error: 'Only an admin can delete comments.' });
      commentsList = commentsList.filter(c => c.id !== commentId);
    } else {
      return json(400, { error: 'Unknown comment action.' });
    }

    const storedValue = commentsList.length > 0 ? JSON.stringify(commentsList) : null;
    const result = await db.query(
      'UPDATE "Tasks" SET comments=$1 WHERE id=$2 RETURNING *',
      [storedValue, id]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/tasks\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const existingRes = await db.query('SELECT * FROM "Tasks" WHERE id=$1', [id]);
    const existingTask = existingRes.rows[0];
    if (!existingTask) return json(404, { error: 'Task not found.' });

    const canDelete = currentUser.role === 'admin' || existingTask.assigned_by === currentUser.username;
    if (!canDelete) return json(403, { error: 'Only an admin or the person who assigned this task can remove it.' });

    await db.query('DELETE FROM "Tasks" WHERE id=$1', [id]);
    return json(200, { deleted: true });
  }

  return null;
}

module.exports = { handle };
