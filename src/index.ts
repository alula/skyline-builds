import dotenv from "dotenv";
import express from "express";
import fs from "fs/promises";
import { existsSync } from "fs";
import { Octokit } from "octokit";
import JSZip from "jszip";

dotenv.config();

const owner = "skyline-emu";
const repo = "skyline";

interface RunMetadata {
	id: number;
	branch: string;
	commit: {
		id: string;
		message: string;
	};
	runNumber: number;
}

(async () => {
	await fs.mkdir("./cache", { recursive: true });

	const octokit = new Octokit({
		auth: process.env.GITHUB_TOKEN,
	});
	const downloadLocks: Set<number> = new Set();
	let metadataCache: RunMetadata[] = [];

	async function downloadArtifact(metadata: RunMetadata) {
		const runId = metadata.id;
		if (downloadLocks.has(runId)) return;

		if (existsSync(`./cache/${runId}/metadata.json`)) {
			console.log(`${runId} already downloaded`);
			return;
		}

		try {
			downloadLocks.add(runId);
			console.log(`Downloading ${runId}`);
			await fs.mkdir(`./cache/${runId}`, { recursive: true });

			const resp2 = await octokit.rest.actions.listWorkflowRunArtifacts({
				owner,
				repo,
				run_id: runId,
			});

			// console.log(resp2.data.artifacts);

			const download = async (name: string) => {
				const art = resp2.data.artifacts.find((a) => a.name === name);
				if (!art) {
					console.error(`${name} not found`);
					return;
				}

				const resp = await octokit.request("GET /repos/:owner/:repo/actions/artifacts/:artifact_id/zip", {
					owner,
					repo,
					artifact_id: art.id,
				});

				const zip = await JSZip.loadAsync(resp.data as ArrayBuffer);
				const file = zip.file(name);
				if (!file) throw new Error(`${name} not found in zip.`);

				const data = await file.async("nodebuffer");
				await fs.writeFile(`./cache/${runId}/${name}`, data);
			};

			await download("app-release.apk");
			await fs.writeFile(`./cache/${runId}/metadata.json`, JSON.stringify(metadata));
		} catch (e) {
			console.error(e);
		} finally {
			downloadLocks.delete(runId);
		}
	}

	async function fetchArtifacts() {
		try {
			const newCache: RunMetadata[] = [];

			const list = await fs.readdir("./cache", { withFileTypes: true });
			for (const file of list) {
				if (!file.isDirectory()) continue;
				if (!existsSync(`./cache/${file.name}/metadata.json`)) continue;
				if (!existsSync(`./cache/${file.name}/app-release.apk`)) continue;

				const meta = JSON.parse(await fs.readFile(`./cache/${file.name}/metadata.json`, "utf8")) as RunMetadata;
				newCache.push(meta);
			}

			// sort by run number, decreasing
			newCache.sort((a, b) => b.runNumber - a.runNumber);
			console.log(newCache);
			metadataCache = newCache;
		} catch (e) {
			console.error(e);
		}

		const resp = await octokit.rest.actions.listWorkflowRunsForRepo({
			owner,
			repo,
		});
		const runs = resp.data.workflow_runs.filter(
			(run) =>
				run.head_repository.name === repo &&
				run.head_repository.owner.login === owner &&
				run.status === "completed"
		);
		for (const run of runs) {
			await downloadArtifact({
				id: run.id,
				branch: run.head_branch || run.head_sha,
				commit: {
					id: run.head_sha,
					message: run.head_commit?.message || "",
				},
				runNumber: run.run_number,
			});
		}
	}

	setInterval(fetchArtifacts, 90000);
	fetchArtifacts();

	const app = express();
	const port = process.env.PORT || 3333;

	app.get("/builds", (req, res) => {
		res.json(metadataCache);
	});

	app.use(
		"/cache",
		express.static("./cache", {
			immutable: true,
			extensions: ["apk", "json"],
			etag: true,
		})
	);

	app.use("/static", express.static("./static"));

	app.get("/", (req, res) => {
		res.sendFile("./index.html", { root: __dirname + "/.." });
	});

	app.listen(port, async () => {
		console.log(`App listening on http://localhost:${port}`);
	});
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
