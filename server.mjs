import dotenv from "dotenv";
import express from "express";
import { validationResult } from "express-validator";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import winston from "winston";
import cors from "cors";
import { create } from "ipfs";
import OrbitDB from "orbit-db";

dotenv.config();

// configure logging
const logger = winston.createLogger({
    level: "info",
    format: winston.format.json(),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple(),
        }),
    ],
});

// configure the GitHub API client
const appId = process.env.GITHUB_APP_ID;
const privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/gm, "\n");
const octokitBase = new Octokit({
    authStrategy: createAppAuth,
    auth: {
        appId,
        privateKey,
    },
});

const app = express();
app.use(express.json());
app.use(cors());

app.put("/nodes", async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(422).json({ errors: errors.array() });
        }

        // get the content from the request
        const { files, github, message } = req.body;
        const { owner, repo, installationId } = github;

        // authenticate as the installed GitNodes Agent app
        const auth = await octokitBase.auth({ type: "installation", installationId });
        const octokit = new Octokit({ auth: auth.token });

        // get the default branch for the repository
        const { data: repoInfo } = await octokit.repos.get({ owner, repo });
        const defaultBranch = repoInfo.default_branch;

        // create a new branch
        const branchName = `update-gitnodes-${Date.now()}`;
        const { data: ref } = await octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${defaultBranch}`,
        });
        await octokit.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${branchName}`,
            sha: ref.object.sha,
        });

        for (const fileToUpdate of files) {
            const { path, content } = fileToUpdate;

            // Get the existing file
            const { data: file } = await octokit.repos.getContent({
                owner,
                repo,
                path,
                ref: branchName,
            });

            // Update the file with new content
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path,
                message: `Update ${path}`,
                content: Buffer.from(JSON.stringify(content, null, 4)).toString("base64"),
                sha: file.sha,
                branch: branchName,
            });
        }

        // create a pull request
        await octokit.pulls.create({
            owner,
            repo,
            title: message,
            head: branchName,
            base: defaultBranch,
        });

        res.status(200).json({ message: "Pull request created." });
    } catch (error) {
        logger.error(`Error updating gitnodes.json: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
});
