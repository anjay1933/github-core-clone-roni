// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server send:
// Query.viewer, Query.repository, Query.node, the issue/pull-request connections, the five
// mutations, and __type introspection. Unknown fields are reported as errors (HTTP 200 with
// an errors array), exactly as GitHub does; an unknown repository resolves to null with no
// errors. Global ids are opaque base64url strings, never plain database ids or numbers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from './githttp.ts';
import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length) {
        const c = input[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const esc = input[j + 1] as string;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
            value += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      // Shorthand query.
    } else {
      throw new Error(`unexpected token ${token.value} at operation start`);
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        variables.push({ name: varName, type: varType });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selectionSet = this.parseSelectionSet();
    return { type, name, variables, selectionSet };
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function coerceValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => coerceValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = coerceValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// global ids and cursors (opaque, stable, never plain numbers)
// ---------------------------------------------------------------------------

function encodeId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeId(id: string): string | null {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function repoGlobalId(repo: RepoRecord): string {
  return encodeId(`Repository:${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
  return encodeId(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
  return encodeId(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

function userGlobalId(login: string): string {
  return encodeId(`User:${login}`);
}

function encodeCursor(number: number): string {
  return encodeId(`cursor:${number}`);
}

function decodeCursor(cursor: string): number | null {
  const decoded = decodeId(cursor);
  if (decoded === null || !decoded.startsWith('cursor:')) return null;
  const number = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------------
// runtime values
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function userObject(login: string, id: number): GqlObject {
  return { __typename: 'User', login, databaseId: id, email: `${login}@example.invalid`, name: login, id: userGlobalId(login) };
}

function repoObject(repo: RepoRecord): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: RepoRecord, issue: IssueRecord): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: RepoRecord, pull: PullRecord): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function refObject(name: string, oid?: string): GqlObject {
  return { __typename: 'Ref', name, prefix: 'refs/heads/', oid: oid ?? '' };
}

// ---------------------------------------------------------------------------
// schema tables for __type
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'closed', 'closedAt', 'repository', 'viewerDidAuthor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'mergedAt', 'mergeCommit', 'repository', 'viewerDidAuthor'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'viewerHasStarred'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'PROJECT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

interface ExecContext {
  store: Store;
}

function findRepoByGlobalId(store: Store, globalId: string): RepoRecord | null {
  const decoded = decodeId(globalId);
  if (decoded === null || !decoded.startsWith('Repository:')) return null;
  const fullName = decoded.slice('Repository:'.length);
  const slash = fullName.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) ?? null;
}

function findIssueByGlobalId(store: Store, globalId: string): { repo: RepoRecord; issue: IssueRecord } | null {
  const decoded = decodeId(globalId);
  if (decoded === null || !decoded.startsWith('Issue:')) return null;
  const rest = decoded.slice('Issue:'.length);
  const colon = rest.lastIndexOf(':');
  if (colon < 0) return null;
  const fullName = rest.slice(0, colon);
  const number = Number.parseInt(rest.slice(colon + 1), 10);
  const slash = fullName.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (repo === undefined) return null;
  const issue = repo.issues.find((item) => item.number === number);
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, globalId: string): { repo: RepoRecord; pull: PullRecord } | null {
  const decoded = decodeId(globalId);
  if (decoded === null || !decoded.startsWith('PullRequest:')) return null;
  const rest = decoded.slice('PullRequest:'.length);
  const colon = rest.lastIndexOf(':');
  if (colon < 0) return null;
  const fullName = rest.slice(0, colon);
  const number = Number.parseInt(rest.slice(colon + 1), 10);
  const slash = fullName.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((item) => item.number === number);
  return pull === undefined ? null : { repo, pull };
}

function connectionKey(item: unknown): number {
  const record = item as { number?: number; id?: number };
  return record.number ?? record.id ?? 0;
}

function pageConnection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  order: 'asc' | 'desc',
): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let sorted = [...items];
  if (order === 'desc') sorted = sorted.reverse();
  if (after !== null) {
    sorted = sorted.filter((item) => {
      const n = connectionKey(item);
      return order === 'asc' ? n > after : n < after;
    });
  }
  const nodes = sorted.slice(0, Math.max(0, first));
  const hasNextPage = sorted.length > nodes.length;
  const last = nodes[nodes.length - 1];
  return { nodes, pageInfo: { hasNextPage, endCursor: last === undefined ? null : encodeCursor(connectionKey(last)) } };
}

function resolveField(ctx: ExecContext, typeName: string, source: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = coerceValue(value, variables);

  if (typeName === 'Query') {
    if (field.name === 'viewer') return userObject(VIEWER_LOGIN, VIEWER_ID);
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoObject(repo);
    }
    if (field.name === 'node') {
      const id = args.id as string;
      const decoded = decodeId(id);
      if (decoded === null) return null;
      if (decoded.startsWith('Repository:')) {
        const repo = findRepoByGlobalId(ctx.store, id);
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.startsWith('Issue:')) {
        const found = findIssueByGlobalId(ctx.store, id);
        return found === null ? null : issueObject(found.repo, found.issue);
      }
      if (decoded.startsWith('PullRequest:')) {
        const found = findPullByGlobalId(ctx.store, id);
        return found === null ? null : pullObject(found.repo, found.pull);
      }
      if (decoded.startsWith('User:')) {
        const login = decoded.slice('User:'.length);
        return userObject(login, login === VIEWER_LOGIN ? VIEWER_ID : 1000);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      const fields = TYPE_FIELDS[name];
      const enums = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enums === undefined) return null;
      return {
        __typename: '__Type',
        name,
        fields: fields === undefined ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
        enumValues: enums === undefined ? null : enums.map((value) => ({ __typename: '__EnumValue', name: value })),
      };
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' }, mutationType: { __typename: '__Type', name: 'Mutation' } };
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = args.input as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId as string);
      if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id.');
      const issue = ctx.store.createIssue(repo, input.title as string, (input.body as string) ?? '', []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    if (field.name === 'closeIssue') {
      const input = args.input as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.issueId as string);
      if (found === null) throw new GraphQLError('Could not resolve to an Issue with the global id.');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    if (field.name === 'createPullRequest') {
      const input = args.input as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId as string);
      if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id.');
      const headRef = input.headRefName as string;
      const baseRef = input.baseRefName as string;
      const headSha = ctx.store.branchCommit(repo, headRef);
      const baseSha = ctx.store.branchCommit(repo, baseRef);
      if (headSha === null || baseSha === null) throw new GraphQLError('Head or base ref does not exist.');
      const pull = ctx.store.createPull(repo, input.title as string, (input.body as string) ?? '', headRef, headSha, baseRef, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    if (field.name === 'mergePullRequest') {
      const input = args.input as Record<string, unknown>;
      const found = findPullByGlobalId(ctx.store, input.pullRequestId as string);
      if (found === null) throw new GraphQLError('Could not resolve to a PullRequest with the global id.');
      const sha = ctx.store.mergePull(found.repo, found.pull);
      if (sha === null) throw new GraphQLError('Pull request is not mergeable.');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    if (field.name === 'addComment') {
      const input = args.input as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.subjectId as string);
      if (found === null) throw new GraphQLError('Could not resolve to an Issue with the global id.');
      const comment = { id: ctx.store.nextCommentId, body: input.body as string };
      ctx.store.nextCommentId += 1;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: encodeId(`IssueComment:${comment.id}`), databaseId: comment.id, body: comment.body, author: userObject(VIEWER_LOGIN, VIEWER_ID) } },
        subject: issueObject(found.repo, found.issue),
        clientMutationId: (input.clientMutationId as string) ?? null,
      };
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (typeName === 'Repository') {
    const repo = source.repo as RepoRecord;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return userObject(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000);
      case 'defaultBranchRef': {
        const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return head === undefined ? null : refObject(repo.defaultBranch, head);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'isPrivate':
        return repo.isPrivate;
      case 'fork':
        return false;
      case 'viewerHasStarred':
        return false;
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((item) => item.number === number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states !== undefined) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        let order: 'asc' | 'desc' = 'asc';
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        if (orderBy !== undefined && orderBy.direction === 'DESC') order = 'desc';
        const connection = pageConnection(issues, args, order);
        return {
          __typename: 'IssueConnection',
          nodes: connection.nodes.map((issue) => issueObject(repo, issue)),
          totalCount: issues.length,
          pageInfo: { __typename: 'PageInfo', ...connection.pageInfo },
        };
      }
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((item) => item.number === number);
        return pull === undefined ? null : pullObject(repo, pull);
      }
      case 'pullRequests': {
        const connection = pageConnection([...repo.pulls], args, 'asc');
        return {
          __typename: 'PullRequestConnection',
          nodes: connection.nodes.map((pull) => pullObject(repo, pull)),
          totalCount: repo.pulls.length,
          pageInfo: { __typename: 'PageInfo', ...connection.pageInfo },
        };
      }
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`);
    }
  }

  if (typeName === 'Issue') {
    const repo = source.repo as RepoRecord;
    const issue = source.issue as IssueRecord;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'author':
        return userObject(VIEWER_LOGIN, VIEWER_ID);
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'closed':
        return issue.state === 'closed';
      case 'closedAt':
        return issue.state === 'closed' ? FIXED_ISO : null;
      case 'repository':
        return repoObject(repo);
      case 'viewerDidAuthor':
        return true;
      case 'comments': {
        const connection = pageConnection(issue.comments, args, 'asc');
        return {
          __typename: 'IssueCommentConnection',
          nodes: connection.nodes.map((comment) => ({
            __typename: 'IssueComment',
            id: encodeId(`IssueComment:${comment.id}`),
            databaseId: comment.id,
            body: comment.body,
            author: userObject(VIEWER_LOGIN, VIEWER_ID),
          })),
          totalCount: issue.comments.length,
          pageInfo: { __typename: 'PageInfo', ...connection.pageInfo },
        };
      }
      case 'labels':
        return {
          __typename: 'LabelConnection',
          nodes: issue.labels.map((labelName) => ({
            __typename: 'Label',
            id: encodeId(`Label:${repo.owner}/${repo.name}:${labelName}`),
            name: labelName,
            color: repo.labels.get(labelName)?.color ?? 'ededed',
          })),
        };
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "Issue".`);
    }
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as RepoRecord;
    const pull = source.pull as PullRecord;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return ctx.store.pullMergeable(repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return refObject(pull.headRef, pull.headSha);
      case 'baseRef':
        return refObject(pull.baseRef, pull.baseSha);
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'author':
        return userObject(VIEWER_LOGIN, VIEWER_ID);
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
      case 'repository':
        return repoObject(repo);
      case 'viewerDidAuthor':
        return true;
      case 'files': {
        const files = ctx.store.pullFiles(repo, pull);
        const connection = pageConnection(files.map((file, index) => ({ ...file, number: index + 1 })), args, 'asc');
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: connection.nodes.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status })),
          totalCount: files.length,
          pageInfo: { __typename: 'PageInfo', ...connection.pageInfo },
        };
      }
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
  }

  if (typeName === 'User') {
    switch (field.name) {
      case 'id':
        return source.id as string;
      case 'login':
        return source.login as string;
      case 'name':
        return source.name as string;
      case 'email':
        return source.email as string;
      case 'databaseId':
        return source.databaseId as number;
      case 'url':
        return `https://github.com/${source.login as string}`;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "User".`);
    }
  }

  if (typeName === 'Ref') {
    switch (field.name) {
      case 'name':
        return source.name as string;
      case 'prefix':
        return source.prefix as string;
      case 'target':
        return { __typename: 'Commit', oid: source.oid as string };
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "Ref".`);
    }
  }

  if (typeName === '__Type') {
    switch (field.name) {
      case 'name':
        return source.name as string;
      case 'fields':
        return source.fields as unknown;
      case 'enumValues':
        return source.enumValues as unknown;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "__Type".`);
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return source.name as string;
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'IssueCommentConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'LabelConnection') {
    switch (field.name) {
      case 'nodes':
        return source.nodes as unknown;
      case 'totalCount':
        return source.totalCount as number;
      case 'pageInfo':
        return source.pageInfo as unknown;
      case 'edges':
        return ((source.nodes as unknown[]) ?? []).map((node) => ({ __typename: 'Edge', node, cursor: '' }));
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
  }

  if (typeName === 'PageInfo') {
    switch (field.name) {
      case 'hasNextPage':
        return source.hasNextPage as boolean;
      case 'endCursor':
        return source.endCursor as string | null;
      case 'hasPreviousPage':
        return false;
      case 'startCursor':
        return null;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
  }

  if (typeName === 'Commit') {
    if (field.name === 'oid') return source.oid as string;
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Commit".`);
  }

  if (typeName === 'IssueComment') {
    switch (field.name) {
      case 'id':
        return source.id as string;
      case 'databaseId':
        return source.databaseId as number;
      case 'body':
        return source.body as string;
      case 'author':
        return source.author as unknown;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
  }

  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') return source.node as unknown;
    if (field.name === 'cursor') return '';
    throw new GraphQLError(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
  }

  if (typeName === 'Label') {
    switch (field.name) {
      case 'id':
        return source.id as string;
      case 'name':
        return source.name as string;
      case 'color':
        return source.color as string;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "Label".`);
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    switch (field.name) {
      case 'path':
        return source.path as string;
      case 'additions':
        return source.additions as number;
      case 'deletions':
        return source.deletions as number;
      case 'changeType':
        return source.changeType as string;
      default:
        throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
  }

  if (typeName.endsWith('Payload')) {
    const value = source[field.name];
    if (value !== undefined) return value;
    if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
  }

  throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

function executeSelectionSet(
  ctx: ExecContext,
  typeName: string,
  source: GqlObject,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selectionSet, variables));
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const value = resolveField(ctx, typeName, source, selection, variables);
    if (selection.selectionSet === null || value === null || value === undefined) {
      out[selection.alias] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[selection.alias] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in item) {
          return executeSelectionSet(ctx, (item as GqlObject).__typename, item as GqlObject, selection.selectionSet as SelectionNode[], variables);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const typed = value as GqlObject;
      out[selection.alias] = executeSelectionSet(ctx, typed.__typename, typed, selection.selectionSet, variables);
      continue;
    }
    out[selection.alias] = value;
  }
  return out;
}

function executeOperation(ctx: ExecContext, operation: OperationNode, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  try {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(ctx, rootType, { __typename: rootType }, operation.selectionSet, variables);
    return { data };
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { data: null, errors: [{ message: error.message }] };
    }
    throw error;
  }
}

export async function handleGraphQL(ctx: { store: Store; req: IncomingMessage; res: ServerResponse }): Promise<void> {
  const { store, req, res } = ctx;
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const execContext: ExecContext = { store };
  const runOne = (document: unknown): unknown => {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      return { data: null, errors: [{ message: 'Request body must be a JSON object with a query field.' }] };
    }
    const query = (document as Record<string, unknown>).query;
    const variables = (document as Record<string, unknown>).variables;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'Request must include a query string.' }] };
    }
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax error in query.' }] };
    }
    const operation = operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'Request includes no operation.' }] };
    }
    const vars = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    try {
      return executeOperation(execContext, operation, vars);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Internal error.' }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

export { VIEWER_EMAIL };
