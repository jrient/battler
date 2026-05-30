import { z } from "zod";
import {
  createIssue,
  listIssues,
  getIssue,
  addComment,
  listComments,
  type IssueRecord,
  type CommentRecord,
} from "../store.js";
import { requireSession } from "../auth.js";
import { jsonBodyLimit, safeJson, type AppType } from "./shared.js";

// Title (≤120) + body (≤5000 chars) plus JSON overhead; 32k is ample even for
// multibyte CJK content while still capping abusive payloads.
const ISSUE_BODY_LIMIT = 32 * 1024;

// ===== Issues (community feedback board) =====
// Reads are public; creating issues/comments requires a signed-in session.

const createIssueSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(1).max(5000),
});

const addCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

function issueView(i: IssueRecord) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    author: i.authorLogin,
    status: i.status,
    commentCount: i.commentCount,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function commentView(c: CommentRecord) {
  return {
    id: c.id,
    issueId: c.issueId,
    body: c.body,
    author: c.authorLogin,
    createdAt: c.createdAt,
  };
}

export function registerIssues(app: AppType): void {
  app.get("/api/issues", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    return c.json({ limit, offset, issues: listIssues(limit, offset).map(issueView) });
  });

  app.post("/api/issues", requireSession, jsonBodyLimit(ISSUE_BODY_LIMIT), async (c) => {
    const user = c.get("user");
    const parsed = createIssueSchema.safeParse((await safeJson(c)) ?? {});
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const issue = createIssue({
      title: parsed.data.title,
      body: parsed.data.body,
      authorLogin: user.githubLogin,
      authorId: user.id,
    });
    return c.json(issueView(issue), 201);
  });

  app.get("/api/issues/:id", (c) => {
    const issue = getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "not_found" }, 404);
    return c.json({ issue: issueView(issue), comments: listComments(issue.id).map(commentView) });
  });

  app.post("/api/issues/:id/comments", requireSession, jsonBodyLimit(ISSUE_BODY_LIMIT), async (c) => {
    const user = c.get("user");
    const parsed = addCommentSchema.safeParse((await safeJson(c)) ?? {});
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const comment = addComment({
      issueId: c.req.param("id"),
      body: parsed.data.body,
      authorLogin: user.githubLogin,
      authorId: user.id,
    });
    if (!comment) return c.json({ error: "not_found" }, 404);
    return c.json(commentView(comment), 201);
  });
}
