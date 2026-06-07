import type { ProjectConfig, TicketInfo } from './types.js';

export function branchName(identifier: string, title: string): string {
  // Linear identifiers look like "KIB-12", but sanitize defensively so the
  // result is always a valid git ref component.
  const id = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return `claude/${id}${slug ? `-${slug}` : ''}`;
}

function gitFlowInstructions(project: ProjectConfig, branch: string): string {
  switch (project.gitFlow) {
    case 'branch-pr':
      return [
        `1. You are already on the tip of \`${project.baseBranch}\`. Create and switch to a branch named exactly \`${branch}\`: \`git checkout -b ${branch}\`.`,
        `2. Implement the task and make the project's tests pass (install dependencies first if the project needs them). If the comments contain verifier findings from a previous attempt, fixing those findings is the priority.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push --force-with-lease -u origin ${branch}\` (origin may hold a previous attempt; force-with-lease replaces it safely).`,
        `5. Open a pull request with \`gh pr create\` targeting \`${project.baseBranch}\`; put the ticket ID in the PR title. If a PR for this branch already exists, do NOT create another — your push already updated it.`,
      ].join('\n');
    case 'branch-push':
      return [
        `1. You are already on the tip of \`${project.baseBranch}\`. Create and switch to a branch named exactly \`${branch}\`: \`git checkout -b ${branch}\`.`,
        `2. Implement the task and make the project's tests pass (install dependencies first if the project needs them). If the comments contain verifier findings from a previous attempt, fixing those findings is the priority.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push --force-with-lease -u origin ${branch}\` (origin may hold a previous attempt; force-with-lease replaces it safely). Do NOT open a pull request.`,
      ].join('\n');
    case 'main-push':
      return [
        `1. You are on a detached checkout of the tip of \`${project.baseBranch}\` — do not switch branches.`,
        `2. Implement the task and make the project's tests pass (install dependencies first if the project needs them).`,
        `3. Commit your work with clear messages.`,
        `4. Push: \`git push origin HEAD:${project.baseBranch}\`.`,
      ].join('\n');
  }
}

const MAX_PROJECT_CONTEXT_CHARS = 4_000;

function projectContextSection(ticket: TicketInfo): string {
  const description = ticket.projectDescription?.trim();
  if (!description) return '';
  const body =
    description.length > MAX_PROJECT_CONTEXT_CHARS
      ? `${description.slice(0, MAX_PROJECT_CONTEXT_CHARS)}\n\n_(truncated)_`
      : description;
  return `

## Project context (from the Linear project "${ticket.projectName}")

${body}`;
}

function ticketSection(ticket: TicketInfo): string {
  const comments = ticket.comments.length
    ? ticket.comments.map((c) => `**${c.author}:** ${c.body}`).join('\n\n')
    : '_none_';

  return `# Ticket ${ticket.identifier}: ${ticket.title}

## Description

${ticket.description || '_no description provided_'}

## Comments

${comments}${projectContextSection(ticket)}`;
}

function imagesSection(imagePaths: string[]): string {
  if (imagePaths.length === 0) return '';
  return `
## Attached images

The ticket includes ${imagePaths.length} image(s), already downloaded locally.
View each one with the Read tool BEFORE starting — they are part of the requirements:

${imagePaths.map((p) => `- ${p}`).join('\n')}
`;
}

export function buildPrompt(
  ticket: TicketInfo,
  project: ProjectConfig,
  branch: string,
  imagePaths: string[] = [],
): string {
  return `You are working autonomously on a Linear ticket.

You are in a TEMPORARY, DISPOSABLE workspace (a git worktree created for this
ticket). The user's main checkout lives elsewhere — this directory will be
deleted after you finish, so anything you don't push is lost.

${ticketSection(ticket)}
${imagesSection(imagePaths)}

## Required workflow

${gitFlowInstructions(project, branch)}

## Rules

- You are unattended: do NOT ask questions. Make reasonable decisions and note them in commit messages.
- Run the project's existing test and lint commands before pushing; do not push failing work.
- If you cannot complete the task, do NOT push anything — explain the blocker in your final message and stop.
`;
}

export function buildVerifyPrompt(
  ticket: TicketInfo,
  ref: string,
  imagePaths: string[] = [],
  onBase = false,
): string {
  const workspaceNote = onBase
    ? `You are in a TEMPORARY, DISPOSABLE verification workspace (a git worktree
checked out at the tip of \`${ref}\`). This ticket has no PR branch — its work
is expected to ALREADY be merged into \`${ref}\`. If the required behavior is
absent there, that is a FAIL.`
    : `You are in a TEMPORARY, DISPOSABLE verification workspace (a git worktree
already checked out at \`${ref}\`, the branch containing the work). The
user's main checkout lives elsewhere — this directory will be deleted after
you finish.`;

  return `You are verifying completed work for a Linear ticket.

${workspaceNote}

${ticketSection(ticket)}
${imagesSection(imagePaths)}

## Required workflow

1. Install dependencies if the project needs them to run (npm/pnpm/yarn install).
2. Use the /verify skill: run the app locally and verify IN THE BROWSER that every
   requirement of this ticket actually works. Exercise the real behavior — reading
   the code is not verification.
3. Shut down any app/server processes you started.
4. End your final message with exactly one verdict line:
   - \`VERDICT: PASS\` — only if you observed every requirement working
   - \`VERDICT: FAIL — <short reason>\` — otherwise

## Rules

- You are unattended: do NOT ask questions.
- This is a read-only review: do NOT commit, push, or change the ticket's code.
  (Throwaway local edits needed to run the app, e.g. an .env file, are fine.)
- Be skeptical: anything you could not actually observe working is a FAIL, not a PASS.
`;
}
