import type { CancellationToken, TextDocument } from 'vscode';
import { MarkdownString } from 'vscode';
import type { EnrichedAutolink } from '../autolinks/models/autolinks';
import { DiffWithCommand } from '../commands/diffWith';
import { ShowQuickCommitCommand } from '../commands/showQuickCommit';
import { GlyphChars } from '../constants';
import type { Container } from '../container';
import { CommitFormatter } from '../git/formatters/commitFormatter';
import { GitUri } from '../git/gitUri';
import type { GitCommit } from '../git/models/commit';
import type { GitLineDiff, ParsedGitDiffHunk } from '../git/models/diff';
import type { PullRequest } from '../git/models/pullRequest';
import type { GitRemote } from '../git/models/remote';
import { deletedOrMissing, uncommittedStaged } from '../git/models/revision';
import type { RemoteProvider } from '../git/remotes/remoteProvider';
import { isUncommittedStaged, shortenRevision } from '../git/utils/revision.utils';
import { configuration } from '../system/-webview/configuration';
import { editorLineToDiffRange } from '../system/-webview/vscode/editors';
import { escapeMarkdownCodeBlocks } from '../system/markdown';
import { getSettledValue, pauseOnCancelOrTimeout, pauseOnCancelOrTimeoutMapTuplePromise } from '../system/promise';

export async function changesMessage(
	container: Container,
	commit: GitCommit,
	uri: GitUri,
	editorLine: number, // 0-based, Git is 1-based
	document: TextDocument,
): Promise<MarkdownString | undefined> {
	const documentRev = uri.sha;

	let previousSha = null;

	async function getDiff() {
		if (commit.file == null) return undefined;

		const line = editorLine + 1;
		const commitLine = commit.lines.find(l => l.line === line) ?? commit.lines[0];

		// TODO: Figure out how to optimize this
		let ref;
		if (commit.isUncommitted) {
			if (isUncommittedStaged(documentRev)) {
				ref = documentRev;
			}
		} else {
			previousSha = commitLine.previousSha;
			ref = previousSha;
			if (ref == null) {
				return `\`\`\`diff\n+ ${escapeMarkdownCodeBlocks(document.lineAt(editorLine).text)}\n\`\`\``;
			}
		}

		let originalPath = commit.file.originalPath;
		if (originalPath == null) {
			if (uri.fsPath !== commit.file.uri.fsPath) {
				originalPath = commit.file.path;
			}
		}

		editorLine = commitLine.line - 1;
		// TODO: Doesn't work with dirty files -- pass in editor? or contents?
		let lineDiff = await container.git.getDiffForLine(uri, editorLine, ref, documentRev);

		// If we didn't find a diff & ref is undefined (meaning uncommitted), check for a staged diff
		if (lineDiff == null && ref == null && documentRev !== uncommittedStaged) {
			lineDiff = await container.git.getDiffForLine(uri, editorLine, undefined, uncommittedStaged);
		}

		return lineDiff != null ? getDiffFromLine(lineDiff) : undefined;
	}

	const diff = await getDiff();
	if (diff == null) return undefined;

	const range = editorLineToDiffRange(editorLine);

	let message;
	let previous;
	let current;
	if (commit.isUncommitted) {
		const compareUris = await commit.getPreviousComparisonUrisForRange(range, documentRev);
		if (compareUris?.previous == null) return undefined;

		message = `[$(compare-changes)](${DiffWithCommand.createMarkdownCommandLink({
			lhs: { sha: compareUris.previous.sha ?? '', uri: compareUris.previous.documentUri() },
			rhs: { sha: compareUris.current.sha ?? '', uri: compareUris.current.documentUri() },
			repoPath: commit.repoPath,
			range: compareUris.range,
		})} "Open Changes")`;

		previous =
			compareUris.previous.sha == null || compareUris.previous.isUncommitted
				? `  &nbsp;_${shortenRevision(compareUris.previous.sha, {
						strings: { working: 'Working Tree' },
					})}_ &nbsp;${GlyphChars.ArrowLeftRightLong}&nbsp; `
				: `  &nbsp;[$(git-commit) ${shortenRevision(
						compareUris.previous.sha || '',
					)}](${ShowQuickCommitCommand.createMarkdownCommandLink(
						compareUris.previous.sha || '',
					)} "Show Commit") &nbsp;${GlyphChars.ArrowLeftRightLong}&nbsp; `;

		current =
			compareUris.current.sha == null || compareUris.current.isUncommitted
				? `_${shortenRevision(compareUris.current.sha, { strings: { working: 'Working Tree' } })}_`
				: `[$(git-commit) ${shortenRevision(
						compareUris.current.sha || '',
					)}](${ShowQuickCommitCommand.createMarkdownCommandLink(
						compareUris.current.sha || '',
					)} "Show Commit")`;
	} else {
		message = `[$(compare-changes)](${DiffWithCommand.createMarkdownCommandLink(commit, range)} "Open Changes")`;

		previousSha ??= await commit.getPreviousSha();
		if (previousSha && previousSha !== deletedOrMissing) {
			previous = `  &nbsp;[$(git-commit) ${shortenRevision(
				previousSha,
			)}](${ShowQuickCommitCommand.createMarkdownCommandLink(previousSha)} "Show Commit") &nbsp;${
				GlyphChars.ArrowLeftRightLong
			}&nbsp;`;
		}

		current = `[$(git-commit) ${commit.shortSha}](${ShowQuickCommitCommand.createMarkdownCommandLink(
			commit.sha,
		)} "Show Commit")`;
	}

	message = `${diff}\n---\n\nChanges${previous ?? ' added in '}${current} &nbsp;&nbsp;|&nbsp;&nbsp; ${message}`;

	const markdown = new MarkdownString(message, true);
	markdown.supportHtml = true;
	markdown.isTrusted = true;
	return markdown;
}

export async function localChangesMessage(
	fromCommit: GitCommit | undefined,
	uri: GitUri,
	editorLine: number, // 0-based, Git is 1-based
	hunk: ParsedGitDiffHunk,
): Promise<MarkdownString | undefined> {
	const diff = getDiffFromHunk(hunk);

	let message;
	let previous;
	let current;
	if (fromCommit == null) {
		previous = '_Working Tree_';
		current = '_Unsaved_';
	} else {
		const file = await fromCommit.findFile(uri);
		if (file == null) return undefined;

		message = `[$(compare-changes)](${DiffWithCommand.createMarkdownCommandLink({
			lhs: {
				sha: fromCommit.sha,
				uri: GitUri.fromFile(file, uri.repoPath!, undefined, true).toFileUri(),
			},
			rhs: { sha: '', uri: uri.toFileUri() },
			repoPath: uri.repoPath!,
			range: editorLineToDiffRange(editorLine),
		})} "Open Changes")`;

		previous = `[$(git-commit) ${fromCommit.shortSha}](${ShowQuickCommitCommand.createMarkdownCommandLink(
			fromCommit.sha,
		)} "Show Commit")`;

		current = '_Working Tree_';
	}
	message = `${diff}\n---\n\nLocal Changes  &nbsp;${previous} &nbsp;${
		GlyphChars.ArrowLeftRightLong
	}&nbsp; ${current}${message == null ? '' : ` &nbsp;&nbsp;|&nbsp;&nbsp; ${message}`}`;

	const markdown = new MarkdownString(message, true);
	markdown.supportHtml = true;
	markdown.isTrusted = true;
	return markdown;
}

export async function detailsMessage(
	container: Container,
	commit: GitCommit,
	uri: GitUri,
	editorLine: number, // 0-based, Git is 1-based
	options: Readonly<{
		autolinks?: boolean;
		cancellation?: CancellationToken;
		dateFormat: string | null;
		enrichedAutolinks?: Promise<Map<string, EnrichedAutolink> | undefined> | undefined;
		format: string;
		getBranchAndTagTips?: (
			sha: string,
			options?: { compact?: boolean | undefined; icons?: boolean | undefined },
		) => string | undefined;
		pullRequest?: Promise<PullRequest | undefined> | PullRequest | undefined;
		pullRequests?: boolean;
		remotes?: GitRemote<RemoteProvider>[];
		timeout?: number;
	}>,
): Promise<MarkdownString | undefined> {
	const remotesResult = await pauseOnCancelOrTimeout(
		options?.remotes ?? container.git.getRepositoryService(commit.repoPath).remotes.getBestRemotesWithProviders(),
		options?.cancellation,
		options?.timeout,
	);

	let remotes: GitRemote<RemoteProvider>[] | undefined;
	let remote: GitRemote<RemoteProvider> | undefined;
	if (remotesResult.paused) {
		if (remotesResult.reason === 'cancelled') return undefined;
		// If we timed out, just continue without the remotes
	} else {
		remotes = remotesResult.value;
		[remote] = remotes;
	}

	const cfg = configuration.get('hovers');
	const enhancedAutolinks =
		remote?.provider != null &&
		options?.autolinks !== false &&
		(options?.autolinks || cfg.autolinks.enabled) &&
		cfg.autolinks.enhanced &&
		CommitFormatter.has(cfg.detailsMarkdownFormat, 'message');
	const prs =
		remote?.supportsIntegration() &&
		remote.maybeIntegrationConnected !== false &&
		(options?.pullRequests || (options?.pullRequests !== false && cfg.pullRequests.enabled)) &&
		CommitFormatter.has(
			options.format,
			'pullRequest',
			'pullRequestAgo',
			'pullRequestAgoOrDate',
			'pullRequestDate',
			'pullRequestState',
		);

	const [enrichedAutolinksResult, prResult, presenceResult, previousLineComparisonUrisResult] =
		await Promise.allSettled([
			enhancedAutolinks
				? pauseOnCancelOrTimeoutMapTuplePromise(
						options?.enrichedAutolinks ?? commit.getEnrichedAutolinks(remote),
						options?.cancellation,
						options?.timeout,
					)
				: undefined,
			prs
				? pauseOnCancelOrTimeout(
						options?.pullRequest ?? commit.getAssociatedPullRequest(remote),
						options?.cancellation,
						options?.timeout,
					)
				: undefined,
			container.vsls.active
				? pauseOnCancelOrTimeout(
						container.vsls.getContactPresence(commit.author.email),
						options?.cancellation,
						Math.min(options?.timeout ?? 250, 250),
					)
				: undefined,
			commit.isUncommitted
				? commit.getPreviousComparisonUrisForRange(editorLineToDiffRange(editorLine), uri.sha)
				: undefined,
			commit.message == null ? commit.ensureFullDetails() : undefined,
		]);

	if (options?.cancellation?.isCancellationRequested) return undefined;

	const enrichedResult = getSettledValue(enrichedAutolinksResult);
	const pr = getSettledValue(prResult);
	const presence = getSettledValue(presenceResult);
	const previousLineComparisonUris = getSettledValue(previousLineComparisonUrisResult);

	const details = await CommitFormatter.fromTemplateAsync(options.format, commit, {
		aiEnabled: configuration.get('ai.enabled'),
		enrichedAutolinks: enrichedResult?.value != null && !enrichedResult.paused ? enrichedResult.value : undefined,
		dateFormat: options.dateFormat === null ? 'MMMM Do, YYYY h:mma' : options.dateFormat,
		editor: { line: editorLine, uri: uri },
		getBranchAndTagTips: options?.getBranchAndTagTips,
		messageAutolinks: options?.autolinks || (options?.autolinks !== false && cfg.autolinks.enabled),
		pullRequest: pr?.value,
		presence: presence?.value,
		previousLineComparisonUris: previousLineComparisonUris,
		outputFormat: 'markdown',
		remotes: remotes,
	});

	const markdown = new MarkdownString(details, true);
	markdown.supportHtml = true;
	markdown.isTrusted = true;
	return markdown;
}

function getDiffFromHunk(hunk: ParsedGitDiffHunk): string {
	return `\`\`\`diff\n${escapeMarkdownCodeBlocks(hunk.content.trim())}\n\`\`\``;
}

function getDiffFromLine(lineDiff: GitLineDiff, diffStyle?: 'line' | 'hunk'): string {
	if (diffStyle === 'hunk' || (diffStyle == null && configuration.get('hovers.changesDiff') === 'hunk')) {
		return getDiffFromHunk(lineDiff.hunk);
	}

	return `\`\`\`diff${
		lineDiff.line.previous == null ? '' : `\n- ${escapeMarkdownCodeBlocks(lineDiff.line.previous.trim())}`
	}${lineDiff.line.current == null ? '' : `\n+ ${escapeMarkdownCodeBlocks(lineDiff.line.current.trim())}`}\n\`\`\``;
}
