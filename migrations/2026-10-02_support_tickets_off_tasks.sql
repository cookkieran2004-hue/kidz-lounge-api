-- Support tickets no longer create tasks (they live in the Support tickets
-- menu instead). Closes any tasks that earlier tickets put in KJC135's
-- bell. Optional; safe to run more than once.
UPDATE "Tasks" SET status = 'done', completed_at = COALESCE(completed_at, now())
  WHERE assigned_to = 'KJC135' AND assigned_by = 'system'
    AND title LIKE 'Support ticket #%' AND status <> 'done';
