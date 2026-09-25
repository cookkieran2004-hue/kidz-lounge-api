const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { json } = require('../lib/http');
const { resolveProviderId } = require('../lib/utils');

const s3 = new S3Client({
  // If the Lambda can't reach S3 quickly (e.g. a networking issue), fail
  // fast rather than hanging until the Lambda's own timeout kills the
  // invocation -- a raw platform timeout has no CORS headers on it, which
  // the browser reports as a confusing "CORS blocked" error instead of the
  // real problem.
  requestHandler: { requestTimeout: 5000, connectionTimeout: 3000 },
  maxAttempts: 2,
});
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// ---------- Patient Documents (S3-backed, any staff can upload/delete) ----------
async function handle({ path, method, body, db, currentUser }) {
  if (path.match(/^\/patients\/[^/]+\/documents\/upload-url$/) && method === 'POST') {
    const patientId = path.split('/')[2];
    const { filename, content_type } = body;
    if (!filename) return json(400, { error: 'A filename is required.' });
    if (!S3_BUCKET_NAME) return json(500, { error: 'Document storage is not configured yet (S3_BUCKET_NAME missing).' });

    // Strip anything that isn't safe in an S3 key, and prefix with a
    // timestamp + random id so two uploads with the same original
    // filename never collide or overwrite each other.
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const s3Key = `patients/${patientId}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      ContentType: content_type || 'application/octet-stream',
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    return json(200, { uploadUrl, s3Key });
  }

  if (path.match(/^\/patients\/[^/]+\/documents$/) && method === 'POST') {
    const patientId = path.split('/')[2];
    const { filename, s3_key, content_type, file_size, document_type } = body;
    if (!filename || !s3_key) return json(400, { error: 'filename and s3_key are required.' });
    const result = await db.query(
      `INSERT INTO "PatientDocuments" (patient_id, filename, s3_key, content_type, file_size, uploaded_by, document_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [patientId, filename, s3_key, content_type || null, file_size || null, currentUser.username, document_type || null]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/patients\/[^/]+\/documents$/) && method === 'GET') {
    const patientId = path.split('/')[2];
    const result = await db.query('SELECT * FROM "PatientDocuments" WHERE patient_id=$1 ORDER BY uploaded_at DESC', [patientId]);
    return json(200, result.rows);
  }

  if (path.match(/^\/documents\/[^/]+\/download-url$/) && method === 'GET') {
    const docId = path.split('/')[2];
    const docRes = await db.query('SELECT * FROM "PatientDocuments" WHERE id=$1', [docId]);
    const doc = docRes.rows[0];
    if (!doc) return json(404, { error: 'Document not found.' });
    if (!S3_BUCKET_NAME) return json(500, { error: 'Document storage is not configured yet.' });

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: doc.s3_key,
      ResponseContentDisposition: `attachment; filename="${doc.filename.replace(/"/g, '')}"`,
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    return json(200, { downloadUrl, filename: doc.filename });
  }

  if (path.match(/^\/documents\/[^/]+$/) && method === 'DELETE') {
    const docId = path.split('/').pop();
    const docRes = await db.query('SELECT * FROM "PatientDocuments" WHERE id=$1', [docId]);
    const doc = docRes.rows[0];
    if (!doc) return json(404, { error: 'Document not found.' });

    if (S3_BUCKET_NAME) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_NAME, Key: doc.s3_key }));
      } catch (err) {
        // Don't leave an undeleteable "stuck" record behind just because
        // the S3 side failed -- remove the DB row regardless, but log it.
        console.error('Failed to delete S3 object:', err);
      }
    }
    await db.query('DELETE FROM "PatientDocuments" WHERE id=$1', [docId]);
    return json(200, { deleted: true });
  }

  // ---------- Clinical Documents (authored/signed notes, distinct from uploaded files) ----------
  if (path.match(/^\/patients\/[^/]+\/clinical-documents$/) && method === 'GET') {
    const patientId = path.split('/')[2];
    const result = await db.query(
      `SELECT cd.*,
              COALESCE(cp.first_name, cs.first_name, cs.preferred_name, cs.username) AS creator_first_name,
              COALESCE(cp.last_name, cs.last_name) AS creator_last_name,
              CASE WHEN cp.id IS NOT NULL THEN cp.credentials ELSE 'Staff' END AS creator_credentials,
              COALESCE(sp.first_name, ss.first_name, ss.preferred_name, ss.username) AS signer_first_name,
              COALESCE(sp.last_name, ss.last_name) AS signer_last_name,
              CASE WHEN sp.id IS NOT NULL THEN sp.credentials ELSE 'Staff' END AS signer_credentials
       FROM "ClinicalDocuments" cd
       LEFT JOIN "Providers" cp ON cp.id = cd.created_by_provider_id
       LEFT JOIN "Staff" cs ON cs.username = cd.created_by_username
       LEFT JOIN "Providers" sp ON sp.id = cd.signed_by_provider_id
       LEFT JOIN "Staff" ss ON ss.username = cd.signed_by_username
       WHERE cd.patient_id = $1
       ORDER BY cd.signed_at DESC NULLS LAST, cd.created_at DESC`,
      [patientId]
    );
    return json(200, result.rows);
  }

  if (path.match(/^\/patients\/[^/]+\/clinical-documents$/) && method === 'POST') {
    const patientId = path.split('/')[2];
    const { document_type, subject, body: docBody } = body;
    if (!subject || !subject.trim()) return json(400, { error: 'Subject is required before signing.' });
    if (!document_type) return json(400, { error: 'Document type is required.' });

    // Always signs as whoever is logged in. If they're linked to a
    // Provider record, that's captured too (for real credentials in the
    // signature); if not, the document is still fully valid -- the
    // signature just shows their name with "Staff" instead of credentials.
    const resolvedProviderId = await resolveProviderId(db, currentUser, null);

    const result = await db.query(
      `INSERT INTO "ClinicalDocuments"
         (patient_id, document_type, subject, body, status, created_by_provider_id, created_by_username, signed_by_provider_id, signed_by_username, signed_at)
       VALUES ($1, $2, $3, $4, 'Signed', $5, $6, $5, $6, now()) RETURNING *`,
      [patientId, document_type, subject.trim(), docBody || '', resolvedProviderId, currentUser.username]
    );
    return json(201, result.rows[0]);
  }

  if (path.match(/^\/clinical-documents\/[^/]+$/) && method === 'PUT') {
    const docId = path.split('/').pop();
    const { document_type, subject, body: docBody } = body;
    if (!subject || !subject.trim()) return json(400, { error: 'Subject is required before signing.' });

    const existingRes = await db.query('SELECT * FROM "ClinicalDocuments" WHERE id=$1', [docId]);
    if (!existingRes.rows[0]) return json(404, { error: 'Document not found.' });

    const resolvedProviderId = await resolveProviderId(db, currentUser, null);

    // Editing (and re-signing) updates the content and re-stamps who
    // signed it and when -- created_at and the original creator are left
    // untouched, and this is always an UPDATE, never a second row.
    const result = await db.query(
      `UPDATE "ClinicalDocuments" SET
         document_type = COALESCE($1, document_type),
         subject = $2,
         body = $3,
         signed_by_provider_id = $4,
         signed_by_username = $5,
         signed_at = now(),
         updated_at = now()
       WHERE id = $6 RETURNING *`,
      [document_type || null, subject.trim(), docBody || '', resolvedProviderId, currentUser.username, docId]
    );
    return json(200, result.rows[0]);
  }

  if (path.match(/^\/clinical-documents\/[^/]+$/) && method === 'DELETE') {
    const docId = path.split('/').pop();
    const result = await db.query('DELETE FROM "ClinicalDocuments" WHERE id=$1 RETURNING id', [docId]);
    if (!result.rows[0]) return json(404, { error: 'Document not found.' });
    return json(200, { deleted: true });
  }

  return null;
}

module.exports = { handle };
