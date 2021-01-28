"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rest_1 = require("@octokit/rest");
const core_1 = require("@actions/core");
const github_1 = require("@actions/github");
const dateformat_1 = require("dateformat");
const axios_1 = require("axios");
const OWNER = github_1.context.payload.repository.owner.login;
const REPO = github_1.context.payload.repository.name;
const BRANCH = "master";
const TAG_NAME = core_1.getInput("tag-name");
const JIRA_INFO = Object.fromEntries([
    "cloud-instance-base-url",
    "client-id",
    "client-secret",
    "display-name",
    "description",
    "label",
    "environment-id",
    "environment-display-name",
    "environment-type"
].map(key => [key, core_1.getInput(key)]));
const token = process.env["GITHUB_TOKEN"];
const octokit = new rest_1.Octokit({
    auth: token
});
async function getCommitMessagesSinceLatestTag() {
    const result = await octokit.repos.compareCommits({
        owner: OWNER,
        repo: REPO,
        base: TAG_NAME,
        head: BRANCH
    });
    return result.data.commits.map(commit => commit.commit.message);
}
const jiraIssueNrPattern = /([A-Z]+-\d+)/;
function extractJiraIssuesFromTags(messages) {
    const result = new Set();
    for (const message of messages) {
        const match = jiraIssueNrPattern.exec(message);
        if (!match) {
            continue;
        }
        const [, issue] = match;
        result.add(issue);
    }
    return Array.from(result);
}
async function getJiraAccessToken() {
    const { data: { access_token } } = await axios_1.default.post("https://api.atlassian.com/oauth/token", {
        audience: "api.atlassian.com",
        grant_type: "client_credentials",
        client_id: JIRA_INFO["client-id"],
        client_secret: JIRA_INFO["client-secret"]
    });
    return access_token;
}
async function informJiraProductionDeployment(issueKeys) {
    const deployment = {
        issueKeys,
        schemaVersion: "1.0",
        deploymentSequenceNumber: process.env["GITHUB_RUN_ID"],
        updateSequenceNumber: process.env["GITHUB_RUN_ID"],
        displayName: JIRA_INFO["display-name"] || "",
        url: `${github_1.context.payload.repository.url}/actions/runs/${process.env["GITHUB_RUN_ID"]}`,
        description: JIRA_INFO.description || "",
        lastUpdated: dateformat_1.default(new Date(), "yyyy-mm-dd'T'HH:MM:ss'Z'") || "",
        label: JIRA_INFO.label || "",
        state: "successful",
        pipeline: {
            id: `${github_1.context.payload.repository.full_name} ${github_1.context.workflow}`,
            displayName: `Workflow: ${github_1.context.workflow} (#${process.env["GITHUB_RUN_NUMBER"]})`,
            url: `${github_1.context.payload.repository.url}/actions/runs/${process.env["GITHUB_RUN_ID"]}`
        },
        environment: {
            id: JIRA_INFO["environment-id"] || "",
            displayName: JIRA_INFO["display-name"] || "",
            type: JIRA_INFO["environment-type"] || ""
        }
    };
    const { data: { cloudId } } = await axios_1.default.get(`${JIRA_INFO["cloud-instance-base-url"]}/_edge/tenant_info`);
    const { data: { rejectedDeployments } } = await axios_1.default.post(`https://api.atlassian.com/jira/deployments/0.1/cloud/${cloudId}/bulk"`, deployment, {
        headers: {
            Authorization: `Bearer ${await getJiraAccessToken()}`
        }
    });
    if (rejectedDeployments && rejectedDeployments.length > 0) {
        const [rejectedDeployment] = rejectedDeployments;
        const message = rejectedDeployment.errors
            .map(error => error.message)
            .join(",");
        throw new Error(message);
    }
}
async function createTagForHead() {
    const { data: { sha } } = await octokit.repos.getCommit({
        ref: BRANCH,
        owner: "everweij",
        repo: "react-laag"
    });
    return octokit.git.createTag({
        owner: OWNER,
        repo: REPO,
        tag: TAG_NAME,
        message: "Deployment to production",
        object: sha,
        type: "commit"
    });
}
async function run() {
    let messages;
    try {
        messages = await getCommitMessagesSinceLatestTag();
    }
    catch (err) {
        core_1.setFailed(`An error occured while retreiving commit messages: ${String(err)}`);
        return;
    }
    const keys = extractJiraIssuesFromTags(messages);
    if (!keys.length) {
        core_1.warning("There are no issue keys found. Aborting...");
        return;
    }
    try {
        await informJiraProductionDeployment(keys);
    }
    catch (err) {
        core_1.setFailed(`An error occured while sending deployment info to Jira: ${String(err)}`);
        return;
    }
    try {
        await createTagForHead();
    }
    catch (err) {
        core_1.setFailed(`An error occured while tagging latest commit: ${String(err)}`);
        return;
    }
    console.log("Successfully informed Jira about production deployment for issue-keys: ");
    console.log(keys.join("\n"));
}
run();
