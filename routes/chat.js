const { json } = require('../lib/http');
const { displayNameFor } = require('../lib/utils');

// ---------- Chat (ephemeral direct/group messaging) ----------
// Minimal, non-admin-gated staff roster for starting chats -- deliberately
// separate from /auth/users (admin-only, full account management) since
// every staff member needs to see who they can message, not just admins.
async function handle({ path, method, body, db, currentUser }) {
  if (path === '/chat/directory' && method === 'GET') {
    const result = await db.query(
      `SELECT username, first_name, middle_name, last_name, preferred_name FROM "Staff" WHERE archived = false AND username != $1 ORDER BY username`,
      [currentUser.username]
    );
    const directory = result.rows.map(s => ({ username: s.username, display_name: displayNameFor(s) }));
    return json(200, directory);
  }

  if (path === '/chat/conversations' && method === 'GET') {
    const myConvos = await db.query(
      `SELECT c.id, c.type, c.name, c.created_by, c.created_at, cp.last_read_at
       FROM "ChatConversations" c
       JOIN "ChatParticipants" cp ON cp.conversation_id = c.id
       WHERE cp.username = $1 AND cp.hidden_at IS NULL`,
      [currentUser.username]
    );

    const conversations = [];
    for (const convo of myConvos.rows) {
      const participantsRes = await db.query('SELECT username FROM "ChatParticipants" WHERE conversation_id=$1', [convo.id]);
      const lastMsgRes = await db.query(
        'SELECT sender_username, text, created_at FROM "ChatMessages" WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1',
        [convo.id]
      );
      const unreadRes = await db.query(
        `SELECT COUNT(*)::int AS count FROM "ChatMessages"
         WHERE conversation_id=$1 AND sender_username != $2 AND ($3::timestamp IS NULL OR created_at > $3)`,
        [convo.id, currentUser.username, convo.last_read_at]
      );
      conversations.push({
        ...convo,
        participants: participantsRes.rows.map(r => r.username),
        last_message: lastMsgRes.rows[0] || null,
        unread_count: unreadRes.rows[0].count,
      });
    }

    conversations.sort((a, b) => {
      const aTime = a.last_message?.created_at || a.created_at;
      const bTime = b.last_message?.created_at || b.created_at;
      return new Date(bTime) - new Date(aTime);
    });
    return json(200, conversations);
  }

  if (path === '/chat/conversations' && method === 'POST') {
    const { type, name, participant_usernames } = body;
    if (!type || !['direct', 'group'].includes(type)) return json(400, { error: 'Conversation type must be direct or group.' });
    if (!Array.isArray(participant_usernames) || participant_usernames.length === 0) {
      return json(400, { error: 'At least one other participant is required.' });
    }
    if (type === 'direct' && participant_usernames.length !== 1) {
      return json(400, { error: 'A direct conversation must have exactly one other participant.' });
    }

    // Reuse an existing direct conversation between the same two people
    // instead of creating a duplicate thread every time.
    if (type === 'direct') {
      const existing = await db.query(
        `SELECT c.id FROM "ChatConversations" c
         JOIN "ChatParticipants" cp1 ON cp1.conversation_id = c.id AND cp1.username = $1
         JOIN "ChatParticipants" cp2 ON cp2.conversation_id = c.id AND cp2.username = $2
         WHERE c.type = 'direct'
         AND (SELECT COUNT(*) FROM "ChatParticipants" WHERE conversation_id = c.id) = 2`,
        [currentUser.username, participant_usernames[0]]
      );
      if (existing.rows[0]) {
        // Reusing a conversation the current user had previously hidden --
        // clear that so it actually reappears in their list, since they're
        // clearly engaging with it again.
        await db.query('UPDATE "ChatParticipants" SET hidden_at = NULL WHERE conversation_id=$1 AND username=$2', [existing.rows[0].id, currentUser.username]);
        const convo = await db.query('SELECT * FROM "ChatConversations" WHERE id=$1', [existing.rows[0].id]);
        return json(200, convo.rows[0]);
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const convoRes = await client.query(
        'INSERT INTO "ChatConversations" (type, name, created_by) VALUES ($1, $2, $3) RETURNING *',
        [type, name || null, currentUser.username]
      );
      const convoId = convoRes.rows[0].id;
      const allParticipants = [...new Set([currentUser.username, ...participant_usernames])];
      for (const username of allParticipants) {
        await client.query('INSERT INTO "ChatParticipants" (conversation_id, username) VALUES ($1, $2)', [convoId, username]);
      }
      await client.query('COMMIT');
      return json(201, convoRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (path.match(/^\/chat\/conversations\/[^/]+\/messages$/) && method === 'GET') {
    const convoId = path.split('/')[3];
    const participantCheck = await db.query('SELECT 1 FROM "ChatParticipants" WHERE conversation_id=$1 AND username=$2', [convoId, currentUser.username]);
    if (!participantCheck.rows[0]) return json(403, { error: 'You are not part of this conversation.' });

    const messages = await db.query('SELECT * FROM "ChatMessages" WHERE conversation_id=$1 ORDER BY created_at ASC', [convoId]);
    return json(200, messages.rows);
  }

  if (path.match(/^\/chat\/conversations\/[^/]+\/messages$/) && method === 'POST') {
    const convoId = path.split('/')[3];
    const participantCheck = await db.query('SELECT 1 FROM "ChatParticipants" WHERE conversation_id=$1 AND username=$2', [convoId, currentUser.username]);
    if (!participantCheck.rows[0]) return json(403, { error: 'You are not part of this conversation.' });

    const { text } = body;
    if (!text || !text.trim()) return json(400, { error: 'Message text is required.' });

    const result = await db.query(
      'INSERT INTO "ChatMessages" (conversation_id, sender_username, text) VALUES ($1, $2, $3) RETURNING *',
      [convoId, currentUser.username, text.trim()]
    );
    // A fresh message is a fresh reason to see the conversation again --
    // clears hidden_at for anyone (including the sender) who'd previously
    // hidden it, so it reappears rather than silently staying gone.
    await db.query('UPDATE "ChatParticipants" SET hidden_at = NULL WHERE conversation_id=$1', [convoId]);
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/chat\/conversations\/[^/]+\/participants$/) && method === 'POST') {
    const convoId = path.split('/')[3];
    const participantCheck = await db.query(
      `SELECT c.type FROM "ChatParticipants" cp JOIN "ChatConversations" c ON c.id = cp.conversation_id
       WHERE cp.conversation_id=$1 AND cp.username=$2`,
      [convoId, currentUser.username]
    );
    if (!participantCheck.rows[0]) return json(403, { error: 'You are not part of this conversation.' });
    if (participantCheck.rows[0].type !== 'group') return json(400, { error: 'Cannot add participants to a direct message.' });

    const { username } = body;
    if (!username) return json(400, { error: 'A username is required.' });
    try {
      await db.query('INSERT INTO "ChatParticipants" (conversation_id, username) VALUES ($1, $2)', [convoId, username]);
    } catch (err) {
      if (err.code === '23505') return json(409, { error: 'That person is already in this conversation.' });
      throw err;
    }
    return json(201, { added: true });
  }

  if (path.match(/^\/chat\/conversations\/[^/]+\/read$/) && method === 'PUT') {
    const convoId = path.split('/')[3];
    await db.query('UPDATE "ChatParticipants" SET last_read_at = now() WHERE conversation_id=$1 AND username=$2', [convoId, currentUser.username]);
    return json(200, { ok: true });
  }

  if (path.match(/^\/chat\/conversations\/[^/]+$/) && method === 'DELETE') {
    const convoId = path.split('/')[3];
    // Scoped to the current user's own username -- this can never affect
    // any other participant's access to the conversation. The underlying
    // conversation and its messages are completely untouched; this just
    // hides it from this one person's list.
    const result = await db.query(
      'UPDATE "ChatParticipants" SET hidden_at = now() WHERE conversation_id=$1 AND username=$2 RETURNING id',
      [convoId, currentUser.username]
    );
    if (!result.rows[0]) return json(403, { error: 'You are not part of this conversation.' });
    return json(200, { hidden: true });
  }

  return null;
}

module.exports = { handle };
