import type { ProjectConfig, TicketInfo } from './types.js';

export function branchName(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return `claude/${identifier.toLowerCase()}${slug ? `-${slug}` : ''}`;
}

function gitFlowInstructions(project: ProjectConfig, branch: string): string {
  switch (project.gitFlow) {
    case 'branch-pr':
      return [
        `1. Create and switch to a branch named exactly \`${branch}\` off \`${project.baseBranch}\`.`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push -u origin ${branch}\`.`,
        `5. Open a pull request with \`gh pr create\` targeting \`${project.baseBranch}\`; put the ticket ID in the PR title.`,
      ].join('\n');
    case 'branch-push':
      return [
        `1. Create and switch to a branch named exactly \`${branch}\` off \`${project.baseBranch}\`.`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push the branch: \`git push -u origin ${branch}\`. Do NOT open a pull request.`,
      ].join('\n');
    case 'main-push':
      return [
        `1. Work directly on \`${project.baseBranch}\`: make sure it is checked out and up to date (\`git pull origin ${project.baseBranch}\`).`,
        `2. Implement the task and make the project's tests pass.`,
        `3. Commit your work with clear messages.`,
        `4. Push: \`git push origin ${project.baseBranch}\`.`,
      ].join('\n');
  }
}

export function buildPrompt(ticket: TicketInfo, project: ProjectConfig, branch: string): string {
  const comments = ticket.comments.length
    ? ticket.comments.map((c) => `**${c.author}:** ${c.body}`).join('\n\n')
    : '_none_';

  return `You are working autonomously on a Linear ticket in this repository.

# Ticket ${ticket.identifier}: ${ticket.title}

## Description

${ticket.description || '_no description provided_'}

## Comments

${comments}

## Required workflow

${gitFlowInstructions(project, branch)}

## Rules

- You are unattended: do NOT ask questions. Make reasonable decisions and note them in commit messages.
- Run the project's existing test and lint commands before pushing; do not push failing work.
- If you cannot complete the task, do NOT push anything — explain the blocker in your final message and stop.
`;
}
