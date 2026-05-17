import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import worktreeExtension from "../dist/extensions/worktree.js";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			`Command failed: ${command} ${args.join(" ")}\n${result.stderr ?? result.stdout}`,
		);
	}
	return result.stdout ?? "";
}

function runResult(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", ...options });
}

function git(repo, args) {
	return run("git", ["-C", repo, ...args]);
}

function gitResult(repo, args) {
	return runResult("git", ["-C", repo, ...args]);
}

function createRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
	run("git", ["-c", "init.defaultBranch=main", "init", dir]);
	git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(dir, ["config", "user.email", "pi-worktree-test@example.com"]);
	git(dir, ["config", "user.name", "Pi Worktree Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "staged.txt"), "staged original\n");
	writeFileSync(join(dir, "unstaged.txt"), "unstaged original\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "initial"]);
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "feature.txt"), "feature branch only\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "feature commit"]);
	return dir;
}

function createMockPi(flags = {}) {
	const registeredFlags = new Map();
	const handlers = new Map();
	return {
		registeredFlags,
		handlers,
		exec(command, args, options) {
			const result = spawnSync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				timeout: options?.timeout,
			});
			return Promise.resolve({
				code: result.status ?? 1,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? String(result.error?.message ?? ""),
			});
		},
		registerFlag(name, flag) {
			registeredFlags.set(name, flag);
		},
		getFlag(name) {
			return flags[name] ?? registeredFlags.get(name)?.default;
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
}

function createMockContext() {
	const notifications = [];
	const statuses = [];
	return {
		notifications,
		statuses,
		hasUI: true,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(key, value) {
				statuses.push({ key, value });
			},
		},
	};
}

function findWorktreePath(repo) {
	const worktreeRoot = join(repo, ".pi", "worktrees");
	const resolvedWorktreeRoot = existsSync(worktreeRoot)
		? realpathSync(worktreeRoot)
		: null;
	return resolvedWorktreeRoot
		? git(repo, ["worktree", "list", "--porcelain"])
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => line.slice("worktree ".length))
				.find((path) => realpathSync(path).startsWith(resolvedWorktreeRoot))
		: undefined;
}

async function startSessionResult(repo, flags) {
	const previousCwd = process.cwd();
	process.chdir(repo);
	try {
		const pi = createMockPi(flags);
		const ctx = createMockContext();
		worktreeExtension(pi);
		await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
		return {
			ctx,
			handlers: pi.handlers,
			notifications: ctx.notifications,
			statuses: ctx.statuses,
			wtPath: findWorktreePath(repo),
		};
	} finally {
		process.chdir(previousCwd);
	}
}

async function startWorktree(repo, flags) {
	return (await startSessionResult(repo, flags)).wtPath;
}

function installTerminal(input) {
	const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
	const originalStderr = Object.getOwnPropertyDescriptor(process, "stderr");
	const stdin = Readable.from(input);
	let output = "";

	Object.defineProperties(stdin, {
		isTTY: { value: true },
		isRaw: { value: false, writable: true },
		setRawMode: { value: () => stdin },
	});

	const stderr = new Writable({
		write(chunk, _encoding, callback) {
			output += chunk.toString();
			callback();
		},
	});
	Object.defineProperty(stderr, "isTTY", { value: true });

	Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
	Object.defineProperty(process, "stderr", { configurable: true, value: stderr });

	return {
		output: () => output,
		restore() {
			Object.defineProperty(process, "stdin", originalStdin);
			Object.defineProperty(process, "stderr", originalStderr);
		},
	};
}

test("registers configurable worktree base and dirty-copy flags", () => {
	const pi = createMockPi();
	worktreeExtension(pi);

	const baseFlag = pi.registeredFlags.get("worktree-base");
	assert.ok(baseFlag);
	assert.equal(baseFlag.type, "string");
	assert.equal(baseFlag.default, "default");
	assert.match(baseFlag.description, /Base ref/);

	const dirtyFlag = pi.registeredFlags.get("worktree-include-dirty");
	assert.ok(dirtyFlag);
	assert.equal(dirtyFlag.type, "boolean");
	assert.equal(dirtyFlag.default, false);
	assert.match(dirtyFlag.description, /staged and unstaged changes/);
});

test("removes a clean worktree without confirmation", async () => {
	const repo = createRepo();
	const terminal = installTerminal("n\n");
	try {
		const session = await startSessionResult(repo, { worktree: true });
		assert.ok(session.wtPath, "expected a worktree to be created");

		await session.handlers.get("session_shutdown")({ reason: "quit" }, session.ctx);

		assert.equal(existsSync(session.wtPath), false);
		assert.match(terminal.output(), /Cleaning up worktree \(no pending changes\)…/);
		assert.doesNotMatch(terminal.output(), /Delete worktree\?/);
	} finally {
		terminal.restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

test("still prompts before deleting a dirty worktree", async () => {
	const repo = createRepo();
	const terminal = installTerminal("n\n");
	try {
		const session = await startSessionResult(repo, { worktree: true });
		assert.ok(session.wtPath, "expected a worktree to be created");
		writeFileSync(join(session.wtPath, "changed.txt"), "dirty\n");

		await session.handlers.get("session_shutdown")({ reason: "quit" }, session.ctx);

		assert.equal(existsSync(session.wtPath), true);
		assert.match(terminal.output(), /Worktree has uncommitted changes\./);
		assert.match(terminal.output(), /Delete worktree\?/);
		assert.doesNotMatch(terminal.output(), /Cleaning up worktree/);
	} finally {
		terminal.restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-base current creates the temporary branch from the current branch", async () => {
	const repo = createRepo();
	try {
		git(repo, ["tag", "feature", "main"]);

		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "current",
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:feature.txt"]),
			"feature branch only\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("default worktree base keeps main-before-master compatibility", async () => {
	const repo = createRepo();
	try {
		const wtPath = await startWorktree(repo, { worktree: true });

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			gitResult(wtPath, ["cat-file", "-e", "HEAD:feature.txt"]).status,
			128,
		);
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:staged.txt"]),
			"staged original\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-base HEAD creates the temporary branch from the current commit", async () => {
	const repo = createRepo();
	try {
		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "HEAD",
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:feature.txt"]),
			"feature branch only\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-base accepts an arbitrary validated branch ref", async () => {
	const repo = createRepo();
	try {
		git(repo, ["checkout", "-q", "-b", "custom-base", "main"]);
		writeFileSync(join(repo, "custom.txt"), "custom base\n");
		git(repo, ["add", "custom.txt"]);
		git(repo, ["commit", "-m", "custom base"]);
		git(repo, ["checkout", "-q", "feature"]);

		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "custom-base",
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:custom.txt"]),
			"custom base\n",
		);
		assert.equal(
			gitResult(wtPath, ["cat-file", "-e", "HEAD:feature.txt"]).status,
			128,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("invalid --worktree-base reports an error without creating a worktree", async () => {
	const repo = createRepo();
	try {
		const result = await startSessionResult(repo, {
			worktree: true,
			"worktree-base": "missing-base-ref",
		});

		assert.equal(result.wtPath, undefined);
		assert.deepEqual(result.notifications, [
			{
				message: "Invalid worktree base ref: missing-base-ref",
				level: "error",
			},
		]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-base origin ref does not configure upstream tracking", async () => {
	const repo = createRepo();
	const remote = mkdtempSync(join(tmpdir(), "pi-worktree-remote-"));
	try {
		run("git", ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
		git(repo, ["remote", "add", "origin", remote]);
		git(repo, ["checkout", "-q", "-b", "remote-base", "main"]);
		writeFileSync(join(repo, "remote.txt"), "remote base\n");
		git(repo, ["add", "remote.txt"]);
		git(repo, ["commit", "-m", "remote base"]);
		git(repo, ["push", "-q", "origin", "remote-base"]);
		git(repo, ["fetch", "-q", "origin", "remote-base"]);
		git(repo, ["config", "branch.autoSetupMerge", "always"]);
		git(repo, ["checkout", "-q", "feature"]);

		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "origin/remote-base",
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:remote.txt"]),
			"remote base\n",
		);
		assert.notEqual(
			gitResult(wtPath, [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]).status,
			0,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test("--worktree-include-dirty carries staged and unstaged tracked changes into the worktree", async () => {
	const repo = createRepo();
	try {
		writeFileSync(join(repo, "staged.txt"), "staged dirty\n");
		git(repo, ["add", "staged.txt"]);
		writeFileSync(join(repo, "unstaged.txt"), "unstaged dirty\n");

		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "current",
			"worktree-include-dirty": true,
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.equal(
			run("git", ["-C", wtPath, "diff", "--cached", "--name-only"]),
			"staged.txt\n",
		);
		assert.equal(
			run("git", ["-C", wtPath, "diff", "--name-only"]),
			"unstaged.txt\n",
		);
		assert.equal(
			run("git", ["-C", wtPath, "show", ":staged.txt"]),
			"staged dirty\n",
		);
		assert.equal(
			run("git", ["-C", wtPath, "show", "HEAD:unstaged.txt"]),
			"unstaged original\n",
		);
		assert.equal(
			run("git", ["-C", wtPath, "show", ":unstaged.txt"]),
			"unstaged original\n",
		);
		const unstagedDiff = run("git", ["-C", wtPath, "diff", "--", "unstaged.txt"]);
		assert.match(unstagedDiff, /-unstaged original/);
		assert.match(unstagedDiff, /\+unstaged dirty/);
		assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "staged.txt\n");
		assert.equal(git(repo, ["diff", "--name-only"]), "unstaged.txt\n");
		assert.equal(git(repo, ["show", ":staged.txt"]), "staged dirty\n");
		assert.equal(
			git(repo, ["show", "HEAD:unstaged.txt"]),
			"unstaged original\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-include-dirty reports partial apply failures clearly", async () => {
	const repo = createRepo();
	try {
		writeFileSync(join(repo, "staged.txt"), "staged dirty\n");
		git(repo, ["add", "staged.txt"]);
		writeFileSync(join(repo, "feature.txt"), "feature branch dirty\n");

		const result = await startSessionResult(repo, {
			worktree: true,
			"worktree-base": "main",
			"worktree-include-dirty": true,
		});

		assert.ok(result.wtPath, "expected the created worktree to be kept");
		assert.equal(
			run("git", ["-C", result.wtPath, "show", ":staged.txt"]),
			"staged dirty\n",
		);
		assert.equal(
			gitResult(result.wtPath, ["cat-file", "-e", "HEAD:feature.txt"]).status,
			128,
		);
		const error = result.notifications.find(({ level }) => level === "error");
		assert.ok(error);
		assert.match(error.message, /failed to apply unstaged dirty changes/);
		assert.match(error.message, /Some staged changes may already be applied/);
		assert.match(error.message, /patch files were kept at/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("--worktree-include-dirty carries binary tracked changes", async () => {
	const repo = createRepo();
	try {
		writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		git(repo, ["add", "binary.bin"]);
		git(repo, ["commit", "-m", "add binary fixture"]);
		writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 255, 2, 3]));

		const wtPath = await startWorktree(repo, {
			worktree: true,
			"worktree-base": "current",
			"worktree-include-dirty": true,
		});

		assert.ok(wtPath, "expected a worktree to be created");
		assert.deepEqual(
			readFileSync(join(wtPath, "binary.bin")),
			Buffer.from([0, 255, 2, 3]),
		);
		assert.equal(git(wtPath, ["diff", "--name-only"]), "binary.bin\n");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
